import {
  tryFinaliseWorkflowRun
} from "./chunk-LOJYS7ZA.mjs";
import {
  logger,
  schedules_exports
} from "./chunk-ZLZOJIGJ.mjs";
import {
  prisma
} from "./chunk-PDXQY6SN.mjs";
import {
  __name,
  init_esm
} from "./chunk-FUV6SSYK.mjs";

// src/trigger/janitor.ts
init_esm();
var STUCK_AFTER_MS = 10 * 6e4;
var workflowJanitorTask = schedules_exports.task({
  id: "workflow-janitor",
  cron: "*/5 * * * *",
  // Idempotent: bounded to a small DB query + a finalise CAS per stuck
  // run. Even if the cron fires twice (clock skew, restart), the
  // second invocation's CAS no-ops on rows the first one already
  // finalised.
  retry: { maxAttempts: 1 },
  maxDuration: 60,
  run: /* @__PURE__ */ __name(async (_payload, { ctx }) => {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
    const stuck = await prisma.workflowRun.findMany({
      where: { status: "RUNNING", startedAt: { lt: cutoff } },
      select: { id: true, workflowId: true, startedAt: true }
    });
    if (stuck.length === 0) return { finalised: 0 };
    logger.warn("janitor found stuck workflow runs", {
      count: stuck.length,
      cutoff: cutoff.toISOString(),
      runId: ctx.run.id
    });
    let finalised = 0;
    for (const run of stuck) {
      const cancelled = await prisma.nodeRun.updateMany({
        where: {
          workflowRunId: run.id,
          status: { in: ["QUEUED", "RUNNING"] }
        },
        data: {
          status: "CANCELLED",
          finishedAt: /* @__PURE__ */ new Date(),
          error: "workflow timed out (janitor)"
        }
      });
      const wonRace = await tryFinaliseWorkflowRun(run.id);
      if (wonRace) finalised += 1;
      logger.info("janitor finalised workflow run", {
        workflowRunId: run.id,
        cancelledNodeRuns: cancelled.count,
        finalisedByUs: wonRace
      });
    }
    return { finalised, scanned: stuck.length };
  }, "run")
});

export {
  workflowJanitorTask
};
//# sourceMappingURL=chunk-4HOWHU7B.mjs.map
