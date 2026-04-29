import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { SaveWorkflowSchema } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const workflows = await prisma.workflow.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      createdAt: true,
      updatedAt: true,
      runs: {
        orderBy: { startedAt: "desc" },
        take: 1,
        select: { status: true, startedAt: true },
      },
    },
  });
  return NextResponse.json({ workflows });
}

const NEW_WORKFLOW_NODES = [
  {
    id: "request-inputs-1",
    type: "requestInputs",
    position: { x: 80, y: 200 },
    data: {
      fields: [
        { key: "text_field", label: "text_field", type: "text", value: "" },
        { key: "image_field", label: "image_field", type: "image", value: null },
      ],
    },
  },
  {
    id: "response-1",
    type: "response",
    position: { x: 720, y: 200 },
    data: { result: null },
  },
];

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // body optional on create
  }
  const parsed = SaveWorkflowSchema.partial().safeParse(body ?? {});
  const name =
    (parsed.success && parsed.data.name?.trim()) ||
    `Untitled workflow ${new Date().toLocaleString()}`;

  const nodes = (parsed.success && parsed.data.nodes ? parsed.data.nodes : NEW_WORKFLOW_NODES) as unknown as Prisma.InputJsonValue;
  const edges = (parsed.success && parsed.data.edges ? parsed.data.edges : []) as unknown as Prisma.InputJsonValue;
  const workflow = await prisma.workflow.create({
    data: { userId, name, nodes, edges },
  });
  return NextResponse.json({ workflow }, { status: 201 });
}
