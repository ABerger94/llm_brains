# MetaSelf-CognitiveStack

Local-first web application that runs a **sequential multi-module cognitive pipeline** through a **local OpenAI-compatible LLM** (LM Studio, Ollama, llama.cpp server, etc.). The UI presents **MetaSelf** on the **Dashboard** and **MetaSelf-CognitiveStack** elsewhere (sidebar, shell title), with tools for inspecting **shared memory**, beliefs, biography, graph-style pipeline execution, and related “mind” affordances—while heavy inference happens on the **Express** backend, not in the browser.

---

## Quick start

1. **Node.js** (current LTS recommended).
2. **Local LLM server** with an OpenAI-compatible `/v1` API (e.g. LM Studio listening on `http://127.0.0.1:1234`).
3. Create a **`.env`** at the repository root (same folder as `package.json`). Minimum:

   ```env
   LOCAL_LLM_BASE_URL=http://127.0.0.1:1234
   LOCAL_LLM_MODELS=your-exact-model-id
   ```

   Optional:

   ```env
   LM_API_TOKEN=lm-studio
   PORT=8787
   LOCAL_LLM_LOW_SPEC=1
   LOCAL_LLM_CONTEXT_BUDGET_CHARS=7200
   LOCAL_LLM_TIMEOUT_MS=1800000
   # Soft deadline for local streaming (default: hard timeout minus 120s): save partial output and continue pipeline
   # LOCAL_LLM_SOFT_BUFFER_MS=120000
   # LOCAL_LLM_SOFT_TIMEOUT_MS=1680000
   API_PROXY_TARGET=http://127.0.0.1:8787
   # Optional: SQLite snapshots of Integration `globalWorkspace` per session via Node built-in `node:sqlite` (requires recent Node).
   # Creates `.data/` if needed. Omit `WORKSPACE_DB_PATH` to disable.
   # WORKSPACE_DB_PATH=.data/workspace.sqlite
   ```

   For **iPhone / remote dev** (Tailscale or LAN), optionally set the host Safari uses so Vite HMR WebSockets match:

   ```env
   DEV_LAN_HOST=100.x.y.z
   ```

   Use your PC’s Tailscale IP or MagicDNS hostname (no `http://`). Omit if you only open the app on the same machine.

4. Install and run full stack:

   ```bash
   npm install
   npm run dev
   ```

   This starts **nodemon** on `server/index.js`, writes **`.dev-backend-port.hf`** with the bound port, waits for **`/api/health`**, then starts **Vite** on port **5174** with **`/api`** proxied to the live backend (Hugging Face–first; see `vite.config.js`). Use **`npm run dev:local`** for LM Studio–first (UI on **3000**).

   For the default **`npm run dev`** stack, set **`HF_TOKEN`** (Hugging Face read token) in `.env`. The server defaults **`HF_INFERENCE_MODELS`** to **`huihui-ai/Mistral-Small-24B-Instruct-2501-abliterated:featherless-ai`** (HF Inference router, OpenAI-compatible `model` id with `:featherless-ai`). Override **`HF_INFERENCE_MODELS`** if you want a different model or comma-separated fallbacks.

5. Open the app (Vite may open the browser). **`npm run dev:frontend`** alone is possible but **`/api`** calls need the backend or a matching proxy.

Other scripts: `npm run build`, `npm run preview`, `npm run lint`, `npm run dev:backend`, `npm run test:providers`, `npm run test:pipeline-module`, `npm run test:slim-shared`, `npm run test:prior-prediction`, `npm run test:cognitive-eval`.

### Remote access (Tailscale / LAN)

The dev stack already listens beyond localhost: Express binds to **`0.0.0.0`** by default (`BIND_HOST` in [`server/index.js`](server/index.js)), and Vite uses **`server.host: true`** on port **5174** for **`npm run dev`** ([`vite.config.js`](vite.config.js); **`npm run dev:local`** uses **3000**). Browser calls go to Vite; **`/api`** is proxied to the backend on the PC.

1. **Same network**: Put your **PC** and **iPhone** on the same Tailscale tailnet (Tailscale app on both devices, same account). Alternatively, use the same LAN and your PC’s LAN IP (firewall rules still apply).
2. **PC address**: In the Tailscale app or [admin console](https://login.tailscale.com/admin/machines), note the PC’s **`100.x.y.z`** address. If **MagicDNS** is on, you can use a hostname ending in **`.ts.net`** (allowed by Vite’s `allowedHosts`).
3. **Run on the PC**: `npm run dev` as usual.
4. **On the iPhone**: In Safari, open **`http://100.x.y.z:5174`** for the default **`npm run dev`** stack (replace with your PC’s Tailscale IP or MagicDNS name). Use **`http://`**, not `https://`, unless you terminate TLS yourself. If you use **`npm run dev:local`**, use port **3000** instead.
5. **Windows Firewall**: If the page does not load, allow **inbound TCP 5174** (or **3000** for `dev:local`) for Node (or create a rule for the Tailscale / Private profile). You do **not** need to expose the backend port to the phone when using the default setup—all traffic goes through Vite, which proxies `/api` to `127.0.0.1` on the PC.
6. **Hot reload (HMR)**: If the UI loads but live reload or the dev WebSocket fails, set **`DEV_LAN_HOST`** in `.env` to exactly the host you type in Safari (Tailscale IP or MagicDNS hostname). See [`vite.config.js`](vite.config.js) (`server.hmr`).

---

## Purpose and design (what this product is)

- **Purpose**: Provide a **controllable lab** for **structured, multi-stage reasoning**: user input (and optional image uploads) flows through **many named cognitive modules** in a fixed order. Each step receives a **JSON snapshot of shared memory** plus a **module-specific system prompt**, calls the LLM once, and writes the result back into **`sharedMemory.moduleOutputs`**. Derived fields (emotion, identity, beliefs, etc.) are updated in code where applicable (`server/pipeline.js`, `server/mindPolicy.js`). **Metacognition** can trigger **RERUN** loops that re-execute earlier layers with guidance.
- **Design stance**:
  - **Privacy / locality**: The production path is **local inference only**. Cloud API keys are explicitly stripped in `server/index.js` so the OpenAI SDK talks only to your **`LOCAL_LLM_BASE_URL`**.
  - **Separation of concerns**: **React** owns navigation, visualization, and client-side persistence; **Express** owns LLM calls, pipeline orchestration, SSE streaming, and ephemeral **multipart uploads** (in-memory store with TTL, not durable file storage).
  - **UX**: **Tailwind CSS** + small **UI primitives** (`src/components/ui/*`), **Lucide** icons, collapsible **sidebar** routing (`src/App.jsx`). Primary workflow surfaces: **Dashboard** (health + viz), **Graph Pipeline** (live run + graph canvas), **Classic pipeline**, and many **inspector** pages backed by **localStorage** entities.
- **Data model (client)**: Long-term artifacts (beliefs, biography, world model, curiosity, temporal events, pipeline runs, etc.) are abstracted through **`src/api/base44Client.js`** → **`src/services/localStorage.js`** (Browser **localStorage**, not a server DB).

### What this lab is not

Continuity features (prediction audit across turns, epistemic tagging, consolidation, metacognitive reruns) are **implemented machinery** for coherence and introspection. They do **not** imply that the underlying LLM is conscious or sentient; they are engineering tools for **structured self-modeling** and auditability.

---

## Architecture (how it is structured)

### Top-level layout

| Area | Role |
|------|------|
| `index.html` | Shell; mounts `src/main.jsx` on `#root`; default document title **MetaSelf-CognitiveStack** (home tab uses **Dashboard · MetaSelf** once the app loads). |
| `vite.config.js` | React plugin; **dynamic `/api` proxy** via `http-proxy` reading **`.dev-backend-port`** or `API_PROXY_TARGET` / `VITE_API_PROXY`; SSE-friendly headers. |
| `package.json` | Scripts; deps: React 18, React Router 6, Vite 5, Express 5, OpenAI SDK (for compatible endpoints), Tailwind, etc. |
| `server/index.js` | Express app: CORS, large JSON body, **multer** uploads, **`callLLM`**, routes under **`/api/*`**, writes **`.dev-backend-port`**, port fallback if busy. |
| `server/pipeline.js` | **`createSharedMemory`**, **`runModule`**, **`runPipeline`** (layer order + Metacognition / **Workspace Metacognition** reruns), **`runPipelineClassic`**, **`runSingleModule`**; integrates **`mindPolicy`**; compresses oversized **`moduleOutputs`** for context limits. |
| `server/prompts.js` | **`MODULES`** (name + `layer` + `systemPrompt`), **`LAYERS`** (execution groups), **`getModuleByName`**. |
| `server/mindPolicy.js` | Cross-cutting “mind runtime” merges: constitution, phenomenal now, metacognition calibration, stochastic cognitive policy, embedding-ranked memory retrieval, personality facet scoring. |
| `server/sanitizeSharedMemory.js` | **`clampSharedMemoryForPipeline`** for safe continuation payloads. |
| `server/llmEnv.js` | **`LOCAL_LLM_LOW_SPEC`**, context budget chars, timeouts, default **`max_tokens`**, multi-sample toggles for Integration and Contradiction Engine. |
| `server/embeddingService.js` | Embedding endpoint: `getEmbedding`, `getEmbeddings`, `cosineSimilarity`, LRU cache. Replaces lexical Jaccard with semantic cosine similarity. Falls back when `EMBEDDING_DISABLED=1`. |
| `server/adaptiveTemperature.js` | Derives LLM temperature from interoception (uncertainty, curiosity, tension) and phase. Toggle: `ADAPTIVE_TEMPERATURE_DISABLED=1`. |
| `server/thresholdStore.js` | Loads calibrated thresholds from `.data/calibrated-thresholds.json`; `getThreshold(name, default)` replaces hardcoded magic numbers. |
| `server/calibration.js` | Pipeline telemetry logging (`.data/pipeline-telemetry.jsonl`) and threshold recalibration. Route: `POST /api/calibrate`. |
| `src/App.jsx` | **`BrowserRouter`**, **`AppLayout`**: sidebar + **`Routes`** to all pages. |
| `src/pages/*` | Feature pages (Dashboard, GraphPipeline, Belief map, Extra/Local mind pages, etc.). |
| `src/components/pipeline/*` | **Graph canvas**, file attach control for pipeline. |
| `src/lib/*` | Pipeline SSE client, graph store, slim shared memory for POSTs, cognitive module metadata / execution plan mapping, persistence hooks, etc. |
| `src/services/llmService.js` | Browser → **`POST /api/llm/text`**; optional token streaming via **`POST /api/llm/text-stream`**. |

### HTTP API (backend)

- **`GET /api/health`** — Configuration summary, last LLM success, in-flight count, `backendProfile: local_openai_compat_only`.
- **`POST /api/llm/text`**, **`POST /api/llm/json`** — Direct completion helpers.
- **`POST /api/uploads/images`** — Multipart **`images`**; returns attachment metadata (in-memory **`attachmentStore`**, TTL ~30 minutes).
- **`POST /api/pipeline/run`** — Full pipeline, JSON response.
- **`POST /api/pipeline/run-classic`** — Alternate classic pipeline.
- **`POST /api/pipeline/stream`**, **`POST /api/pipeline/run-stream`** — Same runner, **Server-Sent Events** (`text/event-stream`); events via **`onEvent`**; slim shared memory on completion for line-size safety.
- **`POST /api/pipeline/module`** — Run a single module by name with provided **`sharedMemory`**.
- **`POST /api/embeddings`** — Compute vector embeddings for an array of texts (requires an embedding-capable provider). Returns `{ embeddings }` or `{ error }`.
- **`POST /api/calibrate`** — Run threshold recalibration from pipeline telemetry. Returns updated threshold values.
- **`GET /api/thresholds`** — Return all current calibrated thresholds (defaults + overrides from `.data/calibrated-thresholds.json`).

### Pipeline module order (authoritative server-side)

Modules are grouped into **six layers** (`server/prompts.js` → **`LAYERS`**), executed in order:

1. **Layer 1**: Perception, Attention  
2. **Layer 2**: Memory, Learning, Temporal Awareness  
3. **Layer 3**: Planning, Reasoning, Emotion, Theory of Mind, Belief Store  
4. **Layer 4**: Self-Reflection, Identity, Social Cognition, Contradiction Engine  
5. **Layer 5**: Metacognition, **Integration** (global workspace JSON), Language, Curiosity, Goal Generation, Somatic Marker  
6. **Layer 6**: Narrative, Voice  

**Metacognition** and **Workspace Metacognition** can request **RERUN**; the server re-enters layers 1–4 per `server/pipeline.js`. **`maxMetacognitionReruns`** limits supervisor reruns **per user message / logical run** (cumulative across chained SSE legs and scheduled continuations; `metacognitionRerunsUsed` is carried in shared memory, not reset each leg). With **`options.deferMetacognitionRerun: true`** (when **Settings → Metacognition RERUN delay** is ≥1 minute), the stream ends with **`complete`** plus **`metacognitionRerunPending`** (no Voice on that leg) and the client enqueues a **`supervisor_pipeline_rerun`** **ScheduledTask**; at **0** delay the client chains immediate continuation POSTs instead. Requires **`maxMetacognitionReruns` ≥ 1** for counted reruns to execute. Optional **`META_ACTIONS`** JSON adjusts brevity, belief tensions, or effective phase for the rest of the run.

### Probabilistic pipeline integrations

The pipeline layer is augmented with several probabilistic features that bridge the gap between the LLM's inherent stochasticity and the system's structured processing:

- **Embedding-based semantic similarity** (`server/embeddingService.js`) — Replaces lexical Jaccard overlap with cosine similarity over vector embeddings in epistemic fusion, personality facet ranking, and memory retrieval. Requires an OpenAI-compatible embedding endpoint; gracefully falls back to Jaccard when disabled or unavailable.
- **Adaptive temperature** (`server/adaptiveTemperature.js`) — LLM sampling temperature is derived dynamically from interoception signals (uncertainty pressure, curiosity, tension, cognitive load) and the current cognitive phase, rather than being a fixed value.
- **Probabilistic metacognition** — Metacognition / Workspace Metacognition now emit confidence scores (e.g. `RERUN 0.73`). The rerun decision is a soft threshold modulated by interoception entropy, not a hard binary.
- **Probabilistic memory retrieval** (`mindPolicy.js`) — Long-term memory, belief digests, and timeline entries are re-ranked by embedding cosine similarity blended with recency decay, replacing pure recency ordering.
- **Multi-sample modules** — Integration and Contradiction Engine can run N parallel samples (toggled by env vars) with configurable merge strategies (mechanical field-merge or LLM-based synthesis).
- **Stochastic cognitive policy** (`mindPolicy.js`) — The deterministic lookup table for `cognitivePolicy` is replaced with distribution sampling modulated by interoception. Falls back to the original table when `STOCHASTIC_POLICY_DISABLED=1`.
- **Calibrated thresholds** (`server/thresholdStore.js`, `server/calibration.js`) — All hardcoded decision thresholds (integration confidence, conflict pressure, entropy gates, arousal triggers) are loaded from `.data/calibrated-thresholds.json` and can be nudged over time by an exponential-moving-average recalibration pass over pipeline telemetry.

All features degrade gracefully: when embeddings are unavailable, env vars are unset, or calibration data does not exist, the system uses the original deterministic defaults.

### Frontend ↔ backend contract

- Graph pipeline UI uses **SSE** (`src/lib/pipelineSse.js`) against **`/api/pipeline/stream`** (or alias), sending **`input`**, optional **`sharedMemory`** (continuations), **`options`**, **`attachmentIds`**.
- Vite dev server proxies **`/api`** so the browser uses **same-origin** relative URLs.
- **`options`** may include **`structuralSelf`** (world-model `self` rows), **`workingMemorySeed`** (current input + pinned lines), plus phase, constitution, `userModel`, etc.
- **`sharedMemory`** is a large evolving object: `sessionId`, `iterationCount`, `layerOutputs`, `moduleOutputs`, `beliefStore`, `structuralSelfModel`, `workingMemory`, `globalWorkspace`, `interoception`, `outputConstraints`, `phaseEffective`, `userStancePrediction`, `surpriseAssessment`, `emotionalState`, `curiosityQueue`, `constitution`, `cognitivePolicy`, etc. (see **`createSharedMemory`** in `server/pipeline.js`).

---

## Prompt: recreate this architecture (copy for an AI or greenfield build)

Use the block below as a **standalone specification** when you want another tool or team to reproduce the same system without reading the repo.

```text
Build a full-stack app named "MetaSelf-CognitiveStack" with this exact intent and structure:

GOAL
- A local-first "cognitive architecture laboratory" where user text (and optional images) is processed by a FIXED SEQUENCE of 22 LLM modules that simulate layers of mind (perception → attention → memory → … → narrative → voice).
- All LLM calls MUST go through a small Express (or equivalent) backend that uses ONLY a local OpenAI-compatible API base URL (e.g. LM Studio at http://127.0.0.1:1234/v1). Do not use cloud OpenAI by default; strip cloud keys on server boot.
- The browser is a React SPA (Vite) with React Router, Tailwind, and a persistent left sidebar listing: Dashboard, Graph Pipeline, Pipeline Classic, Multi-Mind, Mind Biography, Self & consolidation, Belief Map, Curiosity, Temporal, World Model, Shared Memory, Long-Term Memory, Dreaming, Health, analytics / processing log, Iterations, Experiments, RLHF, Datasets, Training, Playground, Settings, User Manual, Scheduler, Neural Network.

BACKEND BEHAVIOR
- Load .env from project root. Required: LOCAL_LLM_BASE_URL (or OLLAMA_BASE_URL), LOCAL_LLM_MODELS (comma-separated model ids). Optional: LM_API_TOKEN / LOCAL_LLM_API_KEY as Bearer token, PORT, LOCAL_LLM_LOW_SPEC, LOCAL_LLM_CONTEXT_BUDGET_CHARS, LOCAL_LLM_TIMEOUT_MS.
- Normalize base URL to end with /v1. Use OpenAI SDK with custom baseURL + Bearer token for chat.completions.
- Implement GET /api/health returning configured providers, local inference hints, last successful call, inFlight count, backendProfile: "local_openai_compat_only".
- Implement POST /api/llm/text and POST /api/llm/json (JSON mode via system instruction).
- Implement in-memory multipart upload POST /api/uploads/images returning attachment ids; pipeline accepts attachmentIds and injects an "ATTACHMENTS:" block into the composed user content (captions may be null unless you add vision).
- Implement shared memory object with at least: sessionId, iterationCount, originalInput, timestamp, layerOutputs (layer1..layer6 arrays), moduleOutputs (map moduleName → string), beliefStore, activeGoals, emotionalState, identityNarrative, curiosityQueue, somaticReading, contradictions, narrativeHistory, metaCognitionFlags, rerunGuidance, phase, arousal, intent, userModel, constitution, cognitivePolicy, phenomenalNow, metacognitionTimeline, beliefTensions, boundaryAudit.
- Define MODULES array: each entry has layer (layer1..layer6), name (exact string), and a long systemPrompt describing that cognitive role. Define LAYERS map listing module names per layer in execution order.
- For each module run: build user message containing instructions + JSON.stringify(sharedMemory snapshot trimmed for size). Call LLM; store result in moduleOutputs[moduleName] and moduleOutputs[name__meta] with provider/model/timestamp. After certain modules, parse or heuristically update emotionalState, identityNarrative, beliefStore, etc.
- After each module, if total moduleOutputs character count exceeds a budget (env-tunable), compress oldest/truncate to avoid context overflow.
- Run pipeline: for each layer in order, for each module in layer order, await runModule. After Metacognition, parse first line for RERUN vs PROCEED; on RERUN, increment iterationCount, record metaCognitionFlags, and re-execute earlier layers per your policy (match: rerun from layer1 through Metacognition again until proceed or max iterations).
- Expose POST /api/pipeline/run (JSON result), POST /api/pipeline/stream and duplicate path for SSE: stream JSON events {type,...} per module start/complete/error, end with slimmed sharedMemory for SSE line limits.
- Expose POST /api/pipeline/run-classic for alternate ordering if desired, and POST /api/pipeline/module for single-module runs.
- On server listen, write .dev-backend-port with chosen port; if default port busy, try next ports (bounded attempts).

FRONTEND BEHAVIOR
- Vite dev: plugin proxies /api to http://127.0.0.1:<port> where port is read from .dev-backend-port each request (or fixed env override) so backend restarts don’t strand the proxy.
- npm run dev = concurrently backend (nodemon) + script that waits until .dev-backend-port exists and /api/health returns expected backendProfile + then vite.
- Graph Pipeline page: textarea input, optional file picker → upload → attachmentIds; POST SSE to /api/pipeline/stream; update per-module status and a graph visualization; allow mind phase, arousal, intent in options; persist last state to localStorage; optionally merge in client-side "long-term memory" search results from local entities into prompts or logs (server still runs full pipeline).
- Dashboard: fetch /api/health on interval; show module count and neural viz; display model/last call from health.
- Provide a Base44-shaped compatibility object: entities (CRUD-like) backed by localStorage for BeliefStore, MindBiography, WorldModel, CuriosityItem, TemporalEvent, LongTermMemory, PipelineRun, etc.; integrations.Core.InvokeLLM → /api/llm/text.
- Match visual design: dark-friendly CSS variables (background, card, border, primary, muted-foreground), sidebar active state with primary fill, Lucide icons.

NON-GOALS FOR PARITY
- Do not require a cloud LLM. Do not require a production database for v1 (localStorage is fine). Image captions in attachment store can remain null unless you add a vision model path.

Deliverables
- Monorepo or single repo with server/ and src/, README, .env.example, and the same route names so clients can swap between implementations.
```

---

## Recommended updates and upgrades

The following are **prioritized suggestions** for maintainability, safety, and product quality—not requirements for the current design to function.

1. **Single source of truth for modules**  
   Today, **`server/prompts.js`** (authoritative for execution) and **`src/lib/cognitiveModules.js`** (UI metadata) can drift. Generate one from the other at build time, or share a JSON module registry imported by both.

2. **`.env.example` committed**  
   Document every variable (including `API_PROXY_TARGET`, `BIND_HOST`) without secrets so onboarding is one copy-paste.

3. **TypeScript**  
   Typing **`sharedMemory`**, SSE events, and API responses would reduce runtime bugs across the large pipeline surface.

4. **Automated tests**  
   Expand beyond script smoke tests: unit tests for `sanitizeSharedMemory`, `compressSharedMemory`, metacognition rerun parsing; integration tests with a mocked `callLLM`.

5. **True token streaming**  
   `llmService.InvokeLLMStream` currently wraps a full HTTP response. Optional: proxy OpenAI-compatible streaming chunks to the UI for perceived latency.

6. **Image understanding**  
   Uploads store metadata but captions are often empty; wire **vision** or a captioning pass if attachments should affect reasoning beyond filenames.

7. **Durable storage option**  
   localStorage is fragile for serious use; offer an optional SQLite/Postgres backend mirroring the same entity API.

8. **Auth and deployment**  
   If exposed beyond localhost, add authentication, rate limits, and CSRF/session hardening; never expose LM keys to the browser.

9. **CI pipeline**  
   Lint + tests on push; `vite build` verification.

10. **Observability**  
    Structured logs per module (duration, token estimates if available), request IDs, and a simple `/api/metrics` for pipeline counts.

11. **Accessibility**  
    Sidebar and graph controls: keyboard navigation, ARIA labels, focus management during SSE updates.

12. **Remove stray artifacts**  
    Clean up accidentally committed scratch files (e.g. misplaced `.js` dumps in repo root) so the tree matches the mental model above.

---

## License / name

Package name in `package.json` is **`metaself-cognitivestack-app`**; product title in UI and HTML is **MetaSelf-CognitiveStack** (Dashboard hero **MetaSelf**). Add a `LICENSE` file if you distribute the project.
