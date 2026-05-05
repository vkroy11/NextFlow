import { NextResponse } from "next/server";
import { auth as clerkAuth } from "@clerk/nextjs/server";
import { auth as triggerAuth, tasks } from "@trigger.dev/sdk/v3";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { RunRequestSchema } from "@/lib/types";
import type { runWorkflowTask } from "@/trigger/runWorkflow";

export const runtime = "nodejs";

/**
 * Token lifetime for the Realtime subscription that powers the
 * HistorySidebar live updates. Active runs finish well within this — the
 * orchestrator's `maxDuration` is 600 s. If a run somehow lingers past
 * the expiry, the sidebar refreshes via the dedicated /token endpoint
 * (see `runs/[runId]/token/route.ts`).
 */
const REALTIME_TOKEN_EXPIRY = "2h";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { userId } = await clerkAuth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const workflow = await prisma.workflow.findUnique({ where: { id } });
  if (!workflow || workflow.userId !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = RunRequestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const { scope, targetNodeIds } = parsed.data;

  const workflowRun = await prisma.workflowRun.create({
    data: {
      workflowId: id,
      userId,
      scope,
      status: "QUEUED",
      targetNodeIds: targetNodeIds ? (targetNodeIds as Prisma.InputJsonValue) : Prisma.JsonNull,
    },
  });

  // Realtime tag the orchestrator + every dispatched node-runner share.
  // Frontend `useRealtimeRunsWithTag(realtimeTag, { accessToken })`
  // streams updates for all of them in one subscription.
  const realtimeTag = `wfrun:${workflowRun.id}`;

  // Mint a public-access token *before* triggering. We need it on the
  // response anyway, and minting it up front means a failed trigger
  // doesn't leave a stranded token; the workflowRun row is still cleaned
  // up below.
  let publicAccessToken: string | null = null;
  try {
    publicAccessToken = await triggerAuth.createPublicToken({
      scopes: { read: { tags: [realtimeTag] } },
      expirationTime: REALTIME_TOKEN_EXPIRY,
    });
  } catch (err) {
    // Token mint failures are non-fatal — the sidebar's `setInterval`
    // fallback covers us. Log and proceed without Realtime.
    console.error("[run] auth.createPublicToken failed:", err);
  }

  try {
    const handle = await tasks.trigger<typeof runWorkflowTask>(
      "run-workflow",
      {
        workflowRunId: workflowRun.id,
        workflowId: id,
        scope,
        targetNodeIds,
      },
      {
        // Tag the orchestrator so it shows up in the same Realtime stream
        // as its child node-runner runs (frontend filters by `wfrun:<id>`).
        tags: [`workflow:${id}`, realtimeTag],
        // Defense-in-depth: a retried HTTP POST with the same workflowRunId
        // (rare — we mint a fresh row above on each click — but possible
        // if the client re-fires before getting our 202) won't double-launch
        // the orchestrator.
        idempotencyKey: workflowRun.id,
        idempotencyKeyTTL: "1d",
      },
    );
    await prisma.workflowRun.update({
      where: { id: workflowRun.id },
      data: { triggerRunId: handle.id },
    });
    return NextResponse.json(
      {
        runId: workflowRun.id,
        triggerRunId: handle.id,
        publicAccessToken,
        realtimeTag,
      },
      { status: 202 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "trigger failed";
    await prisma.workflowRun.update({
      where: { id: workflowRun.id },
      data: { status: "FAILED", finishedAt: new Date(), error: message },
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
