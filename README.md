# Mind Chain

A small LLM, run entirely inside your browser, walks a single stimulus through
a 22-module cognitive pipeline where each module is mapped to a real
brain-region equivalent (Perception → primary sensory cortices, Emotion →
amygdala/insula, Integration → Global Workspace/Phi under Integrated
Information Theory, and so on), ending in **Voice** — the mind's actual
first-person response. The LLM itself runs entirely client-side via WebGPU —
inference never touches a server. A small backend exists solely to persist
this mind's memory in a real database instead of just browser `localStorage`.

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
- **Real control flow**: `lib/useMindChain.ts` implements two modules that
  can actually redirect the run, not just narrate about it:
  - **Contradiction Engine** (14) audits modules 1-13 and can emit up to
    `CONTRADICTION_ENGINE_MAX_DIRECTIVES` (2) `MODULE_RERUN: [Name] — reason`
    directives, each causing just that module to be re-executed in place.
  - **Metacognition** (15) can send modules 1-14 back for a full fresh pass,
    up to `METACOGNITION_MAX_RERUNS` (1) time, by starting its output with
    `RERUN` (otherwise `PROCEED`).
  - Both are parsed fail-safe-to-proceed — a small local model won't
    reliably emit exact machine-parseable directives, so anything that
    doesn't clearly match is treated as "no directive." A hard backstop,
    `MAX_TOTAL_MODULE_CALLS` (45), caps the total regardless. These caps are
    intentionally tighter than the original design (3 / 4) after real-device
    crashes: the legitimate worst case here is 41 calls, versus ~75 with the
    looser caps, which was enough sustained WebGPU/WASM load to crash both
    the installed PWA and the browser tab outright.
  - Two more things that came out of chasing those crashes, kept regardless
    of the caps above: `resetChat()` is called on the engine after every
    module (each call is an unrelated single-turn prompt, no reason to let
    conversation/KV-cache state accumulate), and streaming token updates are
    batched to at most once per animation frame instead of one React
    re-render per token, with a small yield between module calls so the
    browser can breathe/GC instead of the run monopolizing the main thread.
  - **Integration** (16) is asked to report a IIT-style `PHI: 0.XX` estimate,
    parsed and shown as a Φ badge next to the final output — reported, not
    used to gate anything.
- **Persistent memory, backed by a real database**: `lib/memoryStore.ts`
  (client) and `lib/server/memoryDb.ts` + `app/api/memory/route.ts` (backend)
  keep this from being a stateless one-shot pipeline, and from being tied to
  one browser's `localStorage`. A "session" = one full pipeline run:
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
  - There's no account system. A random `mindId` is generated once and kept
    in `localStorage` (`lib/mindId.ts`) purely to namespace this browser's
    data server-side — it's an anonymous key, not an identity.
  - Data itself lives in Redis via `@upstash/redis`, reachable through one
    API route (`app/api/memory`). **Requires the one-time setup step below**
    — without it, the app still runs (falls back to an in-memory store) but
    nothing actually persists in production. The `MemoryPanel` shows a
    warning banner when the backend isn't connected.
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

## One-time setup: connect a Redis database

Persistent memory needs a real database behind `/api/memory`, or it won't
survive across serverless invocations in production (see the in-memory
fallback caveat above).

1. In the [Vercel dashboard](https://vercel.com/dashboard), open this
   project → **Storage** tab → **Create Database** → pick a Redis option
   (Vercel's own KV storage is deprecated; use the **Upstash for Redis**
   integration from the Marketplace instead) → connect it to this project.
2. Vercel auto-injects `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — `lib/server/memoryDb.ts`
   accepts either naming) into the project's environment variables. Redeploy
   for them to take effect.
3. For local dev, run `vercel env pull .env.local` to pull the same
   variables down, or set them manually in `.env.local`.

Without this, `npm run dev` and preview deploys still work — they just use
an in-memory fallback that's cleared on every restart/new serverless
instance, so don't rely on it for anything you want to keep.

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

Or connect the GitHub repo at [vercel.com/new](https://vercel.com/new). The
LLM itself still needs no environment variables or server compute — that
part runs entirely in the visitor's browser. The one small serverless
function (`app/api/memory`) needs the Redis env vars from the setup step
above for persistent memory to actually persist.

## Add to iPhone home screen

1. Open the deployed URL in **Safari** on iPhone (must be Safari, not Chrome,
   for the install prompt to work correctly).
2. Tap the **Share** icon (square with an arrow) in the toolbar.
3. Tap **Add to Home Screen**, then **Add**.
4. Launch it from the home screen icon — it opens full-screen with no Safari
   chrome, like a native app.

The model still needs to download once per device/browser profile on first
use; after that it's cached and loads offline.
