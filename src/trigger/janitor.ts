import { logger, schedules } from "@trigger.dev/sdk/v3";
import { prisma } from "@/lib/prisma";
import { tryFinaliseWorkflowRun } from "./dagDispatch";

/**
 * Watchdog scheduled task. Replaces the absolute-upper-bound watchdog
 * the orchestrator's old poll loop used to provide.
 *
 * Without this, a `WorkflowRun` could in theory stay in `RUNNING`
 * forever if every safeguard above it fails simultaneously:
 *   1. A node-runner crashes in a way its worker try/catch can't see
 *      (OOM, host failure, network partition mid-write).
 *   2. The Trigger.dev `onFailure` lifecycle hook also fails to run
 *      (extremely rare — Trigger fires it on its own infrastructure).
 *
 * In that double-failure scenario nothing transitions the row to a
 * terminal status, no last-leaf finalisation fires, and the run
 * dangles. The janitor scans for runs in `RUNNING` longer than
 * `STUCK_AFTER_MS` and force-finalises them: cancel any non-terminal
 * `NodeRun`s, then call `tryFinaliseWorkflowRun` (which will now
 * succeed because every row is terminal).
 *
 * Cadence: every 5 minutes. Threshold: 10 minutes. Both conservative —
 * happy-path workflows finish in under 60 s; the orchestrator's
 * `maxDuration` is 60 s; node-runner's is 90 s; even a worst-case run
 * is well under the threshold. The janitor only ever sees genuine
 * failures.
 *
 * No-ops cost essentially nothing (one indexed query per 5 min).
 */
const STUCK_AFTER_MS = 10 * 60_000;

export const workflowJanitorTask = schedules.task({
  id: "workflow-janitor",
  cron: "*/5 * * * *",
  // Idempotent: bounded to a small DB query + a finalise CAS per stuck
  // run. Even if the cron fires twice (clock skew, restart), the
  // second invocation's CAS no-ops on rows the first one already
  // finalised.
  retry: { maxAttempts: 1 },
  maxDuration: 60,
  run: async (_payload, { ctx }) => {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
    const stuck = await prisma.workflowRun.findMany({
      where: { status: "RUNNING", startedAt: { lt: cutoff } },
      select: { id: true, workflowId: true, startedAt: true },
    });

    if (stuck.length === 0) return { finalised: 0 };

    logger.warn("janitor found stuck workflow runs", {
      count: stuck.length,
      cutoff: cutoff.toISOString(),
      runId: ctx.run.id,
    });

    let finalised = 0;
    for (const run of stuck) {
      // Force-cancel any NodeRun rows that haven't reached a terminal
      // status. Once these are CANCELLED, every row in the workflow is
      // terminal and tryFinaliseWorkflowRun's CAS will succeed.
      const cancelled = await prisma.nodeRun.updateMany({
        where: {
          workflowRunId: run.id,
          status: { in: ["QUEUED", "RUNNING"] },
        },
        data: {
          status: "CANCELLED",
          finishedAt: new Date(),
          error: "workflow timed out (janitor)",
        },
      });
      const wonRace = await tryFinaliseWorkflowRun(run.id);
      if (wonRace) finalised += 1;
      logger.info("janitor finalised workflow run", {
        workflowRunId: run.id,
        cancelledNodeRuns: cancelled.count,
        finalisedByUs: wonRace,
      });
    }

    return { finalised, scanned: stuck.length };
  },
});
