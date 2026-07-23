import { llmService } from '../services/llmService';
import { notifyMindStorageChanged } from './mindStorageEvents';
import { clipTextComplete } from '../../shared/textClip.mjs';
import { getRuntimeSettings } from './runtimeSettings';
import { getCuriosityPagePursuitSnapshot } from './curiosityPagePursuitStore';
import { runGraphPipelineOneShot } from './runGraphPipelineOneShot';
import { isPipelinePauseOutcome } from './pipelinePauseOutcome';
import { resolvePursuitResumeFromLastPipelineRun } from './pipelinePursuitResume';
import { normalizeModuleOutputsFromServer } from './cognitiveModules';
import { effectiveItemPriority } from './priorityUtils';
import { getGraphSessionIdForPersistence } from './graphPipelineSessionScope';
import {
  getActiveMindEntityProfile,
  getMindEntityStores,
  normalizeScheduledTaskMindStorageProfile,
  setActiveMindEntityProfile,
} from './mindEntityContext';

function truncate(s, n) {
  return clipTextComplete(String(s || ''), n, { ellipsis: true });
}

/**
 * Prefer Voice; if empty or tiny, use Narrative / Language / Integration so pursuits still mark resolved
 * when the stack produced an answer but Voice was skipped, deferred, or trimmed away.
 * @param {object} [rawOutputs] persistGraphPipelineStreamResult.moduleOutputs
 * @param {object} [sharedMemory] sharedMemory.moduleOutputs (merged with rawOutputs)
 */
export function buildCuriosityResolutionText(voiceText, rawOutputs, sharedMemory) {
  const mo = { ...(sharedMemory?.moduleOutputs && typeof sharedMemory.moduleOutputs === 'object' ? sharedMemory.moduleOutputs : {}), ...(rawOutputs && typeof rawOutputs === 'object' ? rawOutputs : {}) };
  const v = String(voiceText || '').trim();
  if (v.length >= 8) return clipTextComplete(v, 24_000, { ellipsis: true });

  try {
    const moNorm = normalizeModuleOutputsFromServer(mo);
    const vNorm = String(moNorm.voice || '').trim();
    if (vNorm.length >= 8) return clipTextComplete(vNorm, 24_000, { ellipsis: true });
    for (const alt of ['narrative', 'language', 'integration']) {
      const t = String(moNorm[alt] || '').trim();
      if (t.length >= 16) return clipTextComplete(t, 24_000, { ellipsis: true });
    }
  } catch {
    /* ignore */
  }

  const pn = String(
    (sharedMemory && typeof sharedMemory === 'object' && sharedMemory.phenomenalNow?.line) ||
      (sharedMemory && typeof sharedMemory === 'object' && sharedMemory.phenomenal_now?.line) ||
      ''
  ).trim();
  if (pn.length >= 16) return clipTextComplete(pn, 24_000, { ellipsis: true });

  for (const k of ['Voice', 'voice', 'Narrative', 'narrative', 'Language', 'language']) {
    const t = String(mo[k] || '').trim();
    if (t.length >= 16) return clipTextComplete(t, 24_000, { ellipsis: true });
  }
  const integ = String(mo.Integration || mo.integration || '').trim();
  if (integ.length > 120) {
    return clipTextComplete(integ, 24_000, { ellipsis: true });
  }
  if (v.length > 0) return clipTextComplete(v, 24_000, { ellipsis: true });
  return 'Pipeline run completed (no Voice or Narrative text captured). See pursuit panel or PipelineRun for this leg.';
}

/**
 * Pick the next curiosity item to pursue (open + dormant, by priority then age).
 * Uses {@link getMindEntityStores} — set active mind profile (e.g. scheduled task) before calling.
 */
export async function resolveCuriosityItemForScheduledPursuit(task) {
  const { CuriosityItem } = getMindEntityStores();
  const tid = task?.target_curiosity_id;
  if (tid) {
    const item = await CuriosityItem.retrieve(String(tid));
    if (!item) return { message: 'Target curiosity not found — skipped.' };
    const st = item.status || 'open';
    if (st !== 'open' && st !== 'dormant') return { message: 'Target curiosity is not open or dormant — skipped.' };
    return { item };
  }
  const item = await pickCuriosityItemForPursuit();
  if (!item) return { message: 'No open or dormant curiosity items — skipped.' };
  return { item };
}

export async function pickCuriosityItemForPursuit() {
  const { CuriosityItem } = getMindEntityStores();
  const [open, dormant] = await Promise.all([
    CuriosityItem.filter({ status: 'open' }, '-created_date', 40),
    CuriosityItem.filter({ status: 'dormant' }, '-created_date', 20),
  ]);
  const pool = [...open, ...dormant].filter(Boolean);
  if (!pool.length) return null;
  pool.sort((a, b) => {
    const pa = effectiveItemPriority(a);
    const pb = effectiveItemPriority(b);
    if (pb !== pa) return pb - pa;
    return new Date(a.created_date || 0).getTime() - new Date(b.created_date || 0).getTime();
  });
  return pool[0];
}

/**
 * User / graph input framing a self-directed curiosity pass.
 */
export function buildCuriosityPursuitGraphPrompt(item) {
  const q = String(item.question || '').trim();
  const thread = item.pursuit_thread ? String(item.pursuit_thread) : '';
  return `[Curiosity pursuit — scheduled / autonomous]

This is not the human user's direct message; this mind is pursuing its own open question.

QUESTION: ${q}
THREAD SO FAR: ${thread || '(none)'}

Think through this with the full stack: use beliefs and memories in context, note tensions, and answer as Voice with a clear tentative synthesis and a concrete next step if more work remains.`;
}

async function loadBeliefsAndMemoriesForPursuit() {
  const { BeliefStore, LongTermMemory } = getMindEntityStores();
  const active = await BeliefStore.filter({ status: 'active' }, '-created_date', 15);
  const beliefsForPrompt = active.length
    ? active
    : (await BeliefStore.list('-created_date', 12)).slice(0, 12);
  const memories = await LongTermMemory.list('-created_date', 12);
  return { beliefsForPrompt, memories };
}

/**
 * Same contract as Mind → Curiosity → Pursue in the UI: LLM reflection, resolution field, LTM note, counters.
 * Caller should set status to `pursuing` before calling.
 * @param {string} [opts.mindStorageProfile] `primary` or `playgroundMirror`
 */
export async function runCuriosityPursuitLlmOnly(item, { mindStorageProfile } = {}) {
  const normalized = normalizeScheduledTaskMindStorageProfile(mindStorageProfile);
  const prev = getActiveMindEntityProfile();
  setActiveMindEntityProfile(normalized);
  try {
    const { CuriosityItem, LongTermMemory } = getMindEntityStores();
    const { beliefsForPrompt, memories } = await loadBeliefsAndMemoriesForPursuit();
    const thread = item.pursuit_thread ? String(item.pursuit_thread) : '';

    const exploration = await llmService.InvokeLLM({
      prompt: `You are a curious cognitive AI actively pursuing a question you generated for yourself.

QUESTION: ${item.question}
PURSUIT THREAD: ${thread || '(none)'}

YOUR CURRENT BELIEFS:
${beliefsForPrompt
  .map(
    (b) =>
      `- "${String(b.statement || b.title || '')}" (${Math.round((b.confidence ?? 0.5) * 100)}% confidence)`
  )
  .join('\n')}

RECENT MEMORIES:
${memories
  .slice(0, 8)
  .map((m) => `- [${m.memory_type || 'memory'}] ${String(m.content || m.title || '').slice(0, 180)}`)
  .join('\n')}

Explore this question deeply. What do you currently think? What does your belief system and memory suggest? What tensions or insights arise? End with a tentative answer or next step.`,
      max_tokens: 1800,
      temperature: 0.65,
    });

    const latest = await CuriosityItem.retrieve(item.id);
    const explorationTrim = String(exploration || '').trim();
    await CuriosityItem.update(item.id, {
      status: explorationTrim.length >= 20 ? 'resolved' : 'open',
      resolution: exploration,
      times_returned_to: (latest?.times_returned_to ?? item.times_returned_to ?? 0) + 1,
    });

    await LongTermMemory.create({
      title: `Curiosity pursuit: ${truncate(item.question, 100)}`,
      content: `Curiosity pursuit: ${item.question}\n\n${exploration}`,
      memory_type: 'semantic',
      source: 'curiosity-pursuit',
    });

    notifyMindStorageChanged({ source: 'curiosity' });
    notifyMindStorageChanged({ source: 'long-term-memory' });

    return truncate(exploration, 400) || 'Curiosity pursuit complete.';
  } finally {
    setActiveMindEntityProfile(prev);
  }
}

/**
 * @param {{ rawOutputs?: object, sharedMemory?: object }} [extras]
 * Uses {@link getMindEntityStores} — active profile must match the pursuit (caller sets via chain or scheduler).
 */
export async function finalizePursuedCuriosityAfterGraph(itemId, voiceText, pipelineRunId, extras = {}) {
  const { CuriosityItem } = getMindEntityStores();
  const latest = await CuriosityItem.retrieve(itemId);
  if (!latest) return;
  const { rawOutputs = null, sharedMemory = null } = extras || {};
  const voice = buildCuriosityResolutionText(voiceText, rawOutputs, sharedMemory);
  if (!String(voice || '').trim()) return;

  const prevRun = latest.last_pursuit_pipeline_run_id != null ? String(latest.last_pursuit_pipeline_run_id) : '';
  const thisRun = pipelineRunId != null ? String(pipelineRunId) : '';
  if (
    (latest.status || 'open') === 'resolved' &&
    String(latest.resolution || '').trim() &&
    thisRun &&
    prevRun === thisRun
  ) {
    return;
  }

  const thread = latest.pursuit_thread ? String(latest.pursuit_thread) : '';
  const append = `\n\n---\n${voice}`;
  await CuriosityItem.update(itemId, {
    status: 'resolved',
    resolution: voice,
    times_returned_to: (latest.times_returned_to ?? 0) + 1,
    last_pursuit_pipeline_run_id: pipelineRunId || null,
    pursuit_thread: clipTextComplete((thread + append).trim(), 12_000, { ellipsis: true }),
  });
}

export async function pickNextDeepPursuitChildFromParent(parentId, maxDepth) {
  const { CuriosityItem } = getMindEntityStores();
  const children = await CuriosityItem.filter({ parent_curiosity_id: parentId }, '-created_date', 60);
  const pool = children.filter((c) => {
    const st = c.status || 'open';
    if (st !== 'open' && st !== 'dormant') return false;
    const d = Number(c.pursuit_depth ?? 0);
    return d < maxDepth;
  });
  if (!pool.length) return null;
  pool.sort((a, b) => {
    const pa = effectiveItemPriority(a);
    const pb = effectiveItemPriority(b);
    if (pb !== pa) return pb - pa;
    return new Date(a.created_date || 0).getTime() - new Date(b.created_date || 0).getTime();
  });
  return pool[0];
}

/**
 * Full graph pursuit with optional chained child runs (settings caps).
 * @param {(evt: object) => void} [opts.onPipelineSse] - forwarded to each `runGraphPipelineOneShot` (`onSseEvent`)
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.mindStorageProfile] `primary` or `playgroundMirror`
 * @returns {Promise<{ pipelinePaused: boolean }>}
 */
export async function runCuriosityDeepPursuitChain(
  startItem,
  { onProgress, onPipelineSse, signal, mindStorageProfile } = {}
) {
  const normalized = normalizeScheduledTaskMindStorageProfile(mindStorageProfile);
  const prev = getActiveMindEntityProfile();
  setActiveMindEntityProfile(normalized);
  try {
    const { CuriosityItem } = getMindEntityStores();
    const rt = getRuntimeSettings();
    const maxRuns = Math.max(1, Math.floor(Number(rt.curiosityDeepPursuitMaxRunsPerAction) || 3));
    const maxDepth = Math.max(1, Math.floor(Number(rt.curiosityDeepPursuitMaxDepth) || 4));

    let pipelinePaused = false;
    let current = startItem;
    for (let runIndex = 0; runIndex < maxRuns; runIndex += 1) {
      setActiveMindEntityProfile(normalized);
      const fresh = await CuriosityItem.retrieve(current.id);
      if (!fresh) break;
      current = fresh;
      const depth = Number(current.pursuit_depth ?? 0);
      if (depth >= maxDepth) break;

      onProgress?.(`Run ${runIndex + 1}/${maxRuns}`);

      await CuriosityItem.update(current.id, { status: 'pursuing' });
      notifyMindStorageChanged({ source: 'curiosity' });

      let result;
      try {
        const rootId = current.root_curiosity_id || current.id;
        const prompt = buildCuriosityPursuitGraphPrompt(current);
        const resume = await resolvePursuitResumeFromLastPipelineRun(current);
        const oneShotOpts = {
          inputText: prompt,
          source: 'curiosity-deep-pursuit',
          curiosityPursuitContext: {
            parentCuriosityId: current.id,
            rootCuriosityId: rootId,
          },
          graphSessionIdForPipelineRun: getGraphSessionIdForPersistence(),
          task: null,
          onSseEvent: onPipelineSse,
          abortSignal: signal,
          mirrorCooperativePauseToGraphSession: false,
          mindStorageProfile: normalized,
        };
        if (resume.initialFullSharedMemory && resume.executionResume) {
          oneShotOpts.initialFullSharedMemory = resume.initialFullSharedMemory;
          oneShotOpts.executionResume = resume.executionResume;
        }
        const ui = getCuriosityPagePursuitSnapshot().pursuits?.[current.id]?.curiosityPipelineUi;
        if (ui) {
          oneShotOpts.metacognitionOverrides = {
            maxMetacognitionReruns: ui.metacognitionMaxReruns,
            metacognitionRerunDelayMinutes: ui.metacognitionRerunDelayMinutes,
          };
        }
        result = await runGraphPipelineOneShot(oneShotOpts);
        const { voiceText, pipelineRunId, voiceDeferredToScheduledSupervisor } = result;

        setActiveMindEntityProfile(normalized);
        if (!voiceDeferredToScheduledSupervisor) {
          await finalizePursuedCuriosityAfterGraph(current.id, voiceText, pipelineRunId, {
            rawOutputs: result.rawOutputs,
            sharedMemory: result.sharedMemory,
          });
        }
      } catch (e) {
        setActiveMindEntityProfile(normalized);
        await CuriosityItem.update(current.id, { status: 'open' }).catch(() => {});
        notifyMindStorageChanged({ source: 'curiosity' });
        throw e;
      }
      notifyMindStorageChanged({ source: 'curiosity' });

      if (result.voiceDeferredToScheduledSupervisor) break;

      if (isPipelinePauseOutcome(result)) {
        pipelinePaused = true;
        break;
      }

      if (runIndex >= maxRuns - 1) break;

      const next = await pickNextDeepPursuitChildFromParent(current.id, maxDepth);
      if (next) {
        current = next;
      }
    }
    return { pipelinePaused };
  } finally {
    setActiveMindEntityProfile(prev);
  }
}
