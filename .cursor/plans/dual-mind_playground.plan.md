# Dual graph playground (sequential A → B)

## Current state

- [`src/components/Playground.jsx`](src/components/Playground.jsx) runs client `invokeLLM` over modules — **not** the server graph pipeline SSE.
- Mind data is a **single** IndexedDB namespace; isolation for System B requires namespaced entities or equivalent (see below).

## Target behavior

- **Sequential**: finish System A (Voice), then start System B with Voice as the next run’s user input.
- **Isolation**: System A = primary stores; System B = mirror namespaced stores.
- **UI**: Playground orchestration + nested `/playground/mirror/*` for mirror mind management (pagination on lists).

---

## System A input: random starter vs explicit message(s) (new)

Users should be able to:

1. **Random conversational idea** — Click a control (e.g. “Random topic”) that **prompts System A** (the first graph pipeline) to generate a **random conversation starter / topic / icebreaker**, then use that text as the **user-side input** for the same run (or pre-fill the composer and require Confirm — product choice below).
2. **Specific message(s)** — Type **one or more** messages manually; those strings are composed into the **same `input`** the graph pipeline POST uses for System A.

### Twin-system framing (System A knows its partner is a copy)

- **Goal:** System A’s pipeline input should make clear it is **not** addressing a generic human user only; it is in a **dialogue with another LLM running the same cognitive architecture** (the mirror / System B), so Perception → Voice treat the situation as **peer-to-peer** with an equivalent stack.
- **How:** On **Run** (for any System A turn in dual playground), compose the POST `input` from:
  1. A **short, stable preamble** (tunable copy) such as: *You are speaking with another instance of this mind: a separate run of the same full graph pipeline and modules. Your Voice output will be fed as that instance’s next user turn.*  
  2. The **user content** (random topic text, or typed message(s), composed with `\n\n` / `---` as elsewhere).
- **Random topic LLM call:** The **pre-run** generator prompt must **not** assume a human chat. Instruct the model to output **one** concise conversation starter or topic **appropriate for a dialogue between two such systems** (same role, mutual curiosity, metacognitive or architectural questions, etc.) — still neutral and varied. The generated line(s) are **only** the topic; the twin preamble is added at **Run** time together with typed content, so the composer can show either topic-only or “preamble + topic” preview (product choice: show preamble in composer vs inject only in POST — default **inject at POST** so the composer stays readable).

### Implementation notes

- **Random topic** is produced by a **short LLM call** before the main graph run, using the **twin-appropriate** generator prompt above. Parse the model output and strip quotes; result **fills the composer** (topic-only or full preview per choice above).
- **Explicit messages**: support a **primary multiline field** and optional **additional lines**; same **Run** path applies **twin preamble + composed user text** for System A in dual playground.
- **UX**: Two modes: **“I’ll type”** vs **“Suggest a topic”** (button → composer → edit → Run). **Preview + edit** before Run; no auto-start from random alone.

### Locked product choices

- **Random topic:** Generated text **fills the composer** (editable); user then clicks Run — **no auto-start** of System A from the random button alone. Generator is **biased toward twin-system dialogue**; **Run** adds the **twin preamble** to System A’s actual pipeline input.
- **Multiple user messages:** Compose into one pipeline `input` using `\n\n` or `---` per server expectations; document in UI.
- **Twin preamble:** Injected on Run for System A in dual playground (whether content came from random or typing); wording lives in one constant so it can be tuned without code churn.

---

## Storage design (unchanged summary)

- Namespaced entity types (e.g. `BeliefStore__playground_mirror`) in same IDB; thread `mindStorageProfile` through prep + `persistMindAfterPipeline`.

## Orchestration (unchanged summary)

- `startPlaygroundDualGraphRun`: A (primary) → Voice → B (mirror).

## UI / routing (unchanged summary)

- Replace Playground with dual panels; `/playground/mirror/*` for mirror lists with pagination.

## todos

- [ ] Add mirror EntityManager instances; export Mirror* from data.js
- [ ] Thread mindStorageProfile through prep + persistMindAfterPipeline
- [ ] Extend stream runner for profile/session/input; add playground dual sequential runner
- [ ] Replace Playground: dual layout, graph sessions, **random topic (twin-biased) + twin preamble on Run + explicit composer**
- [ ] `/playground/mirror/*` paginated thin pages
- [ ] Nav/siteMap/manual copy
