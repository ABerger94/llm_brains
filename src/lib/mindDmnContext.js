import { clipTextComplete } from '../../shared/textClip.mjs';
import { MODULES } from '../../shared/pipelineModules.mjs';
import { ConversationMessage, MindBiography, SelfLedgerRevision } from './data';
import { buildMindBiographySharedMemoryDraft, fetchVoiceContextBlocksForBiography } from './mindBiographyContext';
import { getRuntimeSettings } from './runtimeSettings';
import { loadStructuralSelfForPipeline, buildWorkingMemorySeed } from './mindPersistence';
import { rowsToRecentDialogue } from './pipelineDialogueContext';

/**
 * Text to inject as DMN carryover for drift/sleep pipeline runs (latest DMN ledger, else biography).
 */
export async function loadDmnCarryoverTextForPhase(phase) {
  if (phase !== 'drift' && phase !== 'sleep') return undefined;
  const rows = await SelfLedgerRevision.list('-created_date', 24);
  const dmn = rows.find((r) => r.reason === 'dmn_internal_narrative');
  if (dmn?.identity_excerpt?.trim()) {
    return clipTextComplete(String(dmn.identity_excerpt), 5500, { ellipsis: true });
  }
  const bios = await MindBiography.list('-created_date', 1);
  const b = bios[0];
  if (b?.summary?.trim()) return clipTextComplete(String(b.summary), 3200, { ellipsis: true });
  if (b?.full_text?.trim()) return clipTextComplete(String(b.full_text), 3200, { ellipsis: true });
  return undefined;
}

function voiceSystemPromptFromSettings() {
  const rt = getRuntimeSettings();
  const ov = rt.modulePromptOverrides?.Voice;
  if (typeof ov === 'string' && ov.trim()) return ov.trim();
  const m = MODULES.find((x) => x.name === 'Voice');
  return m?.systemPrompt || '';
}

/**
 * Pipeline options for DMN: drift phase, moderate-low arousal (internal mode).
 */
export async function buildPipelineOptionsForDmnReflection() {
  const rt = getRuntimeSettings();
  const structuralSelf = await loadStructuralSelfForPipeline({ maxItems: 12 });
  const wmSeed = buildWorkingMemorySeed('', rt.pinnedWorkingMemory || []);
  const dialogueRows = await ConversationMessage.list('-created_date', 16);
  return {
    phase: 'drift',
    arousal: 0.4,
    intent: 'Default mode: internal narrative, continuity, and embodiment without an external task.',
    constitution: rt.mindConstitution || '',
    userModel: rt.userModel || {},
    mindDisplayName: String(rt.mindDisplayName || '').trim(),
    structuralSelf,
    workingMemorySeed: wmSeed,
    recentDialogue: rowsToRecentDialogue(dialogueRows, 16),
  };
}

export function parseDmnReflectionLLMOutput(result) {
  const text = String(result || '').trim();
  const upper = text.toUpperCase();
  const markers = [
    'INTERNAL_NARRATIVE:',
    'CONTINUITY_THREAD:',
    'TRAIT_AND_BOUNDARY:',
    'EMBODIED_ANCHOR:',
    'PERSPECTIVE_BOUNDARY:',
    'PERSPECTIVE_BOUNDARY_JSON:',
  ];
  const positions = markers
    .map((m) => ({ m, i: upper.indexOf(m) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i);

  function sliceAfter(marker) {
    const i = upper.indexOf(marker.toUpperCase());
    if (i === -1) return '';
    const start = i + marker.length;
    const next = positions.find((p) => p.i > i);
    const end = next ? next.i : text.length;
    return text.slice(start, end).trim();
  }

  const internalNarrative = sliceAfter('INTERNAL_NARRATIVE:');
  const continuityThread = sliceAfter('CONTINUITY_THREAD:');
  const traitAndBoundary = sliceAfter('TRAIT_AND_BOUNDARY:');
  const embodiedAnchor = sliceAfter('EMBODIED_ANCHOR:');
  let perspectiveBoundary = sliceAfter('PERSPECTIVE_BOUNDARY:');
  const jsonChunk = sliceAfter('PERSPECTIVE_BOUNDARY_JSON:');
  if (perspectiveBoundary.includes('PERSPECTIVE_BOUNDARY_JSON')) {
    perspectiveBoundary = perspectiveBoundary.split(/PERSPECTIVE_BOUNDARY_JSON/i)[0].trim();
  }

  const parts = [
    internalNarrative && `INTERNAL_NARRATIVE:\n${internalNarrative}`,
    continuityThread && `CONTINUITY_THREAD:\n${continuityThread}`,
    traitAndBoundary && `TRAIT_AND_BOUNDARY:\n${traitAndBoundary}`,
    embodiedAnchor && `EMBODIED_ANCHOR:\n${embodiedAnchor}`,
    perspectiveBoundary && `PERSPECTIVE_BOUNDARY:\n${perspectiveBoundary}`,
  ].filter(Boolean);

  const fullCombined = parts.length ? parts.join('\n\n---\n\n') : text;

  let perspectiveBoundaryJson = null;
  const brace = jsonChunk.indexOf('{');
  if (brace !== -1) {
    let depth = 0;
    let end = -1;
    for (let j = brace; j < jsonChunk.length; j += 1) {
      if (jsonChunk[j] === '{') depth += 1;
      if (jsonChunk[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end !== -1) {
      try {
        perspectiveBoundaryJson = JSON.parse(jsonChunk.slice(brace, end + 1));
      } catch {
        perspectiveBoundaryJson = null;
      }
    }
  }

  return {
    internalNarrative,
    continuityThread,
    traitAndBoundary,
    embodiedAnchor,
    perspectiveBoundary,
    perspectiveBoundaryJson,
    fullCombined,
  };
}

/**
 * LLM prompt for a Default Mode Network–style reflection (no live user turn).
 */
export async function composeDmnReflectionUserPrompt() {
  const base = await buildMindBiographySharedMemoryDraft();
  const draft = {
    ...base.draft,
    originalInput:
      '(Default mode network — no live user turn. Synthesize only from CONTEXT_AND_POLICY and SHARED_MEMORY_JSON.)',
    webFetchSuppressReason: 'DMN reflection uses local persistence only; web tools are not used for this task.',
  };

  const options = await buildPipelineOptionsForDmnReflection();
  const systemPrompt = voiceSystemPromptFromSettings();

  let policyBlock;
  let sharedMemoryJson;
  try {
    const blocks = await fetchVoiceContextBlocksForBiography(draft, options);
    policyBlock = blocks.policyBlock;
    sharedMemoryJson = blocks.sharedMemoryJson;
  } catch (e) {
    console.warn('[dmn] voice-context-blocks failed, using fallback:', e);
    const rt = getRuntimeSettings();
    policyBlock = `\n\nCONTEXT_AND_POLICY:\nRHYTHM: phase=drift arousal=0.4 (default mode).\nCONSTITUTION (binding on Identity/Voice):\n${clipTextComplete(String(rt.mindConstitution || ''), 6000, { ellipsis: true })}\n`;
    if (rt.userModel && Object.keys(rt.userModel).length) {
      policyBlock += `\nUSER_MODEL_JSON:\n${JSON.stringify(rt.userModel).slice(0, 8000)}\n`;
    }
    sharedMemoryJson = JSON.stringify(draft, null, 2).slice(0, 200_000);
  }

  const [prevDmnRows, prevBioList] = await Promise.all([
    SelfLedgerRevision.list('-created_date', 12),
    MindBiography.list('-created_date', 1),
  ]);
  const lastDmn = prevDmnRows.find((r) => r.reason === 'dmn_internal_narrative');
  const prevBio = prevBioList[0];

  const prevDmnSection = lastDmn?.identity_excerpt?.trim()
    ? `PREVIOUS DMN PASS (continuity):\n${clipTextComplete(lastDmn.identity_excerpt, 2000)}`
    : 'No prior DMN reflection in the self-ledger.';

  const prevBioSection = prevBio?.summary || prevBio?.full_text
    ? `LATEST AUTOBIOGRAPHY (narrative self, continuity):\n${prevBio.summary || clipTextComplete(prevBio.full_text, 900)}`
    : 'No mind biography yet.';

  const dmnTask = `SPECIAL_TASK — DEFAULT_MODE_NETWORK_REFLECTION

You simulate the brain's default mode when attention is not locked on an external task: autobiographical narrative, continuity of self, trait/boundary clarity, embodied/interoceptive anchoring, and perspective separation (self vs user vs unknown).

Respond in first person as this mind's inner voice — not as a third-party narrator describing an AI.

Constraints:
- Use ONLY CONTEXT_AND_POLICY and SHARED_MEMORY_JSON. Do not browse or invent facts outside them.
- Honor INTEROCEPTION and embodied signals in SHARED_MEMORY_JSON when framing EMBODIED_ANCHOR.

${prevBioSection}

${prevDmnSection}

Output format (use these exact section headers):

INTERNAL_NARRATIVE:
[150-280 words: free associative inner monologue tying memories, beliefs, goals, and open tensions — daydream / reflection tone]

CONTINUITY_THREAD:
[80-140 words: why this mind feels like the same ongoing self across sessions — link to timeline, biography, prior stances]

TRAIT_AND_BOUNDARY:
[80-140 words: traits, preferences, values, limits — what is "me" vs "not me" here]

EMBODIED_ANCHOR:
[60-120 words: moment-to-moment "felt" state — curiosity, load, uncertainty, integration — as bodily metaphor is fine (breath, weight, tempo)]

PERSPECTIVE_BOUNDARY:
[80-140 words: prose — what is asserted as this mind's own vs attributed to the user vs genuinely unknown]

PERSPECTIVE_BOUNDARY_JSON: {"selfClaims":[],"userAttributions":[],"sharedGround":[],"unknowns"}
(short strings, max 6 items per array; align with the prose above)`;

  const prompt = [
    'You are running as one module in a sequential cognitive pipeline.',
    'Use ONLY the shared memory provided. Do not assume hidden context.',
    '',
    dmnTask,
    policyBlock,
    '',
    'SHARED_MEMORY_JSON:',
    sharedMemoryJson,
  ].join('\n');

  return { prompt, systemPrompt, runs: base.runs };
}
