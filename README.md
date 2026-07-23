# Mind Chain

A small LLM, run entirely inside your browser, walks a single stimulus through
a 22-module cognitive pipeline where each module is mapped to a real
brain-region equivalent (Perception → primary sensory cortices, Emotion →
amygdala/insula, Integration → Global Workspace/Phi under Integrated
Information Theory, and so on), ending in **Voice** — the mind's actual
first-person response. Nothing you type, and nothing the model generates,
ever leaves your device: there is no backend and no API calls once the page
loads.

## How it works

- **Local inference**: [`@mlc-ai/web-llm`](https://github.com/mlc-ai/web-llm)
  runs a quantized model (Llama 3.2 1B/3B or Qwen2.5 1.5B) fully client-side
  via WebGPU. The weights download once from Hugging Face and are cached by
  the browser's Cache API — later visits (including as an installed PWA) load
  from cache.
- **The pipeline**: `lib/mindChain.ts` defines the 22 modules — Perception,
  Attention, Memory, Learning, Temporal Awareness, Planning, Reasoning,
  Emotion, Theory of Mind, Belief Store, Self-Reflection, Identity, Social
  Cognition, Contradiction Engine, Metacognition, Integration, Language,
  Curiosity, Goal Generation, Somatic Marker, Narrative, Voice. Each module is
  a small, focused prompt that only sees the original stimulus plus the
  specific earlier modules it depends on (see each module's `deps`) — not the
  full transcript — so prompts stay short enough for a 1B-3B model's context
  window.
- **Real control flow, not just a linear chain**: `lib/useMindChain.ts`
  implements two modules that can actually redirect the run, not just narrate
  about it:
  - **Contradiction Engine** (module 14) audits modules 1-13 for
    contradictions and can emit up to `CONTRADICTION_ENGINE_MAX_DIRECTIVES`
    (2) `MODULE_RERUN: [Name] — reason` directives, each causing just that
    one module to be re-executed in place with the contradiction appended as
    context.
  - **Metacognition** (module 15) reviews the run and can send modules 1-14
    back for a full fresh pass, up to `METACOGNITION_MAX_RERUNS` (1) time, by
    starting its output with `RERUN`; otherwise it starts with `PROCEED` and
    the run continues to Integration (16) onward.
  - Both are parsed with fail-safe-to-proceed semantics
    (`parseModuleRerunDirectives`/`parseMetacognitionVerdict` in
    `lib/mindChain.ts`): a 1-3B local model won't reliably emit exact
    machine-parseable directives, so anything that doesn't clearly match the
    expected format is treated as "no directive" rather than risking an
    unbounded loop. There's also a hard backstop,
    `MAX_TOTAL_MODULE_CALLS` (45), independent of those caps, in case
    parsing or looping ever behaves unexpectedly.
  - These caps started higher (3 / 4, matching the original design) but were
    lowered after real-device crashes: a full rerun redoes ~15 module calls,
    so the original worst case (~75 sequential calls in one browser tab) was
    enough sustained WebGPU/WASM memory pressure to crash both the installed
    PWA and the browser tab outright, especially on mobile. `runOneStage` in
    `lib/useMindChain.ts` also calls the engine's `resetChat()` between every
    module call — each call is an unrelated single-turn prompt, so there's no
    reason to let internal conversation/KV-cache state accumulate across ~40
    sequential generations in one session. The UI surfaces every triggered
    rerun in a live log so none of this is a silent black box, but a run can
    still take meaningfully longer than 22 model calls when reruns fire.
  - **Integration** (16) is asked to report a IIT-style `PHI: 0.XX` estimate,
    parsed and shown as a Φ badge next to the final output — reported, not
    used to gate anything.
- **Persistent memory**: `lib/memoryStore.ts` keeps this from being a
  stateless one-shot pipeline. It's backed by `localStorage`, so it survives
  reloads and persists across sessions (a "session" = one full pipeline run):
  - **Identity** (module 12) rewrites the persisted first-person identity
    narrative in full each session — consolidation, not concatenation — and
    each session appends a compact **episode** (stimulus, emotion, reasoning,
    voice) to episodic memory, capped at the most recent 40.
  - **Memory** (module 3) and **Temporal Awareness** (module 5) are given
    this real history as context — including a concrete session number and
    summaries of the most recent and ~10-sessions-back episodes — instead of
    hallucinating a plausible-sounding memory from nothing. Retrieval uses
    keyword overlap between the new stimulus and past episodes, returning
    nothing (rather than forcing in unrelated ones) when nothing matches.
  - The `MemoryPanel` at the top of the page shows the current identity
    narrative, session number, and episode list, with a "Forget everything"
    control that clears it.
- **UI**: `app/page.tsx` renders the 22 modules grouped into 7 phases
  (Sensing → Memory & Learning → Deliberation → Self → Audit & Control →
  Integration → Expression), a live rerun-activity log, and a highlighted
  final **Voice** card with the Φ estimate.
- **PWA**: `public/manifest.webmanifest` + `public/sw.js` make it installable.
  The service worker only caches this app's own shell (HTML/CSS/JS/icons) —
  it never intercepts the cross-origin model-weight requests, which WebLLM
  caches itself.

## Requirements

Local inference needs **WebGPU**: Safari 17+ (iOS/macOS), Chrome/Edge on
desktop, or Chrome on Android. The app detects and warns if WebGPU isn't
available.

## Develop locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. First run for a given model will download and
compile it (can take a minute or two depending on the model and connection);
subsequent loads are near-instant from cache.

Icons in `public/icons/` are generated by a dependency-free script (no
imagemagick/PIL needed in this environment):

```bash
npm run gen:icons
```

## Deploy to Vercel

```bash
npm i -g vercel   # if you don't have it
vercel
```

Or connect the GitHub repo at [vercel.com/new](https://vercel.com/new) — no
environment variables or serverless functions are required, since inference
happens entirely in the visitor's browser.

## Add to iPhone home screen

1. Open the deployed URL in **Safari** on iPhone (must be Safari, not Chrome,
   for the install prompt to work correctly).
2. Tap the **Share** icon (square with an arrow) in the toolbar.
3. Tap **Add to Home Screen**, then **Add**.
4. Launch it from the home screen icon — it opens full-screen with no Safari
   chrome, like a native app.

The model still needs to download once per device/browser profile on first
use; after that it's cached and loads offline.
