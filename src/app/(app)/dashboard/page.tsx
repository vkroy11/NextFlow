import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { DashboardClient } from "./DashboardClient";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) return null;

  const workflows = await prisma.workflow.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      updatedAt: true,
      runs: {
        orderBy: { startedAt: "desc" },
        take: 1,
        select: { status: true },
      },
    },
  });

  return (
    <DashboardClient
      initialWorkflows={workflows.map((w) => ({
        id: w.id,
        name: w.name,
        updatedAt: w.updatedAt.toISOString(),
        lastStatus: w.runs[0]?.status ?? null,
      }))}
    />
  );
}
