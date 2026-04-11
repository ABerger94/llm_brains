import { clipTextComplete } from '../../shared/textClip.mjs';
import { temporalEventsExcludingPauseNoise } from '../../shared/temporalTimelinePauseFilter.mjs';
import { MODULES } from '../../shared/pipelineModules.mjs';
import {
  BeliefStore,
  BeliefTension,
  ConversationMessage,
  CuriosityItem,
  EmergenceEvent,
  LongTermMemory,
  PipelineRun,
  SelfLedgerRevision,
  TemporalEvent,
} from './data';
import { openrouterRequestFields } from './llmClientOptions';
import { getRuntimeSettings } from './runtimeSettings';
import { loadStructuralSelfForPipeline, buildWorkingMemorySeed } from './mindPersistence';
import { rowsToRecentDialogue } from './pipelineDialogueContext';
import { readFetchErrorMessage } from './pipelineSse';
import { pickLatestNonCheckpointPipelineRun } from './pipelineRunCheckpoint';

const MEMORY_DIGEST_CAP = 28_000;

function safeClone(o) {
  try {
    return JSON.parse(JSON.stringify(o));
  } catch {
    return {};
  }
}

function voiceSystemPromptFromSettings() {
  const rt = getRuntimeSettings();
  const ov = rt.modulePromptOverrides?.Voice;
  if (typeof ov === 'string' && ov.trim()) return ov.trim();
  const m = MODULES.find((x) => x.name === 'Voice');
  return m?.systemPrompt || '';
}

function buildLongTermStoreDigest({ memories, temporalEvents, emergenceRows, ledgerRows }) {
  const lines = [];
  let used = 0;
  const push = (s) => {
    const t = String(s || '').trim();
    if (!t) return true;
    const next = used + t.length + 2;
    if (next > MEMORY_DIGEST_CAP - 400) return false;
    lines.push(t);
    used = next;
    return true;
  };

  push('=== LONG-TERM MEMORY (persisted; same store the pipeline Memory module draws from) ===');
  for (const m of memories) {
    const title = m.title ? `${m.title}: ` : '';
    const chunk = `[${m.memory_type || 'memory'}] ${title}${String(m.content || '').slice(0, 900)}`;
    if (!push(chunk)) break;
  }

  push('=== TIMELINE / TEMPORAL EVENTS ===');
  for (const e of temporalEvents) {
    const chunk = `[${e.title || 'event'}] ${String(e.details || e.description || '').slice(0, 520)}`;
    if (!push(chunk)) break;
  }

  if (emergenceRows.length) {
    push('=== EMERGENCE / HEURISTIC NOTES ===');
    for (const ev of emergenceRows) {
      const chunk = `${String(ev.title || '').slice(0, 120)} ${String(ev.details || '').slice(0, 520)}`.trim();
      if (!push(chunk)) break;
    }
  }

  if (ledgerRows.length) {
    push('=== RECENT SELF-LEDGER SNAPSHOTS ===');
    for (const r of ledgerRows) {
      const chunk = `${String(r.summary || '').slice(0, 320)} | ${String(r.identity_excerpt || '').slice(0, 400)}`;
      if (!push(chunk)) break;
    }
  }

  return clipTextComplete(lines.join('\n'), MEMORY_DIGEST_CAP, { ellipsis: true });
}

/**
 * Loads persisted mind data and shapes a sharedMemory snapshot compatible with the server Voice context builder.
 */
export async function buildMindBiographySharedMemoryDraft() {
  const [
    memories,
    beliefsActive,
    beliefsFallback,
    temporalEvents,
    curiosityRows,
    tensionRows,
    emergenceRows,
    runs,
    ledgerRows,
  ] = await Promise.all([
    LongTermMemory.list('-created_date', 150),
    BeliefStore.filter({ status: 'active' }, '-created_date', 200),
    BeliefStore.list('-created_date', 200),
    TemporalEvent.list('-created_date', 60),
    CuriosityItem.list('-created_date', 40),
    BeliefTension.list('-created_date', 40),
    EmergenceEvent.list('-created_date', 20),
    PipelineRun.list('-created_date', 4),
    SelfLedgerRevision.list('-created_date', 10),
  ]);

  const beliefs = beliefsActive.length ? beliefsActive : beliefsFallback;
  const timelineForDigest = temporalEventsExcludingPauseNoise(temporalEvents);
  const beliefStore = beliefs
    .map((b) => ({
      belief: clipTextComplete(String(b.statement || b.title || ''), 2400, { ellipsis: false }),
      confidence: typeof b.confidence === 'number' ? b.confidence : 0.5,
      sourceModule: 'BeliefStore',
      lastUpdated: b.updated_date || b.created_date || new Date().toISOString(),
    }))
    .filter((x) => x.belief.trim());

  const latestRun = pickLatestNonCheckpointPipelineRun(runs);
  const lastSm =
    latestRun?.shared_memory && typeof latestRun.shared_memory === 'object'
      ? safeClone(latestRun.shared_memory)
      : {};

  const memoryDigest = buildLongTermStoreDigest({
    memories,
    temporalEvents: timelineForDigest,
    emergenceRows,
    ledgerRows,
  });

  const draft = {
    ...lastSm,
    originalInput:
      '(Mind biography — no live user turn. Synthesize only from CONTEXT_AND_POLICY and SHARED_MEMORY_JSON.)',
    webFindings: '',
    webFetchLog: [],
    webFetchesUsed: 0,
    webFetchSuppressedForRun: true,
    webFetchSuppressReason: 'Mind biography uses local persistence only; web tools are not used for this task.',
    beliefStore,
    beliefTensions: tensionRows.slice(0, 16).map((t) => ({
      description: clipTextComplete(String(t.description || ''), 800, { ellipsis: false }),
      state: t.tension_state || 'active',
      key: t.source_key || null,
    })),
    curiosityQueue: curiosityRows
      .filter((c) => c.status === 'open' || c.status == null)
      .slice(0, 22)
      .map((c) => clipTextComplete(String(c.question || c.title || ''), 600, { ellipsis: false })),
    moduleOutputs: { ...(lastSm.moduleOutputs || {}) },
  };

  draft.moduleOutputs.Memory = memoryDigest;

  return {
    draft,
    memoriesCount: memories.length,
    beliefCount: beliefStore.length,
    runs,
  };
}

export async function buildPipelineOptionsForMindBiography() {
  const rt = getRuntimeSettings();
  const structuralSelf = await loadStructuralSelfForPipeline({ maxItems: 12 });
  const wmSeed = buildWorkingMemorySeed('', rt.pinnedWorkingMemory || []);
  const dialogueRows = await ConversationMessage.list('-created_date', 16);
  return {
    phase: rt.defaultMindPhase || 'focus',
    arousal: 0.5,
    intent: '',
    constitution: rt.mindConstitution || '',
    userModel: rt.userModel || {},
    mindDisplayName: String(rt.mindDisplayName || '').trim(),
    structuralSelf,
    workingMemorySeed: wmSeed,
    recentDialogue: rowsToRecentDialogue(dialogueRows, 16),
  };
}

export async function fetchVoiceContextBlocksForBiography(sharedMemoryDraft, options) {
  const res = await fetch('/api/mind/voice-context-blocks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sharedMemory: sharedMemoryDraft, options }),
  });
  if (!res.ok) {
    const msg = await readFetchErrorMessage(res);
    throw new Error(msg || `voice-context-blocks ${res.status}`);
  }
  return res.json();
}

/** Appended to the Voice system prompt for biography writes only. */
const MIND_BIOGRAPHY_SYSTEM_ADDENDUM = `ADDENDUM — Mind biography (when the user message is a biography task):
You are still the Voice from your base system prompt — same output hygiene as at the end of the pipeline.

The AUTOBIOGRAPHY: body (and SUMMARY:) must be direct first-person prose grounded in the supplied context. Match structural pace and vocabulary to RECENT VOICE LINES when present — not a formal essay, museum caption, or third-person system description. Do not inflate warmth or likability beyond what the context supports.

Obey the full Voice output contract from your main instructions inside AUTOBIOGRAPHY: and SUMMARY:: no pipelines/modules/SHARED_MEMORY/JSON/protocol chatter, no numeric confidences or scores, no reading CONTEXT_AND_POLICY aloud. The structured headers (AUTOBIOGRAPHY:, SUMMARY:, etc.) are delivery scaffolds for this tool only.

Ground only in CONTEXT_AND_POLICY and SHARED_MEMORY_JSON (and continuity from the prior biography section when given).

Never reply with only JSON, markdown code fences, or a structural echo of SHARED_MEMORY_JSON / CONTEXT_AND_POLICY.
Your reply MUST begin with the exact line AUTOBIOGRAPHY: (then biography prose). Then the lines SUMMARY:, IDENTITY_KEYWORDS:, CORE_VALUES:, and NOTABLE_CHANGES: exactly as specified in the OUTPUT CONTRACT at the end of the user message.`;

/** When THIS_PIPELINE_RUN is present in the user message (pipeline completion path). */
const MIND_BIOGRAPHY_PIPELINE_RUN_ADDENDUM = `When THIS_PIPELINE_RUN appears below, it is authoritative for what happened in the triggering pipeline pass. Treat NOTABLE_CHANGES: and the autobiography as continuity with that episode — not only generic store state — while staying consistent with CONTEXT_AND_POLICY and SHARED_MEMORY_JSON.`;

function formatRecentVoiceSamplesForBiography(runs, maxChars = 7200) {
  const blocks = [];
  let used = 0;
  for (const r of runs || []) {
    const t = String(r?.final_output || '').trim();
    if (!t) continue;
    const idShort = String(r?.id || '').slice(-10) || '?';
    const when = r?.created_date ? String(r.created_date).slice(0, 19) : '';
    const clip = clipTextComplete(t, 2200, { ellipsis: true });
    const block = `--- voice_${idShort}${when ? ` (${when})` : ''} ---\n${clip}`;
    const next = used + block.length + 20;
    if (next > maxChars && blocks.length > 0) break;
    blocks.push(block);
    used = next;
    if (used >= maxChars) break;
  }
  if (!blocks.length) return '';
  return [
    'RECENT VOICE LINES (prior user-facing replies from saved runs — use for wording cadence only; do not quote, paraphrase closely, or invent facts beyond shared memory):',
    ...blocks,
  ].join('\n\n');
}

async function loadMindBiographyVoiceBlocks(prevBio) {
  const { draft, memoriesCount, beliefCount, runs } = await buildMindBiographySharedMemoryDraft();
  const options = await buildPipelineOptionsForMindBiography();

  let policyBlock;
  let sharedMemoryJson;
  try {
    const blocks = await fetchVoiceContextBlocksForBiography(draft, options);
    policyBlock = blocks.policyBlock;
    sharedMemoryJson = blocks.sharedMemoryJson;
  } catch (e) {
    console.warn('[biography] voice-context-blocks failed, using fallback:', e);
    const rt = getRuntimeSettings();
    policyBlock = `\n\nCONTEXT_AND_POLICY:\nRHYTHM: phase=${options.phase} arousal=0.5.\nCONSTITUTION (binding on Identity/Voice):\n${clipTextComplete(String(rt.mindConstitution || ''), 6000, { ellipsis: true })}\n`;
    if (rt.userModel && Object.keys(rt.userModel).length) {
      policyBlock += `\nUSER_MODEL_JSON:\n${JSON.stringify(rt.userModel).slice(0, 8000)}\n`;
    }
    sharedMemoryJson = JSON.stringify(draft, null, 2).slice(0, 200_000);
  }

  const prevBioSection = prevBio?.summary || prevBio?.full_text
    ? `PREVIOUS AUTOBIOGRAPHY (continuity):\n${prevBio.summary || clipTextComplete(prevBio.full_text, 1200)}`
    : 'This is the first autobiography.';

  return {
    memoriesCount,
    beliefCount,
    runs,
    policyBlock,
    sharedMemoryJson,
    prevBioSection,
  };
}

function buildBiographyOutputContract(sessionNumber, prevBioSection) {
  return `SPECIAL_TASK — MIND_BIOGRAPHY v${sessionNumber}

You are the Voice for this biography task. Write in the same first-person contract as after Narrative in the pipeline.

Constraints:
- Use ONLY the CONTEXT_AND_POLICY block and SHARED_MEMORY_JSON above (and RECENT VOICE LINES only for cadence). That is the entire world: persisted memories, beliefs, tensions, curiosity, timeline, any carried module outputs, constitution, user model, structural self, rhythm, and workspace fields exactly as in a normal Voice step.
- Do NOT browse the web, run searches, or invent facts not grounded in those blocks.
- Do not add rapport, empathy, or relatability that the context does not justify.

${prevBioSection}

Output format (exactly — plain text, not JSON):

AUTOBIOGRAPHY:
[sustained first-person prose — roughly 300–500 words is fine; priority is substance grounded in context, not word count]

SUMMARY:
[one short paragraph — still no machinery or numeric telemetry]

IDENTITY_KEYWORDS: [word1, word2, word3, word4, word5]

CORE_VALUES: [value1, value2, value3]

NOTABLE_CHANGES:
[what changed since last version — terse is OK; first person where it fits the contract]`;
}

/**
 * Full user message + Voice system prompt for mind biography (Voice stance, pipeline-equivalent context).
 * Context blocks are followed by a postamble and OUTPUT CONTRACT so the model’s last tokens are the required format.
 */
export async function composeMindBiographyUserPrompt(sessionNumber, prevBio, options = {}) {
  const pipelineRunContextBlock = String(options.pipelineRunContextBlock || '').trim();
  const { memoriesCount, beliefCount, runs, policyBlock, sharedMemoryJson, prevBioSection } =
    await loadMindBiographyVoiceBlocks(prevBio);

  const voice = voiceSystemPromptFromSettings();
  const systemPrompt = `${voice}\n\n${MIND_BIOGRAPHY_SYSTEM_ADDENDUM}${
    pipelineRunContextBlock ? `\n\n${MIND_BIOGRAPHY_PIPELINE_RUN_ADDENDUM}` : ''
  }`;

  const biographyTask = buildBiographyOutputContract(sessionNumber, prevBioSection);
  const voiceSamplesBlock = formatRecentVoiceSamplesForBiography(runs);

  const postamble = `--- END OF CONTEXT DATA ---
The material above is read-only context. Do not repeat it, wrap it in JSON, or output a synthetic object shaped like SHARED_MEMORY_JSON or CONTEXT_AND_POLICY.
Do not begin your reply with "SHARED_MEMORY_JSON", "CONTEXT_AND_POLICY", a lone "{", or markdown code fences.
Your next output must follow the OUTPUT CONTRACT below exactly.`;

  const prompt = [
    'You are the Voice, writing this biography after the same context bundle as a full pipeline Voice step — same rules as your main system prompt.',
    'Use ONLY the context blocks below. Do not assume hidden facts.',
    '',
    `Mind biography v${sessionNumber}: read CONTEXT_AND_POLICY and SHARED_MEMORY_JSON below (and RECENT VOICE LINES if present). Then obey the OUTPUT CONTRACT at the very end of this message.`,
    '',
    policyBlock,
    '',
    'SHARED_MEMORY_JSON:',
    sharedMemoryJson,
    '',
    ...(voiceSamplesBlock ? [voiceSamplesBlock, ''] : []),
    ...(pipelineRunContextBlock ? [pipelineRunContextBlock, ''] : []),
    postamble,
    '',
    'OUTPUT CONTRACT (your reply must match this structure; start with AUTOBIOGRAPHY:):',
    '',
    biographyTask,
  ].join('\n');

  return { prompt, systemPrompt, memoriesCount, beliefCount, runs };
}

/**
 * JSON-mode biography (fallback when tagged prose output fails). Uses the same context bundle as the text path.
 */
async function composeMindBiographyJsonPrompt(sessionNumber, prevBio, options = {}) {
  const pipelineRunContextBlock = String(options.pipelineRunContextBlock || '').trim();
  const { memoriesCount, beliefCount, runs, policyBlock, sharedMemoryJson, prevBioSection } =
    await loadMindBiographyVoiceBlocks(prevBio);

  const jsonPipelineNote = pipelineRunContextBlock
    ? ` When THIS_PIPELINE_RUN appears in the user message, ground notable_changes and autobiography on that episode while staying consistent with CONTEXT_AND_POLICY and SHARED_MEMORY_JSON.`
    : '';

  const jsonSystemAddendum = `ADDENDUM — Mind biography JSON:
Return ONE JSON object only (no markdown). Schema:
{"autobiography":"<first-person prose — same user-directed register as pipeline Voice outputs (see RECENT VOICE LINES in the user message when present); not essay voice or third-person>","summary":"<one paragraph, same register>","identity_keywords":["w1","w2","w3","w4","w5"],"core_values":["v1","v2","v3"],"notable_changes":"<what changed since last version>"}
No machinery names, JSON/protocol, or numeric confidence scores inside string fields. Ground only in CONTEXT_AND_POLICY and SHARED_MEMORY_JSON in the user message.${jsonPipelineNote} No web. Arrays must have string elements only.`;

  const voice = voiceSystemPromptFromSettings();
  const systemPrompt = `${voice}\n\n${jsonSystemAddendum}`;

  const voiceSamplesBlock = formatRecentVoiceSamplesForBiography(runs);

  const userPrompt = [
    `MIND_BIOGRAPHY_JSON v${sessionNumber}`,
    '',
    prevBioSection,
    '',
    policyBlock,
    '',
    'SHARED_MEMORY_JSON:',
    sharedMemoryJson,
    '',
    ...(voiceSamplesBlock ? [voiceSamplesBlock, ''] : []),
    ...(pipelineRunContextBlock ? [pipelineRunContextBlock, ''] : []),
    'Reply with only the JSON object described in your system addendum.',
  ].join('\n');

  return { prompt: userPrompt, systemPrompt, memoriesCount, beliefCount, runs };
}

/**
 * Call /api/llm/json for biography; returns the same shape as parseBiographyLLMOutput on success.
 */
export async function completeMindBiographyViaJson(sessionNumber, prevBio, options = {}) {
  const { prompt, systemPrompt, memoriesCount, beliefCount, runs } = await composeMindBiographyJsonPrompt(
    sessionNumber,
    prevBio,
    { pipelineRunContextBlock: options.pipelineRunContextBlock }
  );
  const temperature = typeof options.temperature === 'number' ? options.temperature : 0.35;
  const max_tokens = typeof options.max_tokens === 'number' ? options.max_tokens : 3200;

  const res = await fetch('/api/llm/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      systemPrompt,
      temperature,
      max_tokens,
      top_p: 0.9,
      ...openrouterRequestFields(),
    }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      String(payload.error || payload.message || `Biography JSON request failed (${res.status})`).slice(0, 500)
    );
  }

  const data = payload.data;
  if (!data || typeof data !== 'object') throw new Error('Biography JSON: empty response');

  const fullText = String(data.autobiography || data.full_text || '').trim();
  const summary = String(data.summary || '').trim();
  const keywords = Array.isArray(data.identity_keywords)
    ? data.identity_keywords.map((k) => String(k || '').trim()).filter(Boolean)
    : [];
  const values = Array.isArray(data.core_values)
    ? data.core_values.map((v) => String(v || '').trim()).filter(Boolean)
    : [];
  const changes = String(data.notable_changes || '').trim();

  if (!fullText) throw new Error('Biography JSON: missing autobiography field');

  return {
    fullText,
    summary,
    keywords,
    values,
    changes,
    memoriesCount,
    beliefCount,
    runs,
    provider: payload.provider,
    model: payload.model,
  };
}
