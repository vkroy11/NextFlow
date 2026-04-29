import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { tasks } from "@trigger.dev/sdk/v3";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { RunRequestSchema } from "@/lib/types";
import type { runWorkflowTask } from "@/trigger/runWorkflow";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { userId } = await auth();
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

  try {
    const handle = await tasks.trigger<typeof runWorkflowTask>("run-workflow", {
      workflowRunId: workflowRun.id,
      workflowId: id,
      scope,
      targetNodeIds,
    });
    await prisma.workflowRun.update({
      where: { id: workflowRun.id },
      data: { triggerRunId: handle.id },
    });
    return NextResponse.json({ runId: workflowRun.id, triggerRunId: handle.id }, { status: 202 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "trigger failed";
    await prisma.workflowRun.update({
      where: { id: workflowRun.id },
      data: { status: "FAILED", finishedAt: new Date(), error: message },
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
