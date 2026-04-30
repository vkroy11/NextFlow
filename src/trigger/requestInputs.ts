/**
 * Type-only module. Request-Inputs is now executed inline inside the
 * orchestrator (`src/trigger/runWorkflow.ts`) — no Trigger.dev task here, so
 * the trigger:deploy task count only reflects executable surfaces
 * (run-workflow + node-runner).
 *
 * The types stay so `runWorkflow.ts` can keep its `NodeOutput` discriminated
 * union shape unchanged.
 */

export type RequestInputsPayload = {
  workflowRunId: string;
  nodeId: string;
  fields: Record<string, unknown>;
};

export type RequestInputsOutput = { fields: Record<string, unknown> };
