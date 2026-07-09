# ADR-007: Pipeline / workflow visualisation in the ops UI

**Status:** PROPOSED 2026-07-09
**Date:** 2026-07-09
**Author agent:** claude-opus-4-8

---

## Context

The ops UI renders a `PipelineExecution` (see `src/data/pipeline-repo.ts`) as a
flat step list. Two renderers exist in `public/app.js`:

- `renderExecutions(assetId, container)` (app.js ~L158) — a `mini-table` with one
  row per `StepExecution`: `s.name`, a coloured `s.status`, and `s.error` if present.
- `renderPipeline(stages)` (app.js ~L207) — a reusable horizontal row of
  `pipeline-node` chips joined by `→` arrows. It accepts a stateless array of
  `{ label, status, detail }` and maps status onto the CSS classes
  `pipeline-node--<status>` / `pipeline-badge--<status>` over the fixed status set
  `['pending','running','completed','failed','warning']`. The job-detail body
  (`renderJobDetailBody`, app.js ~L1246) builds nodes from `matchedExec.steps` and,
  for a running `transcode` step, injects `job.progress + '%'` into the node's
  `detail` string (app.js ~L1354). `buildTranscodePipeline(job, asset)` (app.js
  ~L267) is the legacy fallback diagram.

This is adequate for the pipelines that ship today but does not scale. The forces:

1. **Dependency-free vanilla-JS ops UI — the hard constraint.** `public/index.html`
   loads the UI as a single `<script type="module" src="app.js">`. There is no
   bundler, no build step, no framework, and no npm runtime dependency for the
   frontend. Any option that requires React, JSX, a bundler, or an npm graph would
   introduce a build toolchain where none exists — a structural change far larger
   than the feature it serves.

2. **The self-polling detail view (issue #127).** `renderAssetDetailBody` /
   `renderJobDetailBody` are the reusable detail renderers, re-invoked on every
   `DETAIL_POLL_INTERVAL_MS` (5000 ms, app.js L83) tick — in the embedded main
   window and in the standalone `detail.html` (`detail.js` L146). Each tick clears
   `bodyEl` and re-renders from freshly fetched data. **The viz must therefore be a
   stateless render-from-data component** with no internal machine, subscription, or
   retained animation state that a full re-render would orphan.

3. **Linear today, heading toward branching.** `PIPELINE_STEPS` is
   `['extract-metadata','thumbnail','subtitles','scene-detect','transcode','package']`
   and `BUILT_IN_PIPELINES` are ordered arrays (e.g. `full` runs all six in
   sequence). But the model is *conceptually* a light DAG: `extract-metadata`,
   `thumbnail`, `subtitles`, and `scene-detect` are independent and could run in
   parallel, while `transcode → package` is a genuine dependency chain. `steps` is a
   flat `StepExecution[]` with no edge/parent field yet, so branching is a future
   data-model change, not a today concern.

4. **Async vs fire-and-forget steps + in-step progress.** Per `pipelines.ts`,
   `extract-metadata` / `thumbnail` / `subtitles` / `scene-detect` are fire-and-forget
   and settle immediately; `transcode` and `package` are async, advanced later by
   OSC callbacks (`src/routes/internal.ts`). A `StepExecution` for a transcode step
   carries `jobId` (internal job repo id) and `encoreJobId`. The **in-step progress
   percentage does not live on the step** — it lives on the linked `Job`: `Job.progress`
   is the `0..100` field (`src/data/job-repo.ts` L46), populated for `transcode` jobs
   from Encore callbacks. The viz reaches it by matching `StepExecution.jobId` to
   `Job.id` (exactly the `s.jobId === job.id` correlation already done at app.js
   L1342), then reading `job.progress`.

The problem to solve: a visualisation that (a) shows per-step status
(pending/running/done/failed) at a glance, (b) shows in-step progress for the
running transcode/package step, (c) can express parallel/branched rows when the
model grows there, and (d) does all of this without breaking the no-build,
stateless-re-render constraints.

---

## Options considered

Every option is judged first against the dependency-free constraint, then on
parallel/branching support and in-step progress.

| Option | Deps / build cost | Fit with no-build vanilla UI | Parallel / branching | In-step progress | Stateless re-render |
|---|---|---|---|---|---|
| **(a) React Flow** | React + ReactDOM + reactflow + a bundler (esbuild/vite). New npm graph + build step. | Poor. Forces a framework + toolchain into a UI that has neither. Contradicts force #1. | Excellent — native node/edge DAG, pan/zoom. | Custom node component can host a bar; needs React state discipline. | React's own render model; must reconcile against 5 s hard re-renders — awkward. |
| **(b) XState visualizer / `@xstate/inspect`** | `xstate` + inspector; inspector is a dev/debug tool, not a production embed. | Poor. Designed to visualise a *state machine*, but our pipeline is data (`StepExecution[]`), not an xstate machine. Would require modelling pipelines as machines first. | Shows machine graphs, not data-driven step arrays. | Not a progress-bar tool. | Inspector holds a live actor subscription — the opposite of stateless. |
| **(c) Custom CSS/SVG step component (dependency-free)** | Zero. Pure DOM + CSS, same pattern as existing `renderPipeline`. | Excellent — extends the code that is already there (`pipeline-node` classes, `renderPipeline`). No toolchain change. | Achievable: render steps as rows; independent steps as stacked/branched rows; SVG or CSS connectors for edges. Arbitrary free-form DAG layout is the weak spot. | Trivial — a `<div class="progress-bar">` sized from `job.progress`, inside the running node. | Native — it *is* a pure function of the data array; re-render on each poll tick is free. |
| **(d) Client-side workflow-diagram lib (mermaid / dagre-d3, no framework)** | mermaid or `dagre-d3` (+ d3) as a browser ESM import (e.g. via a pinned `<script type="module">` from a vendored file or import map). No React, but a real third-party lib + its transitive graph. | Moderate. Can run without a bundler as an ESM/UMD import, but adds a sizeable dependency and a layout engine for a problem that is linear today. | Excellent — dagre does true DAG auto-layout; mermaid renders `flowchart`/`stateDiagram` from a text string. | Not native — mermaid/dagre draw the graph; a live progress bar inside a node must be layered on with custom DOM/SVG post-render, which fights the library's own rendering. | mermaid re-parses a string each render (stateless-friendly); dagre needs a re-layout each tick (cheap for <10 nodes but wasteful). |

Notes and honesty flags:

- Options (a), (b), (d) are assessed **from general knowledge of these OSS tools**,
  not from a pinned version verified in this session. React Flow, XState, mermaid,
  dagre-d3, and d3 are all mature open-source projects, but exact APIs, ESM/no-build
  entry points, and transitive-dependency footprints **must be version-verified
  before adoption** — especially any claim that a lib runs "without a bundler."
- (b) is effectively disqualified by a category mismatch: our pipeline is a data
  record, not an xstate machine. Adopting it would mean re-architecting the pipeline
  engine to be xstate-driven purely to get a diagram — the tail wagging the dog.
- (d) `mermaid` is attractive as a *future* escape hatch for true arbitrary DAGs
  because it renders from a text string (`renderExecutions` could emit mermaid
  `flowchart` syntax stateless-ly). Its weakness is precisely the feature we need
  most now: a live progress bar inside a node.

---

## Decision

**Adopt option (c): a custom, dependency-free CSS/SVG step-progress component**,
implemented as an evolution of the existing `renderPipeline` / `renderExecutions`
code rather than a new subsystem.

Rationale:

1. **It is the only option that honours the hard constraint.** The ops UI's
   defining property is that it ships with no build step and no frontend
   dependencies (force #1). (a) and (d) both break that; (b) is a category mismatch.
   The cost of a bundler+framework is not justified by a feature whose data model is
   linear today and light-DAG at most tomorrow.

2. **It matches what the code already does.** `renderPipeline(stages)` is already a
   stateless pure function over a `{label,status,detail}[]` array using the
   `pipeline-node--<status>` CSS vocabulary. The step chips, colour map, and
   `→` connectors exist. This decision extends that surface (add a progress bar
   inside the running node; add a row-stacking layout mode for parallel groups; add
   an SVG connector layer for branches) instead of importing a second way to draw
   the same thing.

3. **It is stateless by construction**, satisfying force #2. The component is a pure
   function of `PipelineExecution.steps` (plus the correlated `Job.progress`); a full
   re-render every `DETAIL_POLL_INTERVAL_MS` is correct and cheap. No machine, no
   subscription, no orphaned animation.

4. **In-step progress is native.** A running `transcode`/`package` node embeds a
   `<div class="step-progress-bar" style="width:${job.progress}%">` sized from the
   correlated `Job.progress` (reached via `s.jobId === job.id`, already computed at
   app.js L1342). Fire-and-forget steps show no bar and settle to `done`/`failed`.

5. **Branching is expressible without a layout engine.** Because the future model is
   a *shallow* DAG (a small parallel fan-out over independent metadata/thumbnail/
   subtitle/scene steps, then a linear transcode→package tail), a hand-rolled
   "parallel group = stacked rows joined by a fork/join connector" is sufficient. We
   do not need dagre's general auto-layout for graphs this shallow.

**Escape hatch:** if pipelines later gain *arbitrary, user-defined* DAG branching
(deep graphs, cross-edges, cycles), revisit and adopt a client-side layout lib —
`mermaid` (stateless string render) preferred over React Flow because it preserves
the no-build property. This ADR does not adopt it now; it names it as the trigger
condition (see Consequences).

---

## Layout sketch of the job/asset detail view

The pipeline is rendered inside the detail body produced by `renderJobDetailBody` /
`renderAssetDetailBody`, under the existing `Pipeline` section title (app.js ~L1345).
Steps use the real names from `PIPELINE_STEPS`.

### Linear pipeline (e.g. `abr-vod` = transcode → package), transcode running

```
Pipeline
┌──────────┐   ┌──────────────────────────┐   ┌──────────┐
│  Upload  │──▶│  transcode               │──▶│  package │
│  ✔ done  │   │  ⟳ running               │   │  · pending│
└──────────┘   │  [■■■■■■■■□□□□□□□□] 42%   │   └──────────┘
               └──────────────────────────┘
   green            amber + progress bar          grey
```

### Full pipeline (`full`) — parallel metadata group, then transcode → package

Independent fire-and-forget steps drawn as **stacked rows** inside a fork/join
bracket; the async transcode→package tail is a linear chain.

```
Pipeline
                 ┌───────────────────────┐
             ┌──▶│ extract-metadata ✔done│──┐
             │   ├───────────────────────┤  │
┌──────────┐ │  ▶│ thumbnail        ✔done│  │  ┌────────────┐   ┌──────────┐
│  Upload  │─┤   ├───────────────────────┤  ├─▶│ transcode  │──▶│ package  │
│  ✔ done  │ │  ▶│ subtitles      ⟳ run  │  │  │ · pending  │   │ · pending│
└──────────┘ │   ├───────────────────────┤  │  └────────────┘   └──────────┘
             └──▶│ scene-detect   ✘ failed──┘
                 │   "eyevinn-function-  │
                 │    scenes timed out"  │
                 └───────────────────────┘
      fork ────────── parallel group ────────── join ──── linear tail
```

### Status vocabulary (maps `StepExecution.status` → node class)

| `StepExecution.status` | Node glyph / colour | CSS class (existing) |
|---|---|---|
| `pending` | `·` grey | `pipeline-node--pending` |
| `running` | `⟳` amber (+ progress bar if `jobId`→`job.progress`) | `pipeline-node--running` |
| `done` | `✔` green | `pipeline-node--completed` |
| `failed` | `✘` red, `s.error` shown inline below node | `pipeline-node--failed` |

- **In-step progress:** shown only for the `running` transcode/package node, as a
  bar sized from the correlated `Job.progress` (0..100). Fire-and-forget steps have
  no bar.
- **Failed-step affordance:** the failed node turns red and renders `s.error` (the
  `StepExecution.error` string) inline beneath it — same data `renderExecutions`
  already surfaces at app.js L192, now attached to the node instead of a table cell.

---

## Implementation-effort estimate

Small effort overall; this is an evolution of existing code, not a new subsystem.
No backend or API change is required for the linear + in-step-progress milestone —
all data already exists (`StepExecution`, `Job.progress`). Branching is the only
part that needs a data-model addition, and it is deferred.

| Phase | Scope | Touches | Effort |
|---|---|---|---|
| 1. Progress bar in running node | Add a `step-progress-bar` div + CSS; size from correlated `Job.progress` via the existing `s.jobId === job.id` match. | `renderPipeline` (app.js ~L207), the node-build block in `renderJobDetailBody` (~L1350–L1358), `style.css` | **S** (~0.5–1 day) |
| 2. Failed-step affordance | Render `s.error` inline under a `--failed` node; align asset and job renderers. | `renderPipeline`, `renderExecutions` (app.js ~L158), `style.css` | **S** (~0.5 day) |
| 3. Consolidate renderers | Have `renderExecutions` build via `renderPipeline` node arrays so asset-detail and job-detail share one stateless component; verify clean re-render on each `DETAIL_POLL_INTERVAL_MS` tick. | `renderExecutions`, `renderAssetDetailBody` (~L716), `renderJobDetailBody` (~L1246) | **M** (~1 day) |
| 4. Parallel-group layout | Add a "stacked rows + fork/join connector" render mode (CSS grid + a thin SVG/CSS connector layer). Grouping is derived (independent metadata/thumbnail/subtitle/scene steps) until a model field exists. | `renderPipeline` (new layout branch), `style.css` | **M** (~1.5–2 days) |
| 5. (Deferred) Branch data model | Add an explicit dependency/group field to `StepExecution` (e.g. `dependsOn?: PipelineStepName[]` or `group?: string`) so branching is data-driven, not inferred. Gated on a real branching pipeline existing. | `src/data/pipeline-repo.ts` (`StepExecution`), `src/pipeline/pipelines.ts`, `src/routes/internal.ts` (advancement) | **M/L** (deferred) |

Recommended first slice: **phases 1–3** deliver the highest-value change (real
in-step transcode progress + a single consolidated stateless component) at **S–M /
~2–3 days**, with zero new dependencies and no backend change. Phase 4 lands the
parallel layout once `full`-pipeline visualisation is prioritised. Phase 5 is
deferred until the pipeline model actually branches.

---

## Consequences

**Positive:**

- Preserves the ops UI's defining property: no build step, no bundler, no frontend
  dependency graph. Onboarding and the `detail.html` popout stay trivial.
- The viz is a pure function of `PipelineExecution.steps` + correlated `Job.progress`,
  so it re-renders correctly on every `DETAIL_POLL_INTERVAL_MS` tick with no state
  management — aligned with the #127 self-polling refactor.
- One rendering path for asset-detail and job-detail (phase 3) removes the current
  split between the `renderExecutions` mini-table and the `renderPipeline` chips.
- Real in-step transcode progress in the UI, sourced from the already-populated
  `Job.progress` field — no new API surface.

**Negative / trade-offs:**

- We own the layout code. A hand-rolled fork/join connector is fine for shallow
  parallel groups but is **not** a general graph-layout engine. Deep or arbitrary
  DAGs would strain it — that is the deliberate boundary of this decision.
- Grouping in phase 4 is *inferred* from step semantics until phase 5 adds a data
  field. Inference is a stopgap; a branching pipeline authored outside the current
  built-ins could render its parallelism wrongly. Phase 5 removes this risk.
- SVG connector maths for stacked rows is fiddly to get pixel-clean across viewport
  widths; budget review time in phase 4.

**Migration path:** phases 1–4 are additive to `renderPipeline`; no data migration.
Phase 5 adds an optional field to `StepExecution` (`InMemoryPipelineRepository` is
ephemeral, so no stored-document migration is needed either).

**When to revisit:** reopen this ADR and re-evaluate option (d) (`mermaid`, staying
no-build) or option (a) (React Flow, accepting a build step) if **any** of the
following becomes true:
1. Pipelines gain arbitrary, user-defined DAG branching (deep graphs, cross-edges,
   or cycles) rather than the current shallow fan-out.
2. `StepExecution` grows explicit edge/graph fields that a general layout engine
   would render more cheaply than hand-rolled connectors.
3. The ops UI adopts a build step for unrelated reasons, removing the constraint
   that makes framework options costly.

**Currency check / contract sources:** all cited symbols were read from the working
tree on 2026-07-09: `PIPELINE_STEPS` / `BUILT_IN_PIPELINES` (`src/pipeline/pipelines.ts`),
`StepExecution` / `PipelineExecution` / `StepStatus` (`src/data/pipeline-repo.ts`),
`Job.progress` / `JobStatus` (`src/data/job-repo.ts`), and
`renderExecutions` / `renderPipeline` / `buildTranscodePipeline` /
`renderJobDetailBody` / `renderAssetDetailBody` / `DETAIL_POLL_INTERVAL_MS`
(`public/app.js`), plus the `detail.js` self-poll wiring. The version, ESM/no-build
entry point, and transitive-dependency footprint of React Flow, XState, mermaid,
dagre-d3, and d3 were assessed from general knowledge and **must be version-verified
before any future adoption**.
