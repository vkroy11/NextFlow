"use client";

import { createContext, useContext, type ReactNode } from "react";

export type RunScope = "FULL" | "SINGLE" | "MULTI";

type RunContextValue = {
  triggerRun: (scope: RunScope, targetNodeIds?: string[]) => void;
  isRunning: boolean;
};

const RunContext = createContext<RunContextValue | null>(null);

export function WorkflowRunProvider({ value, children }: { value: RunContextValue; children: ReactNode }) {
  return <RunContext.Provider value={value}>{children}</RunContext.Provider>;
}

export function useWorkflowRun(): RunContextValue {
  const ctx = useContext(RunContext);
  if (!ctx) return { triggerRun: () => {}, isRunning: false };
  return ctx;
}
