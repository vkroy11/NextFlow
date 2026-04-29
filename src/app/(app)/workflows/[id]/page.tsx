import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { WorkflowCanvas } from "@/components/canvas/WorkflowCanvas";
import type { Edge, Node } from "reactflow";

export const dynamic = "force-dynamic";

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) return null;

  const workflow = await prisma.workflow.findUnique({ where: { id } });
  if (!workflow || workflow.userId !== userId) notFound();

  return (
    <WorkflowCanvas
      initial={{
        id: workflow.id,
        name: workflow.name,
        nodes: (workflow.nodes as unknown as Node[]) ?? [],
        edges: (workflow.edges as unknown as Edge[]) ?? [],
      }}
    />
  );
}
