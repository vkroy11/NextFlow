import { NextResponse } from "next/server";
import { auth as clerkAuth } from "@clerk/nextjs/server";
import { auth as triggerAuth } from "@trigger.dev/sdk/v3";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * Mint a fresh `publicAccessToken` for an in-flight workflow run. Used by
 * the History sidebar when the original 2 h token from the run-launch
 * response is approaching expiry (or already expired) and the run hasn't
 * finished yet.
 *
 * Only authenticated users may request a token, and only for a workflow
 * they own. The token is scoped to the `wfrun:<id>` Trigger tag — the
 * same scope used by the launch endpoint.
 */
export async function GET(
  _: Request,
  ctx: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await ctx.params;
  const { userId } = await clerkAuth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const workflow = await prisma.workflow.findUnique({ where: { id } });
  if (!workflow || workflow.userId !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Run must belong to this workflow + this user.
  const workflowRun = await prisma.workflowRun.findUnique({ where: { id: runId } });
  if (!workflowRun || workflowRun.workflowId !== id || workflowRun.userId !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const realtimeTag = `wfrun:${workflowRun.id}`;

  try {
    const publicAccessToken = await triggerAuth.createPublicToken({
      scopes: { read: { tags: [realtimeTag] } },
      expirationTime: "2h",
    });
    return NextResponse.json({ publicAccessToken, realtimeTag });
  } catch (err) {
    const message = err instanceof Error ? err.message : "token mint failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
