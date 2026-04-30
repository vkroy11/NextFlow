/**
 * Type-only module. Response is now executed inline inside the orchestrator
 * (`src/trigger/runWorkflow.ts`) — no Trigger.dev task here.
 *
 * Types stay so `runWorkflow.ts` can keep its `NodeOutput` discriminated
 * union shape unchanged.
 */

export type ResponsePayload = {
  workflowRunId: string;
  nodeId: string;
  result: string | null;
};

export type ResponseOutput = { result: string | null; perEdge?: Record<string, string> };
