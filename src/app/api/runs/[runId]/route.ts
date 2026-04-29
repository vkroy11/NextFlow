import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(_: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const run = await prisma.workflowRun.findUnique({
    where: { id: runId },
    include: {
      nodeRuns: { orderBy: { startedAt: "asc" } },
    },
  });
  if (!run || run.userId !== userId) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({
    run: {
      id: run.id,
      status: run.status,
      scope: run.scope,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      error: run.error,
      nodeRuns: run.nodeRuns.map((nr) => ({
        id: nr.id,
        nodeId: nr.nodeId,
        nodeType: nr.nodeType,
        status: nr.status,
        startedAt: nr.startedAt,
        finishedAt: nr.finishedAt,
        durationMs: nr.durationMs,
        input: nr.input,
        output: nr.output,
        error: nr.error,
      })),
    },
  });
}
