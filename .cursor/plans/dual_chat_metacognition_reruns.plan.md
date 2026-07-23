---
name: Dual chat metacognition reruns
overview: Enable supervisor reruns to complete before Voice during System Chat via chained SSE (deferMetacognitionRerun false on leg 1), with optional quiet UI so intermediate rerun “dialogue” is not surfaced. Reconciled with current repo (Jan 2026).
todos:
  - id: csr-flags
    content: Add playground System Chat option in consciousnessStreamRunner — merge maxReruns floor + delay 0 into snapshot; set deferMetacognitionRerun false on leg 1 when flag set; document JSDoc on startConsciousnessStreamRun
    status: pending
  - id: runner-wire
    content: Pass new flag from playgroundDualGraphRunner on every startConsciousnessStreamRun call (dual turn, A-only, B-only)
    status: pending
  - id: quiet-ui
    content: Optional playground-quiet mode — use buildFetchInit `leg` ref to suppress intermediate stream/meta-calibration noise; verify single ConversationMessage assistant row per completed run
    status: pending
  - id: copy-verify
    content: Optional Playground copy + manual test — RERUN chains to Voice without scheduled supervisor task; respect GraphPipelineMetacognitionLimitsRow overrides
    status: pending
isProject: true
---

# Metacognition reruns in System Chat (dual pipeline) — updated plan

## Reconciliation (recent repo state)

This supersedes the earlier Cursor-generated plan file that lived outside the repo. **Implementation is still pending** for the dual-chat-specific pieces below; the following reflects **current** code as of the last review.

### What already exists (no change needed for the core graph path)

- **[`src/lib/consciousnessStreamRunner.js`](src/lib/consciousnessStreamRunner.js)** already merges **`graphPipelineStore.pipelineMetacognitionOverrides`** into the pipeline snapshot via **`buildPipelineIntegrationOptions({ metacognitionOverrides: pmo })`** (~436–450). The separate plan [`per-run_metacognition_caps_ea49818a.plan.md`](f:/Alek/YourBrain/.cursor/plans/per-run_metacognition_caps_ea49818a.plan.md) describes broader plumbing; its “Reconciliation” section claiming no `pipelineMetacognitionOverrides` is **outdated for the interactive stream path** — the store field exists ([`graphPipelineStore.js`](f:/Alek/YourBrain/src/lib/graphPipelineStore.js) ~52).
- **`buildFetchInit` now receives `leg`** (~471): `async ({ slimSharedMemory, pipelineMetacognitionContinuation, leg }) => { ... }`. Use a ref `currentPipelineLeg = leg` for **quiet-UI** gating (suppress intermediate `appendEntry` / meta-calibration until final leg or until `complete`).
- **System Chat orchestration** lives in [`src/lib/playgroundDualGraphRunner.js`](f:/Alek/YourBrain/src/lib/playgroundDualGraphRunner.js); it still calls **`startConsciousnessStreamRun` with only `forcedUserInput` + `mindStorageProfile`** — **no** metacognition / defer overrides yet.

### What is still the blocker (unchanged logic)

- On **leg 1**, options still include **`deferMetacognitionRerun: true`** whenever `!pipelineMetacognitionContinuation` (~499). That forces **partial complete + `metacognitionRerunPending`** and **scheduled** continuations instead of **chained SSE** inside the same `startConsciousnessStreamRun`.
- **Effective `maxMetacognitionReruns`** can still be **0** from globals; server behavior requires **≥ 1** for real supervisor rework legs before Voice (see [`server/pipeline.js`](f:/Alek/YourBrain/server/pipeline.js) Metacognition branches).

### Orthogonal work — do not confuse

- [`startup_pause_metacognition_fixes.plan.md`](f:/Alek/YourBrain/.cursor/plans/startup_pause_metacognition_fixes.plan.md): **Force Output** / `forceCompleteWithoutMetacognitionReruns` is the **opposite** intent (skip reruns). System Chat metacognition integration must **not** set that flag; ensure options stay distinct.
- [`dual-mind_playground.plan.md`](f:/Alek/YourBrain/.cursor/plans/dual-mind_playground.plan.md): historical; actual Playground now uses **full graph SSE** + mirror stores — treat as archive only.

## Target behavior

For **playground / System Chat** runs only:

1. **`deferMetacognitionRerun: false`** on the **first** HTTP leg (when not already a `pipelineMetacognitionContinuation`), so the server emits **`pipeline_continuation`** and [`consumePipelineSseWithMetacognitionContinuations`](f:/Alek/YourBrain/src/lib/pipelineSse.js) chains until **final `complete` with Voice**.
2. Ensure **effective** `maxMetacognitionReruns >= 1** for those runs (floor against snapshot after overrides, or document that Graph **Metacognition limits** row must be ≥ 1).
3. Set **effective** `metacognitionRerunDelayMinutes` to **0** on the snapshot for immediate chained POSTs (continuation legs ignore “delay” semantics for scheduling).
4. **Quiet transcript (your preference):** optionally skip or reduce `consciousnessStreamStore.appendEntry` / **meta-calibration** lines / verbose **`addGraphExecutionLog`** for **non-final** legs when a playground flag is set; use **`leg`** + “saw `pipeline_continuation`” to avoid showing rerun internals as chat. **ConversationMessage** should remain **one user + one assistant** per finished `startConsciousnessStreamRun` (already the pattern ~875–896).

## Implementation outline

| Step | Action |
|------|--------|
| A | Add `opts.playgroundSystemChatChainedMetacognition` (or similar) to **`startConsciousnessStreamRun`**; when true, merge snapshot: `maxMetacognitionReruns: Math.max(1, eff)`, `metacognitionRerunDelayMinutes: 0`, and **`peerPipelineTurn`** behavior unchanged for mirror. |
| B | In **`buildFetchInit`**, replace unconditional `deferMetacognitionRerun: true` on leg 1 with **false** when (A) is true; continuation legs unchanged. |
| C | Pass (A) from **[`playgroundDualGraphRunner.js`](f:/Alek/YourBrain/src/lib/playgroundDualGraphRunner.js)** on every `startConsciousnessStreamRun`. |
| D | Optional: **`currentStreamLegRef.current = leg`** at start of `buildFetchInit`; in **`onEvent`**, if playground + `leg < final`, skip noisy entries (define precisely: e.g. still show graph module statuses in **`graphPipelineStore`** for the neural panel). |
| E | Short **Playground** hint: Metacognition limits row on Graph panel applies; **max reruns ≥ 1** needed for reruns to run. |

## Verification

- Trigger Metacognition RERUN (or low threshold in test env): expect **multiple** `pipeline_continuation` events, **no** “Supervisor RERUN scheduled in ~N min” toast, **no** `enqueueMetacognitionPipelineRerunSchedule` for that run.
- **Regression:** Default graph pipeline sessions **without** the playground flag keep **`deferMetacognitionRerun: true`** on leg 1.

## Files to touch

- [`src/lib/consciousnessStreamRunner.js`](f:/Alek/YourBrain/src/lib/consciousnessStreamRunner.js) — opts, snapshot merge, `buildFetchInit` defer, optional quiet gating.
- [`src/lib/playgroundDualGraphRunner.js`](f:/Alek/YourBrain/src/lib/playgroundDualGraphRunner.js) — pass flag on all runs.
- [`src/components/Playground.jsx`](f:/Alek/YourBrain/src/components/Playground.jsx) — optional one-line help.
- Unlikely: [`src/lib/pipelineSse.js`](f:/Alek/YourBrain/src/lib/pipelineSse.js) unless you need `leg` on events (prefer ref from `buildFetchInit` first).

## Risks

- **Latency:** Multiple HTTP legs per dual-chat half-turn.
- **`maxLegs`:** Default 25 in `consumePipelineSseWithMetacognitionContinuations` — sufficient unless caps + reruns explode; bump only if observed.
