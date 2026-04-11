import { clipTextComplete } from '../../shared/textClip.mjs';
import { CuriosityItem, GoalItem, LongTermMemory, MindBiography, TemporalEvent } from './data';
import {
  composeMindBiographyUserPrompt,
  completeMindBiographyViaJson,
} from './mindBiographyContext';
import { llmService } from '../services/llmService';
import { notifyMindStorageChanged } from './mindStorageEvents';

/** True if saved narrative would be prompt echo / JSON continuation rather than prose. */
export function isLikelyBiographyEcho(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  const head = t.slice(0, 200).toLowerCase();
  if (head.startsWith('shared_memory_json') || head.startsWith('context_and_policy')) return true;
  if (/^```(?:json|text)?\s*\{/i.test(t)) return true;
  if (t[0] === '{') {
    const probe = t.slice(0, 2800);
    if (
      /\bCONTEXT_AND_POLICY\b/i.test(probe) ||
      /\bMODULE_OUTPUTS\b/i.test(probe) ||
      /\bSHARED_MEMORY_JSON\b/i.test(probe)
    ) {
      return true;
    }
  }
  if (/^\s*[[{]\s*"(?:CONTEXT_AND_POLICY|MODULE_OUTPUTS|sessionId|SHARED_MEMORY_JSON)"/i.test(t)) return true;
  return false;
}

export function parseBiographyLLMOutput(result) {
  let raw = String(result || '').trim();
  raw = raw.replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  const autoIdx = raw.search(/\bAUTOBIOGRAPHY:\s*/i);
  const fromAuto = autoIdx >= 0 ? raw.slice(autoIdx) : raw;
  const autobioMatch = fromAuto.match(/^AUTOBIOGRAPHY:\s*([\s\S]*?)(?=\n\s*SUMMARY:\s*|$)/im);
  const hadAutobiographyMarker = autoIdx >= 0;
  const autobiBody = (autobioMatch?.[1] ?? '').trim();
  const fullText = autobiBody.length > 0 ? autobiBody : hadAutobiographyMarker ? '' : raw.trim();

  const summaryMatch = raw.match(/SUMMARY:\s*([\s\S]*?)(?=IDENTITY_KEYWORDS:|$)/i);
  const keywordsMatch = raw.match(/IDENTITY_KEYWORDS:\s*\[?([^\]\n]+)\]?/i);
  const valuesMatch = raw.match(/CORE_VALUES:\s*\[?([^\]\n]+)\]?/i);
  const changesMatch = raw.match(/NOTABLE_CHANGES:\s*([\s\S]*?)$/i);

  const summary = summaryMatch?.[1]?.trim() || '';
  const keywords =
    keywordsMatch?.[1]
      ?.split(',')
      .map((k) => k.trim())
      .filter(Boolean) || [];
  const values =
    valuesMatch?.[1]
      ?.split(',')
      .map((v) => v.trim())
      .filter(Boolean) || [];
  const changes = changesMatch?.[1]?.trim() || '';

  return { fullText, summary, keywords, values, changes, hadAutobiographyMarker };
}

export function isParsedBiographyUsable(parsed, rawResponse) {
  if (!parsed.fullText || parsed.fullText.length < 80) return false;
  if (isLikelyBiographyEcho(parsed.fullText)) return false;
  if (!parsed.hadAutobiographyMarker && isLikelyBiographyEcho(String(rawResponse || ''))) return false;
  return true;
}

/**
 * Builds the THIS_PIPELINE_RUN block for pipeline-triggered biography (same clip budgets as legacy touch).
 */
export async function formatPipelineRunContextForBiography({
  sm,
  voiceOutput,
  narrativeText,
  pipelineRunId,
  source,
  curiosityPursuitContext,
  goalPursuitContext,
}) {
  const voice = clipTextComplete(String(voiceOutput || ''), 12000, { ellipsis: false });
  const narrative = clipTextComplete(String(narrativeText || ''), 16000, { ellipsis: false });
  const phen = clipTextComplete(String(sm?.phenomenalNow?.line || ''), 1200, { ellipsis: false });

  const lines = [
    'THIS_PIPELINE_RUN (authoritative for what just happened):',
    `pipeline_run_id: ${String(pipelineRunId || '(unknown)')}`,
  ];
  if (source) lines.push(`source: ${String(source)}`);
  if (phen) lines.push(`Phenomenal now: ${phen}`);

  const cid = curiosityPursuitContext?.parentCuriosityId;
  if (cid) {
    try {
      const c = await CuriosityItem.retrieve(cid);
      if (c) {
        lines.push(
          `This run was framed as curiosity pursuit for question id ${cid}: ${clipTextComplete(String(c.question || c.title || ''), 400, { ellipsis: false })}`
        );
      } else {
        lines.push(`This run was framed as curiosity pursuit for question id ${cid}.`);
      }
    } catch {
      lines.push(`This run was framed as curiosity pursuit for question id ${cid}.`);
    }
  }

  const gid = goalPursuitContext?.goalId ?? goalPursuitContext?.parentGoalId;
  if (gid) {
    try {
      const g = await GoalItem.retrieve(gid);
      if (g) {
        lines.push(
          `This run was framed as goal pursuit for goal id ${gid}: ${clipTextComplete(String(g.goal_statement || g.title || ''), 400, { ellipsis: false })}`
        );
      } else {
        lines.push(`This run was framed as goal pursuit for goal id ${gid}.`);
      }
    } catch {
      lines.push(`This run was framed as goal pursuit for goal id ${gid}.`);
    }
  }

  if (narrative) lines.push(`Narrative:\n${narrative}`);
  if (voice) lines.push(`Voice:\n${voice}`);

  return clipTextComplete(lines.join('\n\n'), 28000, { ellipsis: false });
}

/**
 * Same LLM + parsing path as Mind Biography "Write New Version"; does not persist.
 * @param {object|undefined} prevBio — latest biography row, or omit and load from DB
 * @param {{ pipelineRunContextBlock?: string, prevBioOverride?: object }} [options]
 */
export async function generateMindBiographyViaLlm(prevBio, options = {}) {
  const prevBioList = await MindBiography.list('-created_date', 1);
  const effectivePrev = options.prevBioOverride ?? prevBio ?? prevBioList[0];
  const sessionNumber = (Number(effectivePrev?.session_number ?? effectivePrev?.version) || 0) + 1;

  const composeOpts = { pipelineRunContextBlock: options.pipelineRunContextBlock };

  const { prompt, systemPrompt, memoriesCount, beliefCount, runs } = await composeMindBiographyUserPrompt(
    sessionNumber,
    effectivePrev,
    composeOpts
  );

  const resultRaw = await llmService.InvokeLLM({
    prompt,
    systemPrompt,
    temperature: 0.65,
    max_tokens: 2800,
  });

  const result = (() => {
    const t = String(resultRaw || '');
    if (t.startsWith('API Error:') || t.startsWith('Error:')) {
      throw new Error(`Mind biography: ${t}`);
    }
    return t;
  })();

  let parsed = parseBiographyLLMOutput(result);
  let memoriesCountEff = memoriesCount;
  let beliefCountEff = beliefCount;
  let runsEff = runs;

  if (!isParsedBiographyUsable(parsed, result)) {
    const j = await completeMindBiographyViaJson(sessionNumber, effectivePrev, {
      pipelineRunContextBlock: options.pipelineRunContextBlock,
    });
    parsed = {
      fullText: j.fullText,
      summary: j.summary,
      keywords: j.keywords,
      values: j.values,
      changes: j.changes,
      hadAutobiographyMarker: true,
    };
    memoriesCountEff = j.memoriesCount;
    beliefCountEff = j.beliefCount;
    runsEff = j.runs;
  }

  return {
    sessionNumber,
    fullText: parsed.fullText,
    summary: parsed.summary,
    keywords: parsed.keywords,
    values: parsed.values,
    changes: parsed.changes,
    memoriesCount: memoriesCountEff,
    beliefCount: beliefCountEff,
    runs: runsEff,
    rawResult: result,
  };
}

/**
 * @param {{ sessionNumber: number, fullText: string, summary: string, keywords: string[], values: string[], changes: string, memoriesCount: number, beliefCount: number, sessionId: string, source: 'biography' | 'pipeline-biography' | 'scheduled-biography' }} args
 */
export async function persistMindBiographyVersion({
  sessionNumber,
  fullText,
  summary,
  keywords,
  values,
  changes,
  memoriesCount,
  beliefCount,
  sessionId,
  source,
}) {
  const ltmSource = source === 'biography' ? 'biography' : source;
  const temporalSource = source === 'biography' ? 'biography' : source;

  await MindBiography.create({
    version: sessionNumber,
    session_number: sessionNumber,
    session_id: sessionId,
    full_text: fullText,
    summary,
    identity_keywords: keywords,
    core_values: values,
    notable_changes: changes,
    belief_count: beliefCount,
    memory_count: memoriesCount,
  });

  await LongTermMemory.create({
    title: `Mind biography v${sessionNumber}`,
    content: fullText,
    memory_type: 'semantic',
    source: ltmSource,
  });

  await TemporalEvent.create({
    title: 'identity_shift',
    details: `Biography v${sessionNumber} written. Notable: ${clipTextComplete(changes, 280, { ellipsis: true })}`,
    source: temporalSource,
  });

  notifyMindStorageChanged({ source: 'biography' });
}
