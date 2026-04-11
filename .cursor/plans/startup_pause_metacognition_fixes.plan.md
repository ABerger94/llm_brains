# Startup, pause/resume, metacognition, and Force Output

## Scope (original issues)

1. **First open**: slow/crash — defer/chunk `priorityBackfill`, review `openAndMigrateBrowserStorage` + scheduler startup overlap.
2. **Pause & Save / Resume All** — pursuit checkpoint `last_pursuit_pipeline_run_id` link in [`mindPersistence.js`](f:\Alek\YourBrain\src\lib\mindPersistence.js); pause-request origin/dev:both; optional `slimSharedMemoryForPipelinePost(..., { continuation: true })` on checkpoint resume POST.
3. **Metacognition / max reruns** — server coerce `maxMetacognitionReruns` (avoid string → default 1); fix `pendingRerun && delayMin > 0` gating; optional `maxReruns === 0` + defer → partial + schedule.

---

## 5) Dashboard: "Force Output" on active pipeline cards

### UX

- **Where**: [`Dashboard.jsx`](f:\Alek\YourBrain\src\pages\Dashboard.jsx) — `DashboardActiveWorkSection` list rows. Right-hand column is currently a grid: **Open →** (link) + **Stop** (when `showStop`).
- **Layout**: Change to **three** rows when `showStop`: **Open →** (top), **Force Output** (middle), **Stop** (bottom). Match existing compact styling (`text-[10px]`, ghost/outline button, icons).
- **When shown**: Only for rows that represent a **live** run (same conditions as Stop — not interrupted-only banner rows if inappropriate; hide on checkpoint-only rows if no SSE). Mirror `showStop` / `row.variant` rules; likely **omit** for `graph-pipeline-checkpoint` and **graph-pipeline-interrupted** (nothing to “force through”).
- **Copy**: Tooltip + aria-label explaining: takes effect **after the current module** finishes (same cooperative reality as pause); subsequent legs run **without** metacognition-driven reruns, continuations, or deferred supervisor scheduling — pipeline proceeds **through Voice** in-process.

### Behavior

- **Goal**: From the next pipeline **HTTP leg** onward, ignore Metacognition / Workspace Metacognition **RERUN** paths (including **inline** layer 1–4 reruns, **`pipeline_continuation`**, and **`deferMetacognitionRerun` / partial + `metacognitionRerunPending`**), and do **not** enqueue **`supervisor_pipeline_rerun`** for this run — i.e. **single multi-leg SSE flow** until `complete` with Voice (or error).
- **Server**: Add a boolean on `options`, e.g. `forceCompleteWithoutMetacognitionReruns` (name TBD). In [`server/pipeline.js`](f:\Alek\YourBrain\server\pipeline.js) `runPipeline`, when true, Metacognition / Workspace Metacognition blocks treat **any** `wantsRerun` like **cap-exceeded forced proceed**: emit optional one-line log event if useful, then **continue layer5 toward Voice** (no `runLayers1to4`, no `buildContinuationReturn`, no `finishRun` partial pending for supervisor rerun). Structural “missing outputs” heuristic should **not** trigger a layer 1–4 rerun either while flag is set.
- **Client propagation**: SSE driver must merge this flag into **`options` on every POST** for the run once the user clicks Force Output — including **continuation legs** inside [`consumePipelineSseWithMetacognitionContinuations`](f:\Alek\YourBrain\src\lib\pipelineSse.js) (`buildFetchInit` per `leg`).

### Cross-tab / registry

- Runs already register **`pauseToken`** in [`pipelineActiveRunRegistry.js`](f:\Alek\YourBrain\src\lib\pipelineActiveRunRegistry.js) with `localStorage` mirror for cooperative pause.
- **Pattern**: Add a parallel **force-complete** flag keyed by **pause token** (e.g. `mybrain_force_complete_v1_${token} = '1'`), set from Dashboard when user clicks **Force Output** (resolve token via same peek/registry path used for pause-request for `graph-pipeline-session-*`, curiosity, goal, scheduler if exposed).
- In **`buildFetchInit`** (or a small helper used by [`consciousnessStreamRunner.js`](f:\Alek\YourBrain\src\lib\consciousnessStreamRunner.js), [`runGraphPipelineOneShot.js`](f:\Alek\YourBrain\src\lib\runGraphPipelineOneShot.js), and any scheduler path that uses the same SSE helper): **read** flag for the current leg’s token; if set, add server option and **clear** storage for that token after first application if desired (or clear when run completes).

### Row routing (mirror Stop)

- **`graph-pipeline`**: token from in-memory `graphPipelineStore` / active stream (this tab) or persisted peek for session id on row href.
- **`graph-pipeline-session-{sid}`**: resolve `cooperativePauseToken` from [`peekGraphPipelineUiPersisted`](f:\Alek\YourBrain\src\lib\graphPipelineCrossSessionPeek.js) (same as pause).
- **`curiosity-*` / `goal-*`**: token from pursuit registry / persisted graph merge for that pursuit id.
- **`scheduler-task-*`**: if the task runs **only** on server without a browser-held SSE leg, Force Output may require a **server-side** flag on the task or be **disabled** with tooltip “Open scheduler run” — **decision**: implement for **browser-held** streams first; scheduler headless can be follow-up.

### New / touched files (implementation)

- [`src/pages/Dashboard.jsx`](f:\Alek\YourBrain\src\pages\Dashboard.jsx) — button + grid rows.
- New helper e.g. [`src/lib/cooperativeForceComplete.js`](f:\Alek\YourBrain\src\lib\cooperativeForceComplete.js) — `setForceCompleteForPauseToken`, `consumeForceCompleteForPauseToken`, localStorage keys.
- [`src/lib/pipelineSse.js`](f:\Alek\YourBrain\src\lib\pipelineSse.js) — merge option each leg when flag present.
- [`src/lib/consciousnessStreamRunner.js`](f:\Alek\YourBrain\src\lib\consciousnessStreamRunner.js), [`src/lib/runGraphPipelineOneShot.js`](f:\Alek\YourBrain\src\lib\runGraphPipelineOneShot.js) — pass `pauseToken` into buildFetchInit closure so force flag can be read.
- [`server/pipeline.js`](f:\Alek\YourBrain\server\pipeline.js) — honor `forceCompleteWithoutMetacognitionReruns`.

### Testing

- Start graph run, trigger Metacognition RERUN (or set low cap), click **Force Output** from Dashboard (same or other tab with shared token), confirm **no** second leg restarting at Perception and **no** `supervisor_pipeline_rerun` task; pipeline completes with Voice in one logical run.

---

## Todos (combined)

- startup-defer-backfill
- server-coerce-max-reruns
- client-pending-enqueue
- server-zero-reruns-defer
- resume-pursuit-link
- resume-slim-continuation
- **dashboard-force-output-ui** — Dashboard card layout + click handler
- **force-complete-registry** — localStorage + token wiring
- **pipeline-sse-merge-option** — per-leg options merge
- **server-force-complete-flag** — runPipeline Metacognition branches
