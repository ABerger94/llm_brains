/**
 * Token budget helpers for OpenAI-compatible chat completions.
 * Uses conservative character→token estimation (no extra npm deps).
 */

function parsePositiveInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw || '').trim(), 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(max, n);
}

export function getLlmContextTokensMax() {
  return parsePositiveInt(process.env.LLM_CONTEXT_TOKENS_MAX, 8190, 2048, 200_000);
}

export function getLlmContextSlackTokens() {
  return parsePositiveInt(process.env.LLM_CONTEXT_SLACK_TOKENS, 24, 0, 512);
}

/** Characters per token (conservative: smaller = more tokens estimated). Default 3 → ceil(len/3). */
export function getTokenCharsPerToken() {
  const n = Number.parseFloat(String(process.env.LLM_TOKEN_CHARS_PER_TOKEN || '').trim());
  if (Number.isFinite(n) && n >= 2 && n <= 8) return n;
  return 3;
}

/** auto | on | off */
export function getChunkedModuleCallsMode() {
  const v = String(process.env.LLM_CHUNKED_MODULE_CALLS || 'auto').toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return 'on';
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return 'off';
  return 'auto';
}

export function estimatePromptTokens(systemPrompt, userContent) {
  const cpt = getTokenCharsPerToken();
  const len = String(systemPrompt || '').length + String(userContent || '').length;
  return Math.ceil(len / cpt) + 6;
}

/**
 * Reserved completion tokens for budgeting (cap to avoid absurd values).
 */
export function budgetedCompletionCap(requestedMaxTokens, defaultMaxTokens) {
  const req = Number(requestedMaxTokens);
  const def = Number(defaultMaxTokens);
  const base = Number.isFinite(req) && req > 0 ? req : Number.isFinite(def) && def > 0 ? def : 800;
  return Math.min(Math.max(200, Math.floor(base)), 4096);
}

/**
 * Total estimated request size: prompt + completion.
 */
export function estimateTotalRequestTokens(systemPrompt, userContent, maxTokens) {
  return estimatePromptTokens(systemPrompt, userContent) + maxTokens;
}

/**
 * Clamp max_tokens so prompt + max_tokens + slack fits context max.
 */
export function clampMaxTokensForContext(systemPrompt, userContent, requestedMaxTokens, defaultMaxTokens) {
  const contextMax = getLlmContextTokensMax();
  const slack = getLlmContextSlackTokens();
  const promptT = estimatePromptTokens(systemPrompt, userContent);
  const requested = budgetedCompletionCap(requestedMaxTokens, defaultMaxTokens);
  const allowed = contextMax - slack - promptT;
  if (allowed <= 0) {
    return Math.max(1, Math.min(requested, 256));
  }
  return Math.max(1, Math.min(requested, allowed));
}

/**
 * Merge options with context-clamped max_tokens.
 */
export function applyContextBudgetToCallOptions(systemPrompt, userContent, options, defaultMaxTokens) {
  const requested = options?.max_tokens;
  const eff = clampMaxTokensForContext(systemPrompt, userContent, requested, defaultMaxTokens);
  return { ...options, max_tokens: eff };
}

/**
 * True if single-call prompt + completion would exceed context (for auto chunking).
 */
export function exceedsContextBudget(systemPrompt, userContent, requestedMaxTokens, defaultMaxTokens) {
  const contextMax = getLlmContextTokensMax();
  const slack = getLlmContextSlackTokens();
  const maxTok = budgetedCompletionCap(requestedMaxTokens, defaultMaxTokens);
  return estimateTotalRequestTokens(systemPrompt, userContent, maxTok) + slack > contextMax;
}

export function shouldUseChunkedModuleCalls(systemPrompt, userContent, requestedMaxTokens, defaultMaxTokens) {
  const mode = getChunkedModuleCallsMode();
  if (mode === 'off') return false;
  if (mode === 'on') return exceedsContextBudget(systemPrompt, userContent, requestedMaxTokens, defaultMaxTokens);
  return exceedsContextBudget(systemPrompt, userContent, requestedMaxTokens, defaultMaxTokens);
}

const MAP_SYSTEM = `You ingest one fragment of a larger shared-memory JSON snapshot from a cognitive pipeline.
Reply with ONLY valid JSON (no markdown fences, no commentary). Schema:
{"chunkIndex":<number>,"bullets":["...","..."]}
Each bullet is one terse fact from this fragment; keep names, numbers, dates, and contradictions. Max 80 bullets.`;

export function mapIngestSystemPrompt() {
  return MAP_SYSTEM;
}

export function mapIngestUserPrompt(chunkIndex, totalChunks, chunkText) {
  return [
    `SHARED_MEMORY_JSON_FRAGMENT ${chunkIndex + 1} of ${totalChunks} (full snapshot exists server-side unchanged).`,
    '',
    chunkText,
  ].join('\n');
}

/**
 * Split text into chunks of at most maxBodyChars, preferring newline boundaries.
 */
export function splitTextIntoChunks(text, maxBodyChars) {
  const s = String(text || '');
  if (maxBodyChars < 64) maxBodyChars = 64;
  if (s.length <= maxBodyChars) return [s];
  const out = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(s.length, i + maxBodyChars);
    if (end < s.length) {
      const slice = s.slice(i, end);
      const nl = slice.lastIndexOf('\n');
      if (nl > slice.length * 0.35) end = i + nl + 1;
    }
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * Binary-search max body length for map fragment so map call fits context.
 */
export function computeMapFragmentCharBudget(mapSystemPrompt, mapMaxTokens) {
  const contextMax = getLlmContextTokensMax();
  const slack = getLlmContextSlackTokens();
  const cpt = getTokenCharsPerToken();
  const fixedT = estimatePromptTokens(mapSystemPrompt, mapIngestUserPrompt(0, 99, ''));
  const budgetForBodyTokens = contextMax - slack - mapMaxTokens - fixedT;
  if (budgetForBodyTokens < 32) return 256;
  /** ~0.88: balance fewer map rounds vs. real n_ctx; map user is also clamped before each call. */
  return Math.max(256, Math.floor(budgetForBodyTokens * cpt * 0.88));
}

/**
 * Extract first top-level JSON object from model text (handles extra prose).
 */
export function extractFirstJsonObject(text) {
  const raw = String(text || '').trim();
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let j = tryParse(raw);
  if (j && typeof j === 'object') return j;
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        j = tryParse(raw.slice(start, i + 1));
        if (j && typeof j === 'object') return j;
        break;
      }
    }
  }
  return null;
}

/**
 * Remove a single outer ``` / ```json … ``` wrapper if the model ignored the no-fences instruction.
 */
export function stripOuterMarkdownJsonFence(text) {
  let s = String(text || '').trim();
  if (!s) return s;
  const wrapped = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(s);
  if (wrapped) return wrapped[1].trim();
  if (/^```(?:json)?\s*\n?/i.test(s)) {
    s = s.replace(/^```(?:json)?\s*\n?/i, '');
    const end = s.search(/\n?```/);
    if (end !== -1) s = s.slice(0, end).trim();
  }
  return s.trim();
}

/**
 * First balanced JSON object or array, respecting strings (handles nested `[]` / `{}`).
 * Returns parsed value or null.
 */
export function extractFirstJsonValue(text) {
  const s = String(text || '');
  const startObj = s.indexOf('{');
  const startArr = s.indexOf('[');
  let start = -1;
  if (startObj === -1 && startArr === -1) return null;
  if (startObj === -1) start = startArr;
  else if (startArr === -1) start = startObj;
  else start = Math.min(startObj, startArr);

  const stack = [];
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (!stack.length || stack[stack.length - 1] !== c) return null;
      stack.pop();
      if (stack.length === 0) {
        const slice = s.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Parse JSON from an LLM completion: strict parse, fence strip, then first balanced JSON value.
 */
export function parseLlmJsonText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let v = tryParse(raw);
  if (v !== null && typeof v === 'object') return v;

  const stripped = stripOuterMarkdownJsonFence(raw);
  if (stripped !== raw) {
    v = tryParse(stripped);
    if (v !== null && typeof v === 'object') return v;
  }

  const fromObj = extractFirstJsonObject(stripped);
  if (fromObj !== null && typeof fromObj === 'object') return fromObj;

  const balanced = extractFirstJsonValue(stripped);
  if (balanced !== null && typeof balanced === 'object') return balanced;

  return null;
}

export function mergeMapBullets(results) {
  const bullets = [];
  const seen = new Set();
  const sorted = [...results].sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
  for (const r of sorted) {
    const arr = Array.isArray(r.bullets) ? r.bullets : [];
    for (const b of arr) {
      const t = String(b || '').trim();
      if (!t || t.length > 2000) continue;
      const k = t.slice(0, 200);
      if (seen.has(k)) continue;
      seen.add(k);
      bullets.push(t);
    }
  }
  return bullets;
}

const MERGE_BULLETS_SYS = `Merge and deduplicate the bullet list. Output ONLY JSON: {"bullets":["..."]}. Cap at 120 bullets; combine near-duplicates; preserve distinct facts.`;

/**
 * Tier-2: halve bullet list via sequential LLM merge passes until JSON body fits target length (chars).
 */
export async function coalesceBulletsForBudget({ bullets, callLLM, options, targetBodyChars, maxRounds }) {
  let b = [...bullets];
  let round = 0;
  while (b.length && round < maxRounds) {
    const body = JSON.stringify({ bullets: b }, null, 2);
    if (body.length <= targetBodyChars) return b;
    const half = Math.ceil(b.length / 2);
    const first = b.slice(0, half);
    const second = b.slice(half);
    const runHalf = async (halfBullets) => {
      const u = JSON.stringify({ bullets: halfBullets }, null, 2);
      const mergeMax = clampMaxTokensForContext(MERGE_BULLETS_SYS, u, 512, 512);
      const { text } = await callLLM(MERGE_BULLETS_SYS, u, {
        ...options,
        max_tokens: mergeMax,
        temperature: 0.2,
        disableSoftTimeout: true,
        disableStallWatchdog: true,
      });
      const j = extractFirstJsonObject(text);
      return Array.isArray(j?.bullets) ? j.bullets.map((x) => String(x || '').trim()).filter(Boolean) : halfBullets;
    };
    const a = await runHalf(first);
    const c = await runHalf(second);
    b = [...a, ...c];
    round += 1;
  }
  return b;
}

/**
 * Re-ingest a large JSON string via map fragments → bullets (tier-2+).
 */
export async function ingestJsonStringViaMapChunks(jsonStr, callLLM, options) {
  const mapSys = mapIngestSystemPrompt();
  const mapMaxTokens = 512;
  const fragBudget = computeMapFragmentCharBudget(mapSys, mapMaxTokens);
  const chunks = splitTextIntoChunks(jsonStr, fragBudget);
  const mapResults = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const mapUserRaw = mapIngestUserPrompt(i, chunks.length, chunks[i]);
    const mapUser = truncateUserContentToContext(mapSys, mapUserRaw, mapMaxTokens, mapMaxTokens);
    const { text } = await callLLM(mapSys, mapUser, {
      ...options,
      max_tokens: mapMaxTokens,
      temperature: 0.2,
      disableSoftTimeout: true,
      disableStallWatchdog: true,
    });
    const j = extractFirstJsonObject(text);
    mapResults.push(
      j && typeof j === 'object'
        ? { chunkIndex: Number(j.chunkIndex) === i ? i : j.chunkIndex ?? i, bullets: j.bullets || [] }
        : { chunkIndex: i, bullets: [] }
    );
  }
  return mergeMapBullets(mapResults);
}

export function healthContextBudgetFields() {
  return {
    contextTokensMax: getLlmContextTokensMax(),
    slackTokens: getLlmContextSlackTokens(),
    tokenEstimateCharsPerToken: getTokenCharsPerToken(),
    chunkedModuleCalls: getChunkedModuleCallsMode(),
  };
}

/**
 * Truncate user prompt from the end so estimate + max_tokens + slack fits (for /api/llm/*).
 */
export function truncateUserContentToContext(systemPrompt, userContent, requestedMaxTokens, defaultMaxTokens) {
  const contextMax = getLlmContextTokensMax();
  const slack = getLlmContextSlackTokens();
  let u = String(userContent || '');
  const sys = String(systemPrompt || '');
  const maxTok = budgetedCompletionCap(requestedMaxTokens, defaultMaxTokens);
  const maxPromptTokens = contextMax - slack - maxTok;
  if (maxPromptTokens <= 0) return u.slice(0, Math.min(400, u.length));
  const suffix = '\n\n[truncated for LLM_CONTEXT_TOKENS_MAX]';
  if (estimatePromptTokens(sys, u) <= maxPromptTokens) return u;
  let lo = 0;
  let hi = u.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const trial = u.slice(0, mid) + suffix;
    if (estimatePromptTokens(sys, trial) <= maxPromptTokens) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? u.slice(0, lo) + suffix : u.slice(0, Math.min(400, u.length));
}
