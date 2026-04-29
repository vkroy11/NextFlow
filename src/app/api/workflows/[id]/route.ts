import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { SaveWorkflowSchema } from "@/lib/types";
import { z } from "zod";

export const runtime = "nodejs";

async function authedWorkflow(id: string) {
  const { userId } = await auth();
  if (!userId) return { error: "unauthorized" as const };
  const workflow = await prisma.workflow.findUnique({ where: { id } });
  if (!workflow) return { error: "not_found" as const };
  if (workflow.userId !== userId) return { error: "forbidden" as const };
  return { userId, workflow };
}

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await authedWorkflow(id);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.error === "unauthorized" ? 401 : 404 });
  return NextResponse.json({ workflow: r.workflow });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await authedWorkflow(id);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.error === "unauthorized" ? 401 : 404 });
  const parsed = SaveWorkflowSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }
  const { name, nodes, edges } = parsed.data;
  const updated = await prisma.workflow.update({
    where: { id },
    data: {
      ...(name ? { name } : {}),
      nodes: nodes as unknown as Prisma.InputJsonValue,
      edges: edges as unknown as Prisma.InputJsonValue,
    },
  });
  return NextResponse.json({ workflow: updated });
}

const PatchSchema = z.object({ name: z.string().min(1).max(120) });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await authedWorkflow(id);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.error === "unauthorized" ? 401 : 404 });
  const parsed = PatchSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const updated = await prisma.workflow.update({
    where: { id },
    data: { name: parsed.data.name },
  });
  return NextResponse.json({ workflow: updated });
}

export async function DELETE(_: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await authedWorkflow(id);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.error === "unauthorized" ? 401 : 404 });
  await prisma.workflow.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
