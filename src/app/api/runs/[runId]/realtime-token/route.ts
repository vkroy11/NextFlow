import { NextResponse } from "next/server";
import { auth as clerkAuth } from "@clerk/nextjs/server";
import { auth as triggerAuth } from "@trigger.dev/sdk/v3";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * Mints a public access token scoped to a single workflow run's tag
 * (`wfrun:<id>`) so the browser can subscribe to its realtime runs +
 * streams without exposing the project's secret key.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const { userId } = await clerkAuth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const workflowRun = await prisma.workflowRun.findUnique({
    where: { id: runId },
    select: { id: true, userId: true },
  });
  if (!workflowRun || workflowRun.userId !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const token = await triggerAuth.createPublicToken({
    scopes: { read: { tags: [`wfrun:${runId}`] } },
    expirationTime: "2h",
  });

  return NextResponse.json({ token });
}
