import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const workflow = await prisma.workflow.findUnique({ where: { id } });
  if (!workflow || workflow.userId !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const runs = await prisma.workflowRun.findMany({
    where: { workflowId: id },
    orderBy: { startedAt: "desc" },
    take: 50,
    include: {
      nodeRuns: { orderBy: { startedAt: "asc" } },
    },
  });

  return NextResponse.json({
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      scope: r.scope,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
      error: r.error,
      nodeRuns: r.nodeRuns.map((nr) => ({
        id: nr.id,
        nodeId: nr.nodeId,
        nodeType: nr.nodeType,
        status: nr.status,
        durationMs: nr.durationMs,
        input: nr.input,
        output: nr.output,
        error: nr.error,
      })),
    })),
  });
}
