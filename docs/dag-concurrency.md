# DAG concurrency on Trigger.dev v4 — postmortem

> **Audience**: anyone touching `src/trigger/runWorkflow.ts` or wondering why
> the executor looks the way it does. This doc is the long-form
> "why these constraints exist"; the source files only carry short
> reminders that point back here.

## TL;DR

The orchestrator that runs a NextFlow workflow has been through eight
shapes. The current one is **recursive dispatch + last-leaf finalisation
+ Trigger-native hardening + scheduled janitor**:

- The orchestrator (`runWorkflowTask`) is **setup-only**: pre-creates
  one `NodeRun` row per executable node in `QUEUED`, fire-and-forget
  triggers root nodes via `nodeRunnerTask.trigger(...)`, and returns
  immediately. No poll loop, no waiting.
- The universal dispatcher (`nodeRunnerTask`) runs the matching worker
  (cropImage / gemini / requestInputs / input / response). On success it
  reads each child's parents from the DB, atomically claims the child via
  Postgres CAS (`updateMany WHERE status=QUEUED`), then `nodeRunnerTask
  .trigger(...)` for the child. On final-attempt failure the `onFailure`
  hook fails the row + cascades CANCELLED to descendants. **Every exit
  path calls `tryFinaliseWorkflowRun`** — which CAS-updates
  `WorkflowRun.status` if every NodeRun row is now terminal. The last
  node to flip a row terminal wins the CAS and writes
  `SUCCESS / FAILED / PARTIAL`; losers no-op.
- Every trigger call carries `tags` (`workflow:`, `wfrun:`, `node:`) and
  an `idempotencyKey` (`wfrun-<id>-node-<nodeId>`, TTL 1 d) for dashboard
  filtering and dedup defense. Workers retry 3× with exponential backoff;
  permanent 4xx errors short-circuit via `AbortTaskRunError`. A shared
  `node-execution` queue caps concurrency at 20 (5 in dev). The frontend
  subscribes to `wfrun:<id>` via `useRealtimeRunsWithTag` instead of
  polling `/runs`.
- A scheduled `workflow-janitor` (`schedules.task`, `cron */5 * * * *`)
  is the last-resort safety net: scans for `WorkflowRun`s in RUNNING for
  >10 min, force-cancels non-terminal NodeRuns, calls
  `tryFinaliseWorkflowRun`. Catches the rare double-failure where both
  worker try/catch and `onFailure` somehow miss.

Earlier shapes (Promise.all, eager-IIFE, strict-sequential, per-type
batches, mixed-type batch via dispatcher, recursive dispatch with 3 s
polling) crashed in production with `TriggerInternalError: Parallel
waits are not supported`, lost concurrency, had atomic-at-the-level-
boundary delays, or kept the orchestrator alive polling Postgres for an
answer Realtime was already pushing to the frontend. The current shape
avoids all of those: orchestrator never blocks (parallel-waits rule
satisfied trivially), last-leaf finalisation eliminates the polling
tail, and the janitor handles the long tail of crash modes that bypass
in-band cleanup.

## FAQ

### Q1 — How does the orchestrator know "the workflow is done"? (Historically: by polling. Now: last-leaf finalisation.)

**Today.** The orchestrator does **not** know — it doesn't even watch.
After firing roots it returns immediately. Each `nodeRunnerTask`, on
every exit path (success, failure, cancel-cascade, `onFailure` hook),
calls `tryFinaliseWorkflowRun(workflowRunId)`:

```ts
export async function tryFinaliseWorkflowRun(workflowRunId: string): Promise<boolean> {
  const rows = await prisma.nodeRun.findMany({ where: { workflowRunId }, select: { status, error }});
  if (!rows.every((r) => TERMINAL.has(r.status))) return false; // not all terminal yet
  const finalStatus = aggregate(rows); // SUCCESS / FAILED / PARTIAL
  // CAS: only one concurrent caller wins the UPDATE.
  const claim = await prisma.workflowRun.updateMany({
    where: { id: workflowRunId, status: "RUNNING" },
    data: { status: finalStatus, finishedAt: new Date(), error: firstError },
  });
  return claim.count === 1;
}
```

The *last* node to flip a NodeRun row terminal sees "every row terminal"
and wins the `WorkflowRun` CAS. Two nodes finishing simultaneously can
both pass the "all terminal" check; only one wins the `updateMany`
(`count: 1`); the other sees `count: 0` and exits silently.

This means workflow finalisation is **sub-second** — bounded only by
the worker's own DB write latency for its terminal row. There's no
polling tail; the WorkflowRun.status flips in the same dispatcher
invocation that wrote the last NodeRun row.

**Watchdog** (the role the orchestrator's poll loop's iteration cap
used to play) moves to a separate task:

```ts
// src/trigger/janitor.ts
export const workflowJanitorTask = schedules.task({
  id: "workflow-janitor",
  cron: "*/5 * * * *",
  run: async () => {
    const stuck = await prisma.workflowRun.findMany({
      where: { status: "RUNNING", startedAt: { lt: tenMinutesAgo() } },
    });
    for (const run of stuck) {
      await prisma.nodeRun.updateMany({
        where: { workflowRunId: run.id, status: { in: ["QUEUED", "RUNNING"] } },
        data: { status: "CANCELLED", finishedAt: new Date(), error: "workflow timed out (janitor)" },
      });
      await tryFinaliseWorkflowRun(run.id);
    }
  },
});
```

Catches the rare double-failure case where both the worker's try/catch
*and* the `onFailure` hook miss (host crash mid-write, infrastructure
failure, etc.). Cron every 5 minutes; threshold 10 minutes. Almost
always a no-op in practice.

**Why we used to poll.** Earlier iterations (Attempt 6, before this
round) kept the orchestrator alive polling Postgres every 3 s in a
sequential `wait.for({ seconds: 3 })` loop, looking for "all terminal."
The reasoning at the time was that fire-and-forget `.trigger()` gave
the orchestrator no Trigger-native callback for "every transitive
descendant has finished" — and indeed Trigger.dev v4 doesn't expose
such a primitive. So the orchestrator polled the only authoritative
source: our own `NodeRun` table.

**Why we stopped polling.** The polling was **redundant** with Realtime.
Once the frontend started subscribing via `useRealtimeRunsWithTag`,
the orchestrator's poll only governed how soon `WorkflowRun.status`
flipped — not how soon the user *saw* the workflow as done (Realtime
already pushed the last node's `SUCCESS` row sub-second). The 3 s tail
was invisible to users; the orchestrator's continuous worker
occupation and ~20 indexed queries per 60 s workflow weren't earning
their keep. Shifting to last-leaf finalisation eliminated both.

**Alternatives we considered when designing the replacement.**

| Alternative | Verdict |
| --- | --- |
| `wait.forToken` — orchestrator creates a token, last leaf calls `runs.completeWaitToken` | Same "who's last?" race as last-leaf finalisation, plus an extra token-completion failure mode. Skipped. |
| `useRealtimeRun` / `subscribeToRun` from inside the orchestrator | Realtime is a *client* primitive. The connection is HTTP/SSE which doesn't survive Trigger task checkpointing. There's also no logical reason to subscribe: the orchestrator IS the run being watched; there's no "outside" to stream from. |
| Increase poll cadence to 5–30 s | Patches the cost without removing the redundancy. Half-measure. |
| Don't have an orchestrator at all — API route fires roots directly | Spreads setup logic across the API path. Equivalent total complexity. We kept the orchestrator as a thin setup-only task because it's a clean encapsulation of "validate cycle, build executable set, pre-create rows, fire roots." |

The current shape is the simplest design that gives sub-second
finalisation, race-safety, and a watchdog. Three small mechanisms
(CAS-based finalise, `onFailure` hook, scheduled janitor) replacing
one larger one (poll loop with iteration cap).

### Q2 — How does Trigger run children after a parent completes? Where is the decision made? How is the graph created?

**The decision is made in OUR code, running ON Trigger.dev's worker.**
Trigger.dev itself has zero knowledge of our DAG. To Trigger every
`node-runner` invocation is an independent run with an opaque payload;
the dispatcher → child relationship is invisible to the platform. Our
recursive-dispatch logic fires children explicitly via
`nodeRunnerTask.trigger(...)` from inside the parent's task body.

**The lifecycle of a single child trigger.** Given a parent (say,
`gemini-1`) that just completed:

1. `nodeRunnerTask.run(...)` finishes its worker (`runGemini`).
2. The same task body calls `dispatchReadyChildren(...)` from
   `src/trigger/dagDispatch.ts`. This is *our* TypeScript, executing on
   the Trigger worker container. Trigger doesn't see this step.
3. `dispatchReadyChildren` calls `loadGraph(workflowId)` →
   `prisma.workflow.findUnique` → reads `workflow.nodes` and
   `workflow.edges` from Postgres. From these it builds two adjacency
   maps via `buildAdjacency(nodes, edges)`:
   - `out: Map<nodeId, childIds[]>` — forward edges
   - `inn: Map<nodeId, parentIds[]>` — reverse edges
4. For each child of the just-completed node (`graph.out.get("gemini-1")`):
   - Read every parent's NodeRun status from Postgres
     (`loadParentNodeRuns`).
   - If any parent is FAILED/CANCELLED → skip (cascade-cancel handles
     descendants).
   - If any parent is still QUEUED/RUNNING → skip (whichever finishes
     last will retry this check and find all SUCCESS).
   - If *all* parents are SUCCESS → atomic CAS-claim the child
     (`tryClaimNodeRun`: `prisma.nodeRun.updateMany({ where: { id, status:
     "QUEUED" }, data: { status: "RUNNING", startedAt: now } })`).
     `updateMany` returns `{ count: 1 }` to the caller that won; `{ count:
     0 }` to anyone who lost the race. Only the winner proceeds.
5. The winner calls `nodeRunnerTask.trigger(payload, { tags,
   idempotencyKey, idempotencyKeyTTL })`. **This** is the only
   Trigger-platform interaction in the cascade — an HTTPS POST to
   Trigger.dev's API saying "schedule a `node-runner` invocation with
   this payload." Trigger's queue accepts it; some worker eventually
   picks it up; the cycle repeats.

**The graph itself.** `Workflow.nodes` and `Workflow.edges` are stored
as JSON columns in Postgres (`prisma/schema.prisma`). The user authors
them in the React Flow canvas; `Workflow PUT` saves them. The schema
encodes:

- Each **node** has `id`, `type` (`requestInputs` | `cropImage` |
  `gemini` | `response` | `input` | `stickyNote`), `position`, `data`
  (per-type config — model, prompt, x/y/w/h, etc.).
- Each **edge** has `id`, `source` (parent nodeId), `target` (child
  nodeId), `sourceHandle`, `targetHandle` (the handle types are
  type-checked at edge-creation time on the canvas — see
  `src/lib/handles.ts`).

There is no separate graph table — the entire DAG is one JSON column on
each `Workflow` row. This is fine because workflows are small (kilobytes
of JSON) and the executor only reads them.

**What algorithm runs the cascade.**

- **Cycle check** at orchestrator boot: Kahn's algorithm
  (`hasCycle(nodes, edges)` in `src/lib/dag.ts`). Refuses to run a
  cyclic DAG.
- **Adjacency build**: simple linear pass over edges → two maps
  (`out` and `inn`). O(V + E).
- **Root detection**: nodes with no parents in the executable set. O(V).
- **Cascade dispatch**: at each completed node, the parent-readiness
  check is O(parents-of-child) per child. Across the whole DAG this is
  O(V + E) amortised — the work is decentralised across many
  `node-runner` invocations rather than computed up front.

This is **event-driven topological execution**. Compare with classic
schedulers:

| Approach | Where the schedule is computed | When children are picked up |
| --- | --- | --- |
| Level-batched (the previous shape) | Up front, in the orchestrator. Kahn → list of levels → `batchTriggerAndWait` per level. | After the *whole* level finishes. Atomic at the level boundary. |
| Recursive dispatch (current) | Distributed. Each node's completion handler does a local readiness check for its children. | The instant *that node's* parents-all-SUCCESS check passes, regardless of unrelated siblings. |

The recursive shape is what lets `gemini-2` start at `t ≈ 8 s` after
`gemini-1` finishes, instead of waiting for unrelated crops at the same
DAG level to finish at `t ≈ 33 s`. There is no "DAG level" concept in
the runtime any more — each node fires when *its own* parents are done.
That's the win the architecture exists to deliver.

**Race-safety.** Two parents finishing nearly simultaneously could both
read "all of child's parents are now SUCCESS" and both try to fire the
child. The Postgres CAS in `tryClaimNodeRun` resolves it: only one
`updateMany WHERE status=QUEUED` returns `{ count: 1 }`. The loser sees
`{ count: 0 }` and skips. The idempotency key on the trigger call is a
second layer of defence — even if a future code path bypasses the CAS,
Trigger.dev dedups by `wfrun-<id>-node-<nodeId>` so the child never
runs twice.

---

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

### Attempt 5 — dispatcher task with mixed-type `batchTriggerAndWait` (superseded)

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

### Attempt 6 — recursive dispatch (replaces level-batched)

Even with the mixed-type batch from Attempt 5 the executor was atomic at
the **level boundary**. For the reference workflow:

- L0: `requestInputs` (~50 ms)
- L1: `crop1`, `crop2`, `gemini1` — all start at T = 0 within one batch
- L2: `gemini2` (depends only on `gemini1`) — but the batch from L1
  hasn't returned yet because the crops at L1 take ~33 s

`gemini2` had to wait until L1's whole batch resolved (~33 s) before L2
could begin, even though its only parent (`gemini1`) finished at ~8 s.
That's a 25 s wasted-wait every time a workflow has uneven branch
runtimes.

**Fix**: drop `batchTriggerAndWait` entirely. The orchestrator
pre-creates a `NodeRun` row for every executable node in QUEUED status,
then fires roots with **fire-and-forget** `nodeRunnerTask.trigger(...)`
(no `-AndWait`). Each `nodeRunnerTask` invocation, after its worker
succeeds, calls `dispatchReadyChildren` which CAS-claims each ready
child and triggers a fresh `nodeRunnerTask` for it. The orchestrator
polls `WorkflowRun.nodeRuns` every 3 s to detect "all terminal" and
finalise.

Why this is checkpoint-safe: the orchestrator's only suspension is the
sequential `wait.for({ seconds: 3 })` loop — one pending wait at a time.
The dispatcher uses plain `.trigger()` which doesn't suspend. No
parallel waits anywhere.

The cost: a 3 s polling tail on detecting "workflow done", and Postgres
CAS for race-safety. Both worth it.

```ts
// runWorkflow.ts (orchestrator)
for (const nodeId of rootIds) {
  const nodeRunId = nodeRunIds.get(nodeId)!;
  if (!(await tryClaimNodeRun(nodeRunId))) continue;
  await nodeRunnerTask.trigger({ workflowRunId, workflowId, nodeRunId, nodeId });
}

while (iter++ < MAX_ITER) {
  await wait.for({ seconds: 3 });
  const rows = await prisma.nodeRun.findMany({ where: { workflowRunId }, select: { status: true } });
  if (rows.every((r) => TERMINAL.has(r.status))) break;
}
```

```ts
// nodeRunner.ts dispatch path (after worker success)
await dispatchReadyChildren({
  workflowRunId, workflowId, completedNodeId: nodeId, graph,
  nodeRunIndex: await loadNodeRunIndex(workflowRunId),
  trigger: (payload, options) => nodeRunnerTask.trigger(payload, options),
  buildOptions: (childNodeRunId, childNodeId) => buildChildTriggerOptions({...}),
});
```

```ts
// dagDispatch.ts (the cascade)
for (const childId of childIds) {
  const parents = await loadParentNodeRuns(workflowRunId, parentIds);
  if (!allParentsSuccess(parents)) continue;
  if (!(await tryClaimNodeRun(childRun.id))) continue; // CAS — loser skips
  await trigger({ workflowRunId, workflowId, nodeRunId: childRun.id, nodeId: childId },
                buildOptions(childRun.id, childId));
}
```

Result on the reference workflow: `gemini-2` starts at T ≈ 8 s instead
of T ≈ 33 s. End-to-end wall time drops from ~78 s to ~50 s.

**Inline node types absorbed.** Once the orchestrator stopped doing
level-batching, there was no special path for inline types either. They
became plain async worker functions in `src/trigger/inlineNodes.ts`
invoked through the dispatcher just like crops and geminis. The
History sidebar still shows their `nodeType` rows because the workers
write `NodeRun` directly; `node-runner` itself remains DB-silent.

### Attempt 7 — Trigger-native hardening on top of recursive dispatch (superseded by Attempt 8 for finalisation)

The recursive shape works correctly but used the bare-minimum Trigger
SDK surface (`task`, `wait.for`, `.trigger()`). This round layered
production-grade Trigger.dev v4 features on top **without changing the
architecture**:

- **Tags** on every trigger call: `workflow:<id>`, `wfrun:<id>`,
  `node:<nodeRunId>`. Threaded through `dispatchReadyChildren` via the
  new `ChildTriggerOptions` type. Used for Trigger dashboard filtering
  and as the subscription scope for the frontend's
  `useRealtimeRunsWithTag`.
- **Idempotency keys**: `idempotencyKey: wfrun-<id>-node-<nodeId>`,
  `idempotencyKeyTTL: 1d`. Defense atop the Postgres CAS — even if a
  future code path bypasses the CAS, Trigger dedups the schedule.
- **Retry policy**: `nodeRunnerTask.retry: { maxAttempts: 3, factor: 2,
  minTimeoutInMs: 1000, maxTimeoutInMs: 30_000, randomize: true }`.
  Transient Postgres / Transloadit / Gemini hiccups self-heal.
  Permanent 4xx errors short-circuit via `AbortTaskRunError` — see
  `src/lib/triggerErrors.ts` for the classifier.
- **Worker SUCCESS-guards**: `runCropImage` and `runGemini` start with a
  row-status check; if status is already `SUCCESS` with output present,
  they return early. Keeps retries idempotent — no double Transloadit
  charge, no second 30 s artificial delay.
- **Queue concurrency**: `queue: { name: "node-execution",
  concurrencyLimit }`. Env-driven (5 dev / 20 prod). Caps simultaneous
  Transloadit + Gemini calls regardless of fan-out width.
- **`onFailure` lifecycle hook**: fires after the final retry attempt
  exhausts. Marks the row FAILED + cascades CANCELLED via
  `cancelDescendants`. Catches OOM / host crash / `maxDuration` timeout
  — failure modes the worker's own try/catch can't see.
- **Realtime in the frontend**: `/api/workflows/[id]/run` mints a
  `publicAccessToken` (`auth.createPublicToken({ scopes: { read: { tags:
  ["wfrun:<id>"] } } })`) and ships it to the browser.
  `useRealtimeRunsWithTag` opens an SSE stream; the History sidebar
  debounce-refetches `/runs` for the rich detail on every push.
  `setInterval(fetchRuns, 5000)` fallback only when SSE errors or token
  is absent.
- **Structured logger + light metadata**: `logger.info({...})` at decision
  points; `metadata.set("progress", "X/Y")` per poll iteration so the
  Trigger dashboard's run detail page shows live progress without
  opening the History sidebar.

Net effect: same architecture, far more reliable in the face of
transient failures, sub-second UI, and triageable from the Trigger
dashboard.

### Attempt 8 — last-leaf finalisation (current)

After Attempt 7 the executor was reliable but still kept the
orchestrator alive in a 3 s `wait.for` poll loop, polling Postgres for
"all terminal" so it could write `WorkflowRun.status`. With Realtime
serving the frontend, that polling was redundant: the user already saw
the workflow as done sub-second; the orchestrator's poll only governed
the moment `WorkflowRun.status` flipped, which the user never noticed.

**Fix**: drop the poll loop entirely. The orchestrator becomes
**setup-only** — pre-creates rows, fires roots, returns. Every
`nodeRunnerTask` exit path calls `tryFinaliseWorkflowRun(workflowRunId)`,
which CAS-updates `WorkflowRun.status` if every NodeRun row is now
terminal. The last node to flip the last row terminal wins the CAS and
writes the aggregated final status.

```ts
// dagDispatch.ts
const TERMINAL = new Set(["SUCCESS", "FAILED", "CANCELLED"]);

export async function tryFinaliseWorkflowRun(workflowRunId: string): Promise<boolean> {
  const rows = await prisma.nodeRun.findMany({ where: { workflowRunId }, select: { status: true, error: true } });
  if (rows.length === 0) return false;
  if (!rows.every((r) => TERMINAL.has(r.status))) return false;

  const failed = rows.filter((r) => r.status === "FAILED" || r.status === "CANCELLED").length;
  const ok = rows.filter((r) => r.status === "SUCCESS").length;
  const finalStatus = failed === 0 ? "SUCCESS" : ok === 0 ? "FAILED" : "PARTIAL";
  const firstError = rows.find((r) => r.error)?.error ?? null;

  // CAS: only one concurrent caller wins the UPDATE.
  const claim = await prisma.workflowRun.updateMany({
    where: { id: workflowRunId, status: "RUNNING" },
    data: { status: finalStatus, finishedAt: new Date(), error: firstError },
  });
  return claim.count === 1;
}
```

```ts
// nodeRunner.ts — called from every exit path
await tryFinaliseWorkflowRun(workflowRunId); // success path
await tryFinaliseWorkflowRun(workflowRunId); // catch path (after cancelDescendants)
await tryFinaliseWorkflowRun(workflowRunId); // onFailure hook (after cancelDescendants)
```

**Watchdog** (which the orchestrator's poll loop's iteration cap used
to provide) moves to a separate scheduled task,
`src/trigger/janitor.ts`:

```ts
export const workflowJanitorTask = schedules.task({
  id: "workflow-janitor",
  cron: "*/5 * * * *",
  run: async () => {
    const stuck = await prisma.workflowRun.findMany({
      where: { status: "RUNNING", startedAt: { lt: tenMinutesAgo() } },
    });
    for (const run of stuck) {
      await prisma.nodeRun.updateMany({
        where: { workflowRunId: run.id, status: { in: ["QUEUED", "RUNNING"] } },
        data: { status: "CANCELLED", finishedAt: new Date(), error: "workflow timed out (janitor)" },
      });
      await tryFinaliseWorkflowRun(run.id);
    }
  },
});
```

Catches the rare case where a worker crashes in a way that bypasses
both its own try/catch and the `onFailure` hook (host crash,
infrastructure failure mid-write). Cron every 5 minutes; threshold 10
minutes — happy-path workflows finish in under 60 s, the orchestrator's
own `maxDuration` is 60 s, and node-runner's is 90 s. The janitor
almost always finds nothing.

**Trade-offs accepted in Attempt 8.**

- **No more orchestrator metadata `progress: X/Y`** — there's nothing
  polling to update it. Realtime + the Trigger dashboard's per-task
  status is the new view; metadata is set only at setup-time
  (`totalNodes`, `rootCount`).
- **Race-coverage relies on Postgres CAS twice** — once on each
  `tryClaimNodeRun` (to prevent double-trigger), once on
  `tryFinaliseWorkflowRun` (to prevent double-finalise). Both are
  `updateMany` filtered on a status — same primitive, applied to two
  different rows.
- **Orchestrator crash recovery shifts to the `onFailure` hook on
  `runWorkflowTask`**: if setup throws (Postgres connection drops mid-
  loop, say), the hook cancels any non-terminal NodeRuns and calls
  `tryFinaliseWorkflowRun`. Without this hook a crashed orchestrator
  would leave the WorkflowRun stuck until the janitor's 10 min
  threshold; with it, finalisation is sub-second.

Net effect: the orchestrator no longer occupies a worker container for
the duration of a workflow; finalisation is sub-second; ~20 indexed
queries per 60 s workflow are gone; everything else (Realtime, retries,
queue, idempotency, tags, onFailure cascade) is unchanged. The 3 s
polling tail vanishes.

## Architecture

```
┌────────────────────── orchestrator (run-workflow task) ────────────────────┐
│  SETUP-ONLY — returns immediately after firing roots, no polling           │
│  setup:                                                                    │
│    1) loadGraph(workflowId) → nodes/edges from Postgres                    │
│    2) cycle check (Kahn)                                                   │
│    3) buildAdjacency → out (children) + inn (parents) maps                 │
│    4) pre-create N NodeRun rows in QUEUED                                  │
│    5) WorkflowRun = RUNNING                                                │
│    6) metadata.set totalNodes, rootCount                                   │
│  fire roots (no parents in executable set):                                │
│    for each root: tryClaimNodeRun (CAS) → nodeRunnerTask.trigger(...)      │
│  return.                                                                   │
│  onFailure (setup-time crash recovery):                                    │
│    cancel non-terminal NodeRuns, tryFinaliseWorkflowRun                    │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │ .trigger() (fire-and-forget — no wait, no parallel-waits issue)
               ▼
┌──────────────────────────── nodeRunnerTask ────────────────────────────────┐
│  retry { maxAttempts: 3, factor: 2, randomize: true }                      │
│  queue { name: "node-execution", concurrencyLimit: 20 }                    │
│                                                                            │
│  run(payload):                                                             │
│    loadGraph + loadNodeRunIndex + buildParentByEdge                        │
│    switch (node.type):                                                     │
│      "cropImage"     → runCropImage(...)                                   │
│      "gemini"        → runGemini(...)                                      │
│      "requestInputs" → runRequestInputs(...)                               │
│      "input"         → runInput(...)                                       │
│      "response"      → runResponse(...)                                    │
│    on success:                                                             │
│      dispatchReadyChildren — for each child of this node:                  │
│        if all parents SUCCESS:                                             │
│          tryClaimNodeRun (CAS QUEUED → RUNNING)                            │
│          nodeRunnerTask.trigger(child, { tags, idempotencyKey })           │
│      tryFinaliseWorkflowRun ← last-leaf CAS WorkflowRun = final            │
│    on catch:                                                               │
│      cancelDescendants                                                     │
│      tryFinaliseWorkflowRun                                                │
│      throw (apply retry policy)                                            │
│  onFailure (final attempt failed):                                         │
│    mark row FAILED, cancelDescendants, tryFinaliseWorkflowRun              │
└────────────┬───────────────────────────────────────────────────────────────┘
             │
             ▼
   workers (plain async functions, write NodeRun rows directly):
     • runCropImage  — Transloadit /image/resize + 30 s mandatory delay
     • runGemini     — callGemini
     • runRequestInputs / runInput / runResponse — DB-only inline workers
   each starts with a SUCCESS-guard so retries are idempotent.
   permanent 4xx → AbortTaskRunError (rethrowClassified).

┌──────────────── workflowJanitorTask (schedules.task) ──────────────────────┐
│  cron "*/5 * * * *"                                                        │
│  SELECT WorkflowRun WHERE status=RUNNING AND startedAt < now()-10min       │
│  for each stuck:                                                           │
│    UPDATE NodeRun status QUEUED|RUNNING → CANCELLED                        │
│    tryFinaliseWorkflowRun                                                  │
│  Last-resort safety net: catches double-failure modes that bypass both     │
│  worker try/catch AND onFailure hook.                                      │
└────────────────────────────────────────────────────────────────────────────┘
```

Properties this gives us:

- **Children fire the instant their direct parents finish.** No level
  boundary, no atomic batch wait, no waiting on unrelated siblings.
  `gemini-2` starts at T ≈ 8 s once `gemini-1` finishes, even though
  unrelated crops at L1 take until T ≈ 33 s.
- **Trigger v4 compliance**: orchestrator's only suspension is
  sequential `wait.for({ seconds: 3 })`. Dispatcher uses plain
  `.trigger()` (fire-and-forget — never suspends). One pending wait at
  a time, always.
- **Race-safe**: Postgres CAS (`updateMany WHERE status=QUEUED`)
  resolves "who fires the child?" when multiple parents finish near
  simultaneously. Idempotency keys add a second layer at the Trigger
  platform.
- **Failure-isolated**: a failing node fails-fast (`AbortTaskRunError`
  for permanent errors, full retry for transient), and `onFailure`
  cascades CANCELLED to descendants. Orchestrator finalises within ~5 s
  even when a worker container crashes outside its own try/catch.
- **Sidebar invariant**: the History sidebar reads
  `WorkflowRun.nodeRuns` from Postgres. Only worker functions write
  there. Users see per-node-type rows; `node-runner` itself is silent.
- **Live UI**: `useRealtimeRunsWithTag("wfrun:<id>")` over SSE pushes
  state changes to the browser as Trigger sees them; the sidebar
  debounce-refetches our `/runs` endpoint for the rich detail. 5 s
  polling fallback only when SSE is unavailable.
- **Trigger dashboard observability**: filter by tag `wfrun:<id>` to
  see every run for a workflow run. Orchestrator metadata shows
  `progress: 12/30` live.

## Trade-offs we accepted

1. **Three race-safety CAS points instead of one.** `tryClaimNodeRun`
   prevents double-trigger (Attempt 6+); `tryFinaliseWorkflowRun`
   prevents double-finalise (Attempt 8); the orchestrator's
   `onFailure` cleanup CAS prevents stuck setup-time crashes. All use
   the same primitive (`updateMany WHERE status=…`) so the cognitive
   cost is low — but distributed across files. In a single-poll model
   only one writer existed (the orchestrator).
2. **Workflow finalisation responsibility distributed.** Setup happens
   in `runWorkflowTask`; per-node work happens in `nodeRunnerTask`;
   finalisation happens at whichever node-runner finishes last
   (whichever wins the CAS); long-tail crash recovery happens in
   `workflowJanitorTask`. Four places to look for "what determines
   `WorkflowRun.status`" — bigger surface than the previous "one
   orchestrator does all of it."
3. **One shared queue for all node types.** `node-execution` caps
   crop+gemini+inline together. If we ever need per-type quotas (e.g.,
   Transloadit at 5 concurrent, Gemini at 50), we'd split into multiple
   tasks behind multiple queues — but doing so re-introduces the
   parallel-waits constraint at the orchestrator level if we're not
   careful, so it's deferred until there's a real need.
4. **Trigger dashboard noise**: every node maps to one `node-runner`
   run. Filter by the `node:<nodeRunId>` tag to see one specific node's
   history (and its retry attempts). The orchestrator run is now
   short-lived (just setup) so it shows up briefly on the dashboard
   then disappears; the janitor's scheduled runs are visible too.
5. **Workflow JSON is the source of truth, not snapshotted into
   `WorkflowRun`.** If a user edits the workflow mid-run, the
   dispatcher reads the new edges. This is acceptable given runs are
   typically <60 s and editing-during-run is rare; it'd be a 5-line fix
   to add a `graphSnapshot` JSON column on `WorkflowRun` if we ever
   need the guarantee.
6. **Janitor cron grain (5 min) sets the worst-case finalisation
   latency for runs that hit a double-failure** (worker crash that
   bypasses both try/catch and onFailure). Not visible to users at
   our scale; bump the cron if it ever matters.

## Implementation surface

| File | Role |
| --- | --- |
| `src/trigger/runWorkflow.ts` | Orchestrator (**setup-only**). Pre-creates rows, fires roots with `buildChildTriggerOptions(...)`, returns immediately. `onFailure` hook handles setup-time crashes by cancelling non-terminals + finalising. `maxDuration: 60`. |
| `src/trigger/nodeRunner.ts` | The single Trigger task. `retry: { maxAttempts: 3, ... }`, `queue: { name: "node-execution", concurrencyLimit }`, `onFailure` hook. Calls `tryFinaliseWorkflowRun` on every exit path. `buildChildTriggerOptions` helper for tags + idempotency. |
| `src/trigger/janitor.ts` | `workflowJanitorTask` (`schedules.task`, `cron */5 * * * *`). Force-finalises `WorkflowRun`s stuck in RUNNING for >10 min. |
| `src/trigger/dagDispatch.ts` | `loadGraph`, `tryClaimNodeRun` (per-NodeRun CAS), `dispatchReadyChildren`, `cancelDescendants`, `buildParentByEdge`, `nodeRunRowToOutput`, **`tryFinaliseWorkflowRun`** (per-WorkflowRun CAS). Pure functions — no Trigger SDK imports. |
| `src/trigger/inlineNodes.ts` | Plain async worker functions for the no-network types: `runRequestInputs`, `runInput`, `runResponse`, plus `buildResponseInputs`. |
| `src/trigger/cropImage.ts` | Exports `runCropImage`. SUCCESS-guard at top, mandatory 30 s artificial delay, `rethrowClassified` for AbortTaskRunError gating. |
| `src/trigger/gemini.ts` | Exports `runGemini`. Same shape as `runCropImage`. Stores `imageUrls` on `input` (omitted when empty). |
| `src/lib/triggerErrors.ts` | `isPermanentError` / `rethrowClassified`. Pattern-matches Transloadit + Gemini error messages → `AbortTaskRunError` for 4xx-shaped failures. |
| `src/lib/dag.ts` | `buildAdjacency`, `topoSort` (Kahn), `hasCycle`, `upstreamClosure`. |
| `src/app/api/workflows/[id]/run/route.ts` | `auth.createPublicToken` + `tasks.trigger` with tags + idempotencyKey. Returns `{ runId, triggerRunId, publicAccessToken, realtimeTag }`. |
| `src/app/api/workflows/[id]/runs/[runId]/token/route.ts` | Refresh `publicAccessToken` for long-running runs. |
| `src/components/canvas/WorkflowCanvas.tsx` | Captures `realtimeTag` + `publicAccessToken` from the launch response, threads to `HistorySidebar`. |
| `src/components/canvas/HistorySidebar.tsx` | `useRealtimeRunsWithTag(realtimeTag, { accessToken })` + debounced 250 ms refetch on update + 5 s `setInterval` fallback. |

## When you'd reach for a different shape

- **Streaming Gemini output** (token-by-token rendering on the canvas) —
  use `streams.define` inside `runGemini` and `useRealtimeStream` on the
  Gemini node card. The recursive-dispatch shape is unaffected; streams
  are an orthogonal observability primitive.
- **More executable node types** (e.g., a video-encode node) — add a
  `case` to `nodeRunner.executeWorker` + a worker file (`runVideo.ts`).
  No orchestrator change required.
- **Pre-`runWorkflowTask` graph mutation guarantee** — if mid-run
  workflow edits become a real concern, snapshot `workflow.nodes` /
  `workflow.edges` to a `WorkflowRun.graph` JSON column at orchestrator
  setup, and have `loadGraph` read that instead of the live `Workflow`
  row.
- **Truly large fan-outs** (>20 simultaneous external API calls
  saturating Transloadit/Gemini quotas) — bump
  `NODE_RUNNER_CONCURRENCY` if the provider can take it, or split crop
  vs gemini into separate Trigger tasks behind named queues with
  per-API quotas. The recursive-dispatch shape doesn't depend on a
  single dispatcher task — it just happens to fit one cleanly.
- **Sub-second workflow finalisation** (the 3 s polling tail bothers
  you) — switch to fire-and-forget orchestrator + last-leaf finaliser.
  Trades the polling cost for a "who's last?" CAS race. Not currently
  on the roadmap because Realtime already gives the user sub-second
  updates on individual nodes; the orchestrator's 3 s tail to flip
  `WorkflowRun.status` is invisible.

## References

- Trigger.dev v4 docs — `tasks` / `triggerAndWait` /
  `batchTriggerAndWait` / parallel-waits constraint, restated in the
  project's `CLAUDE.md`.
- Trigger.dev Realtime — `auth.createPublicToken`,
  `useRealtimeRunsWithTag`, scopes documentation.
- Trigger.dev tags + idempotency keys docs — option shape on
  `tasks.trigger(..., options)` and `task.trigger(..., options)`.
- PRD §"Expected execution behaviour": "Crop #1, Crop #2, and Gemini #1
  all start at T=0 (same DAG level → concurrent fan-out)" — satisfied
  by the recursive-dispatch model since there's no level boundary at
  all.
- PRD §"MANDATORY 30+ second artificial delay on Crop Image": preserved
  inside `runCropImage`, after the Transloadit assembly resolves.
- The conversation history for the recursive-dispatch + Trigger
  best-practices rounds lives in this repo's session transcripts; see
  the README's "Sequence flow — before and after" section for the
  user-facing summary.
