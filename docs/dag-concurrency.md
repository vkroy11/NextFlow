# DAG concurrency on Trigger.dev v4 — postmortem

> **Audience**: anyone touching `src/trigger/runWorkflow.ts` or wondering why
> the executor looks the way it does. This doc is the long-form
> "why these constraints exist"; the source files only carry short
> reminders that point back here.

## TL;DR

The orchestrator that runs a NextFlow workflow used to use ordinary
`Promise.all` and async-IIFE fan-out to start sibling DAG-level nodes
concurrently. That works in development and crashes in production with
`TriggerInternalError: Parallel waits are not supported`. The fix is a
single dispatcher task — `nodeRunnerTask` — that the orchestrator calls
once per DAG level via `batchTriggerAndWait`. The dispatcher's discriminated
payload (`{ kind: "crop" | "gemini" } & helperPayload`) lets us batch
**different** node types into one wait, which is the only way Trigger.dev
v4 allows true cross-type same-level concurrency. NodeRun bookkeeping
stays inside the per-type worker functions, so the in-app History sidebar
shows the same per-node-type rows it always has — no `node-runner` rows.

## What broke

A user-visible failure mode the History sidebar showed for the imported
sample workflow:

```
Run #6 — 30 Apr, 5:44 ........................... 86.2 s · full
├── ✅ requestInputs    request-inputs-1 ............... 0.0 s
├── ✅ gemini           gemini-15c556ee ................ 7.9 s
├── ✅ cropImage        cropImage-b026351c ............ 32.5 s
├── ✅ cropImage        cropImage-1d977242 ............ 32.5 s
├── ✅ gemini           gemini-5923c2ca ............... 15.0 s
└── ❌ TriggerInternalError: Parallel waits are not supported,
       e.g. using Promise.all() around our wait functions.
```

Five nodes had completed, the final Gemini (the one that fans in three
parents — both crops + gemini-2) never started. The workflow status was
PARTIAL.

The same workflow ran clean to completion in `npm run trigger:dev` with
nothing more than a console warning. Production killed it.

## How Trigger.dev v4 thinks about waits

Three primitives can suspend a parent task in Trigger v4:

| Primitive | Pending waits introduced | Cross-type? |
| --- | --- | --- |
| `task.triggerAndWait(payload)` | 1 | n/a |
| `task.batchTriggerAndWait(items)` | 1 (the whole batch counts as one wait) | No — items must all be the **same task type** |
| `wait.for(...)` / `wait.until(...)` | 1 | n/a |

The hard rule (called out explicitly in the project's `CLAUDE.md`):

> Never wrap `triggerAndWait` or `batchTriggerAndWait` calls in a
> `Promise.all` or `Promise.allSettled` as this is not supported in
> Trigger.dev tasks.

Why so strict? Trigger.dev workers in production **checkpoint** every wait
that exceeds ~5 seconds. The runtime serialises the task's frame, kills
the worker container (so you stop paying compute while a 30-second crop
sits idle), and on wait resolution spawns a new worker that resumes from
the saved checkpoint. That model assumes there is exactly **one**
suspension point per task — the wait you got checkpointed on. If your
parent task has three pending `triggerAndWait`s when the checkpointer
arrives, there's no unambiguous "wake me up on X" signal to record. The
runtime preempts that case before it can produce a corrupt resume.

## Why dev was lenient and prod was strict

Both environments share one rule but enforce it very differently:

**Dev (`npm run trigger:dev`)** runs a single long-lived Node process
locally. There is no checkpointing — your task is just a normal in-memory
async function. Multiple pending awaits are technically against the rule,
but the dev runtime degrades to a console warning because nothing
downstream depends on the rule being respected. You actually saw the
warning in the dev logs:

```
○ Apr 30, 02:48:49.542 ... Parallel waits are not supported,
                          e.g. using Promise.all() around our wait functions.
```

…and the run completed fine.

**Prod (after `trigger:deploy`)** runs each task on Trigger.dev cloud
workers that *will* checkpoint anything past the threshold. The runtime
isn't being optional anymore — it has to know which suspension to resume
from, so it raises the warning to a hard `TriggerInternalError`. The
workflow stops at the first node that violates the rule.

In our workflow that node was the final Gemini, because it was the first
one with **three** parents in flight at once: the eager-IIFE pattern we
used had each of the three children's frames pending `triggerAndWait`
simultaneously by the time the checkpoint window opened. Earlier nodes
had only 0–1 parents each, so they slipped under the rule.

## Iteration history

Five attempts, four of which we ended up reverting. Recording them here
so future contributors don't re-discover the same dead ends.

### Attempt 1 — `Promise.all` over child tasks (original code)

```ts
const parentOutputs = await Promise.all(parentIds.map((p) => getPromise(p)));
```

**Result**: dev OK with warning, prod hard error on the first node with
multiple parents. Forbidden by the docs and the prod runtime.

### Attempt 2 — eager fan-out + sequential await

```ts
const pairs = parentIds.map((pid) => [pid, getPromise(pid)] as const);
for (const [pid, promise] of pairs) parentByEdge[pid] = await promise;
```

**Idea**: `.map()` runs synchronously and each `getPromise` IIFE executes
to its first `triggerAndWait` before the next iteration starts, so child
tasks fire on workers in parallel. The orchestrator then awaits them
one-at-a-time in JS terms.

**Result**: looked sequential at the JS level, *was* parallel at the
runtime level. The Trigger checkpointer counts pending
`triggerAndWait`s, not how the parent JS frame gets to them. By the time
a node with 3 parents went to checkpoint, all 3 child IIFEs had a
`triggerAndWait` open — same crash. Prod failed identically to Attempt 1.

### Attempt 3 — strict sequential topological walk

```ts
async function runNode(nodeId: string): Promise<NodeOutput> {
  for (const pid of parentIds) parentByEdge[pid] = await runNode(pid);
  return await runNodeBody(node, parentByEdge);
}
```

**Result**: correctness, no parallel-waits crashes — exactly one
`triggerAndWait` is pending at any moment. **But**: complete loss of
concurrency. The reference workflow's two crops ran one after another
instead of together. Wall time ~110 s vs the ~50 s an ideal scheduler
would hit.

### Attempt 4 — per-type `batchTriggerAndWait` per DAG level

```ts
const cropBatch = await cropImageTask.batchTriggerAndWait(cropPayloads);
const geminiBatch = await geminiTask.batchTriggerAndWait(geminiPayloads);
```

**Result**: legal (each batch is one wait), and crops at level 1 finally
fired together. **But**: at a level with both crops and a gemini, the
two batches still run sequentially because `batchTriggerAndWait` only
batches one task type at a time. The PRD's "crop1 + crop2 + gemini1
all start at T = 0" requirement was still not met — gemini1 either
waited for crops to finish or vice versa, depending on order. About ~78 s
on the reference workflow.

### Attempt 5 — current solution: dispatcher task

Collapse every executable node type into **one** task, `nodeRunnerTask`,
whose payload carries a discriminator. The orchestrator builds one mixed
list of payloads per DAG level and calls
`nodeRunnerTask.batchTriggerAndWait` once.

```ts
const slots: { nodeId: string; payload: NodeRunnerPayload }[] = [
  { nodeId: c1.id, payload: { kind: "crop",   ...buildCropPayload(c1, parents) } },
  { nodeId: c2.id, payload: { kind: "crop",   ...buildCropPayload(c2, parents) } },
  { nodeId: g1.id, payload: { kind: "gemini", ...buildGeminiPayload(g1, parents) } },
];
const batch = await nodeRunnerTask.batchTriggerAndWait(
  slots.map((s) => ({ payload: s.payload }))
);
```

`nodeRunnerTask` itself is a thin switch:

```ts
export const nodeRunnerTask = task({
  id: "node-runner",
  maxDuration: 60,
  run: async (payload: NodeRunnerPayload) => {
    switch (payload.kind) {
      case "crop":   return { kind: "crop",   output: await runCropImage(strip(payload)) };
      case "gemini": return { kind: "gemini", output: await runGemini(strip(payload)) };
    }
  },
});
```

`runCropImage` and `runGemini` are plain async functions extracted from
the old `cropImageTask` / `geminiTask` bodies. They retain all the
`prisma.nodeRun.*` writes with their canonical `nodeType` strings
(`cropImage`, `gemini`). The dispatcher writes nothing to `NodeRun`.

The orchestrator's only change is mapping the dispatcher's `kind` back to
the canonical canvas-node-type discriminator the resolvers downstream
expect:

```ts
if (r.output.kind === "crop")   outputs.set(slot.nodeId, { kind: "cropImage", output: r.output.output });
if (r.output.kind === "gemini") outputs.set(slot.nodeId, { kind: "gemini",    output: r.output.output });
```

Inline node types — `requestInputs`, `input`, `response`, `stickyNote` —
keep their direct in-orchestrator Prisma writes. They're trivially fast
and usually alone at their level (L0 / final), so going through the
dispatcher would only add Trigger scheduling overhead.

## Architecture

```
┌─────────────────────────────── orchestrator (run-workflow task) ──────────────────┐
│                                                                                   │
│  for each DAG level:                                                              │
│    1) Inline types (requestInputs / input / response / stickyNote)                │
│       └── direct prisma.nodeRun.* writes                                          │
│                                                                                   │
│    2) Trigger task types (cropImage + gemini, in any combination)                 │
│       └── nodeRunnerTask.batchTriggerAndWait([                                    │
│             { payload: { kind: "crop",   ...c1 } },                               │
│             { payload: { kind: "crop",   ...c2 } },                               │
│             { payload: { kind: "gemini", ...g1 } },                               │
│           ])                                                                      │
│             └── one Trigger v4 wait, all three run T = 0 on workers ──────┐      │
└────────────────────────────────────────────────────────────────────────────┼──────┘
                                                                              │
                                                                              ▼
                                                                ┌─── nodeRunnerTask ───┐
                                                                │  switch (kind) {     │
                                                                │    "crop"   → run…   │
                                                                │    "gemini" → run…   │
                                                                │  }                   │
                                                                └──────────────────────┘
                                                                  │            │
                                                              runCropImage  runGemini
                                                              (worker fn)   (worker fn)
                                                              writes        writes
                                                              NodeRun       NodeRun
                                                              (cropImage)   (gemini)
```

Properties this gives us:

- **PRD compliance**: same-level executable nodes — even of different
  types — start at T = 0 on workers.
- **Trigger v4 compliance**: orchestrator never has more than one wait
  pending. `batchTriggerAndWait` counts as one wait regardless of the
  number of items in it.
- **Sidebar invariant**: the History sidebar reads
  `WorkflowRun.nodeRuns` from Postgres. Only worker functions write
  there. Users see the per-node-type rows they expect; the dispatcher
  is invisible to them.
- **Trigger dashboard observability**: the cloud dashboard at
  `cloud.trigger.dev/projects/<ref>/runs` shows one `node-runner` run
  per executable node, with the `kind`-tagged payload visible. Useful
  for debugging the dispatcher itself, and for the Trigger.dev billing
  view.

## Trade-offs we accepted

1. **Per-task retry / max-duration / concurrency caps are gone**. Today
   `node-runner` has `maxDuration: 60s` and `retry: { maxAttempts: 1 }`
   for everything. If we ever needed Crop to retry 3× and Gemini to
   retry 1×, we'd implement that inside the worker functions or push it
   back to per-type tasks.
2. **One queue for all executable nodes**. Trigger.dev's per-task
   concurrency cap now governs all of crop+gemini together rather than
   each separately. Not visible at our scale; flag if it ever is.
3. **Slightly noisier Trigger dashboard**. Every node maps to one
   `node-runner` run. Search for the helper task by its inner payload
   `kind`, not by task id.

## Implementation surface

| File | Role |
| --- | --- |
| `src/trigger/runWorkflow.ts` | Orchestrator. Builds DAG levels, collects parent outputs, builds per-slot payloads, fires one `nodeRunnerTask.batchTriggerAndWait` per level. |
| `src/trigger/nodeRunner.ts` | The single executable Trigger task. Discriminated-payload dispatch only — no DB writes. |
| `src/trigger/cropImage.ts` | Exports `runCropImage` worker. Owns the Crop's `NodeRun` row + the mandatory 30 s artificial delay + the Transloadit `/image/resize` call. |
| `src/trigger/gemini.ts` | Exports `runGemini` worker. Owns the Gemini's `NodeRun` row + the `callGemini` call. |
| `src/trigger/requestInputs.ts` | Type-only — orchestrator inlines the logic. |
| `src/trigger/response.ts` | Type-only — orchestrator inlines the logic. |
| `src/components/canvas/HistorySidebar.tsx` | Unchanged. Reads `WorkflowRun.nodeRuns` and renders per-node-type rows. |

## When you'd reach for a different shape

- **Real-time / streaming Gemini output** would want to leave the
  dispatcher pattern and go back to a per-type task that emits progress
  events (and keeps its own dashboard timeline).
- **More than two executable types** (e.g., adding a video-encode node)
  just adds a `case` to `nodeRunnerTask` and a `kind` to
  `NodeRunnerPayload`. No orchestrator change beyond a `buildXPayload`.
- **DAG with hundreds of same-level nodes** would still fit in one
  `batchTriggerAndWait` call (Trigger.dev limit is 1000 items / 3 MB
  per batch). If a single `kind` ever needs >1000 instances at one
  level, split into multiple sequential batches of that kind only —
  cross-type concurrency at the level still happens for whatever fits
  in the first batch.

## References

- Trigger.dev v4 docs — `triggerAndWait` / `batchTriggerAndWait` /
  parallel-waits constraint, restated in the project's `CLAUDE.md`.
- PRD §"Expected execution behaviour": "Crop #1, Crop #2, and Gemini #1
  all start at T=0 (same DAG level → concurrent fan-out)."
- PRD §"MANDATORY 30+ second artificial delay on Crop Image": preserved
  inside `runCropImage`.
- The full conversation that produced this design lives in the chat
  history on commit `node-runner dispatcher for cross-type DAG-level
  concurrency`.
