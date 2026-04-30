# NextFlow

A pixel-perfect clone of [Galaxy.ai](https://galaxy.ai)'s workflow builder, focused on LLM workflows powered by Google Gemini and orchestrated through Trigger.dev.

> 🌐 **Live**: [next-flow.vishalkumarroy.xyz](https://next-flow.vishalkumarroy.xyz/)

Drag nodes onto a React Flow canvas, wire them together, click Run, and watch a real DAG execute on Trigger.dev workers — Gemini calls, Transloadit-backed image cropping, type-safe edges, history sidebar, the whole thing.

---

## What's in the box

- **Visual canvas** — React Flow + Zustand, nodes drag, edges have type-checked handles, sticky notes, undo/redo, multi-select, autosave, keyboard shortcuts, minimap with per-type colours.
- **Six executable node types** — Request-Inputs (multi-field), single-field Input, Crop Image, Gemini (3.1 Pro / 3 Flash / 3.1 Flash Lite / 2.5 Pro / 2.5 Flash), Response (per-edge labelled cards), Sticky Note.
- **Real DAG execution** — every workflow runs as a Trigger.dev v4 job. Same-DAG-level nodes fan out concurrently via a single `node-runner` dispatcher task (see [`docs/dag-concurrency.md`](./docs/dag-concurrency.md) for the long-form story).
- **Type-safe connections** — text/number/boolean/image/audio/video/file handles, colour-coded across the canvas (orange = text, pink = number, cyan = image, indigo = video, violet = audio, zinc = file, green/orange for response/result). Edges preview their type colour while dragging.
- **First-class file uploads** — anything dropped on a node hits Transloadit immediately. Workflow JSON in Postgres only stores compact CDN URLs, never base64 blobs.
- **Image cropping** — Crop nodes call Transloadit's `/image/resize` robot with a percentage geometry box. Live cutout overlay on the input image preview reflects the slider values in real time.
- **Run history sidebar** — per-run timeline of NodeRun rows with status icons, durations, errors, and per-edge result preview on the Response node (with copy + download buttons for image results).
- **Per-node + full-flow Run** — kick off a single node or the whole DAG. Run buttons cross-disable while any run is in flight so you can't queue competing runs. Optimistic local state means the spinner shows the moment you click, not after Trigger.dev's worker picks up the task.

---

## Tech stack

| Layer | Tool |
| --- | --- |
| Framework | Next.js 16 (App Router, RSC, Turbopack) |
| Language | TypeScript (strict) |
| Database | PostgreSQL on Neon (via Vercel Marketplace) |
| ORM | Prisma 6 |
| Auth | Clerk (production instance with custom domain) |
| Canvas | React Flow 11 + Zustand 5 |
| Workers | Trigger.dev v4 (cloud) |
| File CDN + image ops | Transloadit |
| LLM | Google AI Studio (`@google/generative-ai`) |
| Styling | Tailwind CSS v4 |
| Validation | Zod |
| Icons | Lucide |

---

## Architecture in one diagram

```
┌─────────────┐       /api/workflows/[id]/run        ┌────────────────────┐
│   Browser   │ ───────────────────────────────────► │  Vercel function   │
│  (Next.js)  │                                       │  (Node runtime)    │
└─────────────┘                                       └─────────┬──────────┘
       ▲                                                        │
       │      poll /api/runs/[runId]                            │ tasks.trigger("run-workflow")
       │                                                        ▼
       │                                              ┌────────────────────┐
       │                                              │  Trigger.dev cloud │
       │                                              │  ┌───────────────┐ │
       │                                              │  │ run-workflow  │ │  orchestrator
       │                                              │  └───────┬───────┘ │
       │                                              │          │ batchTriggerAndWait per DAG level
       │                                              │          ▼          │
       │                                              │  ┌───────────────┐ │
       │                                              │  │  node-runner  │ │  dispatcher
       │                                              │  └───────┬───────┘ │
       │                                              │          │          │
       │                                              │   runCropImage()    │  worker fns
       │                                              │   runGemini()       │
       │                                              └──────┬─────────────┘
       │                                                     │
       │     reads NodeRun rows                              ▼
       │   ◄───────────────────────────────────  ┌──────────────────────┐
       └──────────────────────────────────────── │  Postgres (Neon)     │
                                                 │  WorkflowRun, NodeRun│
                                                 └──────────────────────┘

         ┌──────────────────────┐
         │  Transloadit         │  ← /api/uploads streams buffers here
         │  CDN + image robots  │  ← Crop task assemblies here
         └──────────────────────┘
```

The orchestrator walks the DAG topologically and collapses every executable node at a level into one `nodeRunnerTask.batchTriggerAndWait(...)` call — the discriminated payload (`{ kind: "crop" | "gemini" } & …`) lets the dispatcher route each item to the right worker function. From the orchestrator's view that's a single pending wait (Trigger v4 happy); on the worker side, mixed-type siblings actually start at T = 0.

Long-form deep dive: [`docs/dag-concurrency.md`](./docs/dag-concurrency.md). Production deploy runbook: [`DEPLOYMENT.md`](./DEPLOYMENT.md).

---

## Getting started locally

### Prerequisites

- Node 20+ (Vercel deploys on 22; both work locally).
- A Postgres URL — either Neon's free tier or a local Postgres instance. The schema expects two URLs (pooled + direct); local Postgres can use the same string for both.
- Clerk dev instance (publishable + secret keys).
- Trigger.dev account + project ref.
- Google AI Studio API key.
- Transloadit auth key + secret.

### Install

```bash
git clone https://github.com/<your-fork>/NextFlow.git
cd NextFlow
npm install                       # postinstall runs `prisma generate`
```

### Configure env

Copy `.env.example` to `.env.local` and fill in:

```ini
# ─── Database (Neon Postgres or local) ─────────────────────────────────────
PRISMA_DATABASE_URL=postgresql://…?sslmode=require   # pooled / runtime
POSTGRES_URL=postgresql://…                           # direct / migrations

# ─── Clerk auth ────────────────────────────────────────────────────────────
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_…
CLERK_SECRET_KEY=sk_test_…
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/dashboard

# ─── Trigger.dev ───────────────────────────────────────────────────────────
TRIGGER_SECRET_KEY=tr_dev_…
TRIGGER_PROJECT_REF=proj_…

# ─── LLM + file storage ────────────────────────────────────────────────────
GOOGLE_GENERATIVE_AI_API_KEY=AIza…
TRANSLOADIT_AUTH_KEY=…
TRANSLOADIT_AUTH_SECRET=…

# ─── Cosmetic ──────────────────────────────────────────────────────────────
CANDIDATE_LINKEDIN_URL=https://www.linkedin.com/in/your-profile/
```

### Migrate

```bash
npx prisma migrate deploy
```

### Run

You need three processes for a complete dev loop:

```bash
# 1. Next.js
npm run dev                       # http://localhost:3000

# 2. Trigger.dev local worker (in another terminal)
npm run trigger:dev

# 3. (Optional) Prisma Studio for poking at workflow rows
npm run db:studio
```

Sign in via Clerk, hit **New Workflow**, drag a Crop and a Gemini in from the bottom-center picker, click **Run flow**, watch the History sidebar live-update.

---

## Project structure

```
src/
├─ app/
│  ├─ (app)/                  authenticated routes (dashboard, /workflows/[id])
│  ├─ (auth)/                 sign-in / sign-up Clerk flows
│  ├─ api/                    REST endpoints (workflows CRUD, runs, uploads)
│  └─ layout.tsx              root layout, ClerkProvider, LinkedinAttribution
├─ components/
│  ├─ canvas/                 ReactFlow wrapper, toolbar, picker, sidebar, edges
│  ├─ nodes/                  RequestInputs, Crop, Gemini, Response, Input, StickyNote
│  └─ CopyButton.tsx          shared copy-to-clipboard button
├─ lib/
│  ├─ handleColors.ts         single source of truth for handle/edge colours
│  ├─ handles.ts              type-safe connection validation
│  ├─ uploadFile.ts           client → /api/uploads helper
│  ├─ transloadit.ts          server-side Transloadit SDK wrappers
│  ├─ gemini.ts               server-side Gemini SDK wrapper (with model alias map)
│  ├─ connectedValues.ts      orchestrator-style resolvers reused on the canvas
│  └─ prisma.ts               singleton Prisma client
├─ store/
│  └─ useWorkflowStore.ts     Zustand store: nodes, edges, history, run status
├─ trigger/
│  ├─ runWorkflow.ts          orchestrator (DAG levels + node-runner batches)
│  ├─ nodeRunner.ts           dispatcher Trigger task
│  ├─ cropImage.ts            runCropImage worker fn
│  ├─ gemini.ts               runGemini worker fn
│  ├─ requestInputs.ts        type-only (orchestrator inlines)
│  └─ response.ts             type-only (orchestrator inlines)
└─ middleware.ts              Clerk auth gate

prisma/
└─ schema.prisma              Workflow, WorkflowRun, NodeRun

docs/
└─ dag-concurrency.md         postmortem + design doc on the executor

DEPLOYMENT.md                 Vercel + Trigger.dev + Clerk runbook
trigger.config.ts             Trigger.dev build config (prismaExtension)
```

---

## Deploying

[`DEPLOYMENT.md`](./DEPLOYMENT.md) is the click-by-click runbook — Vercel project setup, the two URLs Neon injects, Clerk production keys, separate `npm run trigger:deploy`, sharp / Transloadit constraints, common foot-guns. The short version:

```bash
# 1. Trigger.dev cloud (do this BEFORE Vercel — otherwise the first run 404s)
npm run trigger:deploy

# 2. Provision Neon via Vercel Marketplace + run migrations
npx prisma migrate deploy

# 3. Push to main; Vercel auto-builds
git push origin main
```

Make sure all the env vars from `.env.local` are also set on:
- Vercel (Settings → Environment Variables → Production)
- Trigger.dev (project → Production env → Environment Variables)

The two services don't share secrets.

---

## Notable design decisions

- **Trigger v4 forbids `Promise.all` around `triggerAndWait`** — the orchestrator instead uses a single mixed-type batch per DAG level via a `node-runner` dispatcher. See [`docs/dag-concurrency.md`](./docs/dag-concurrency.md) for the iteration history (eager-IIFE, strict sequential, per-type batches, dispatcher) and why each shape failed before this one.
- **Image cropping uses Transloadit's `/image/resize` (ImageMagick), not `/video/encode` (FFmpeg).** `/video/encode` is FFmpeg-backed and the natural fit for a "FFmpeg crop", but it trips `VIDEO_ENCODE_VALIDATION` on most preset combinations for image inputs. ImageMagick is the platform-native path for image crops.
- **Mandatory 30 s artificial delay on Crop** is preserved (PRD requirement). It lives inside `runCropImage`, after the Transloadit assembly resolves.
- **Inline node types** — Request-Inputs, single-field Input, Response, Sticky Note — write directly to the `NodeRun` table from the orchestrator without going through Trigger. They're typically alone at their DAG level and run in tens of milliseconds; routing them through the dispatcher would only add ~1–2 s of scheduling overhead.
- **The History sidebar deliberately doesn't show `node-runner` rows**. The dispatcher writes nothing to the `NodeRun` table — only the worker functions it calls do, with their canonical `nodeType` ("cropImage", "gemini", …). Trigger.dev's cloud dashboard still surfaces the dispatcher runs for debugging.
- **Files never live as base64 in Postgres**. Every upload streams through `/api/uploads` → Transloadit → CDN URL stored on the node. Workflow JSON stays in the kilobyte range.

---

## License

MIT.
