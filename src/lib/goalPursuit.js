import { llmService } from '../services/llmService';
import { notifyMindStorageChanged } from './mindStorageEvents';
import { clipTextComplete } from '../../shared/textClip.mjs';
import { getRuntimeSettings } from './runtimeSettings';
import { getGoalPagePursuitSnapshot } from './goalPagePursuitStore';
import { runGraphPipelineOneShot } from './runGraphPipelineOneShot';
import { isPipelinePauseOutcome } from './pipelinePauseOutcome';
import { resolvePursuitResumeFromLastPipelineRun } from './pipelinePursuitResume';
import { effectiveItemPriority } from './priorityUtils';
import { getGraphSessionIdForPersistence } from './graphPipelineSessionScope';
import { buildCuriosityResolutionText } from './curiosityPursuit';
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
 * Pick the next goal item to pursue (open + dormant, by priority then age).
 * Uses {@link getMindEntityStores} — set active mind profile before calling.
 */
export async function resolveGoalItemForScheduledPursuit(task) {
  const { GoalItem } = getMindEntityStores();
  const tid = task?.target_goal_id;
  if (tid) {
    const item = await GoalItem.retrieve(String(tid));
    if (!item) return { message: 'Target goal not found — skipped.' };
    const st = item.status || 'open';
    if (st !== 'open' && st !== 'dormant') return { message: 'Target goal is not open or dormant — skipped.' };
    return { item };
  }
  const item = await pickGoalItemForPursuit();
  if (!item) return { message: 'No open or dormant goal items — skipped.' };
  return { item };
}

export async function pickGoalItemForPursuit() {
  const { GoalItem } = getMindEntityStores();
  const [open, dormant] = await Promise.all([
    GoalItem.filter({ status: 'open' }, '-created_date', 40),
    GoalItem.filter({ status: 'dormant' }, '-created_date', 20),
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
 * User / graph input framing a self-directed goal pass.
 */
export function buildGoalPursuitGraphPrompt(item) {
  const g = String(item.goal_statement || '').trim();
  const thread = item.pursuit_thread ? String(item.pursuit_thread) : '';
  return `[Goal pursuit — scheduled / autonomous]

This is not the human user's direct message; this mind is advancing one of its own stated goals.

GOAL: ${g}
THREAD SO FAR: ${thread || '(none)'}

Work the full stack toward this goal: use beliefs and memories in context, reconcile tensions, and answer as Voice with a concrete progress summary and what remains (soft pursuit — no rigid task engine).`;
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
 * Lightweight LLM-only pass (no full graph). Caller should set status to pursuing before calling.
 * @param {string} [opts.mindStorageProfile] `primary` or `playgroundMirror`
 */
export async function runGoalPursuitLlmOnly(item, { mindStorageProfile } = {}) {
  const normalized = normalizeScheduledTaskMindStorageProfile(mindStorageProfile);
  const prev = getActiveMindEntityProfile();
  setActiveMindEntityProfile(normalized);
  try {
    const { GoalItem, LongTermMemory } = getMindEntityStores();
    const { beliefsForPrompt, memories } = await loadBeliefsAndMemoriesForPursuit();
    const thread = item.pursuit_thread ? String(item.pursuit_thread) : '';

    const exploration = await llmService.InvokeLLM({
      prompt: `You are a cognitive mind actively working toward a self-set goal.

GOAL: ${item.goal_statement}
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

Advance this goal: what progress is plausible now, what blocks remain, what would count as meaningful next work? End with a short synthesis (not assistant boilerplate).`,
      max_tokens: 1800,
      temperature: 0.65,
    });

    const latest = await GoalItem.retrieve(item.id);
    const explorationTrim = String(exploration || '').trim();
    await GoalItem.update(item.id, {
      status: explorationTrim.length >= 20 ? 'resolved' : 'open',
      resolution: exploration,
      times_returned_to: (latest?.times_returned_to ?? item.times_returned_to ?? 0) + 1,
    });

    await LongTermMemory.create({
      title: `Goal pursuit: ${truncate(item.goal_statement, 100)}`,
      content: `Goal pursuit: ${item.goal_statement}\n\n${exploration}`,
      memory_type: 'semantic',
      source: 'goal-pursuit',
    });

    notifyMindStorageChanged({ source: 'goals' });
    notifyMindStorageChanged({ source: 'long-term-memory' });

    return truncate(exploration, 400) || 'Goal pursuit complete.';
  } finally {
    setActiveMindEntityProfile(prev);
  }
}

/**
 * @param {{ rawOutputs?: object, sharedMemory?: object }} [extras] Same as curiosity graph finalize — Voice may be empty while Narrative/Integration hold the answer.
 */
export async function finalizePursuedGoalAfterGraph(itemId, voiceText, pipelineRunId, extras = {}) {
  const { GoalItem } = getMindEntityStores();
  const latest = await GoalItem.retrieve(itemId);
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
  await GoalItem.update(itemId, {
    status: 'resolved',
    resolution: voice,
    times_returned_to: (latest.times_returned_to ?? 0) + 1,
    last_pursuit_pipeline_run_id: pipelineRunId || null,
    pursuit_thread: clipTextComplete((thread + append).trim(), 12_000, { ellipsis: true }),
  });
}

export async function pickNextDeepGoalChildFromParent(parentId, maxDepth) {
  const { GoalItem } = getMindEntityStores();
  const children = await GoalItem.filter({ parent_goal_id: parentId }, '-created_date', 60);
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
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.mindStorageProfile] `primary` or `playgroundMirror`
 * @returns {Promise<{ pipelinePaused: boolean }>}
 */
export async function runGoalDeepPursuitChain(
  startItem,
  { onProgress, onPipelineSse, signal, mindStorageProfile } = {}
) {
  const normalized = normalizeScheduledTaskMindStorageProfile(mindStorageProfile);
  const prev = getActiveMindEntityProfile();
  setActiveMindEntityProfile(normalized);
  try {
    const { GoalItem } = getMindEntityStores();
    const rt = getRuntimeSettings();
    const maxRuns = Math.max(1, Math.floor(Number(rt.goalDeepPursuitMaxRunsPerAction) || 3));
    const maxDepth = Math.max(1, Math.floor(Number(rt.goalDeepPursuitMaxDepth) || 4));

    let pipelinePaused = false;
    let current = startItem;
    for (let runIndex = 0; runIndex < maxRuns; runIndex += 1) {
      setActiveMindEntityProfile(normalized);
      const fresh = await GoalItem.retrieve(current.id);
      if (!fresh) break;
      current = fresh;
      const depth = Number(current.pursuit_depth ?? 0);
      if (depth >= maxDepth) break;

      onProgress?.(`Run ${runIndex + 1}/${maxRuns}`);

      await GoalItem.update(current.id, { status: 'pursuing' });
      notifyMindStorageChanged({ source: 'goals' });

      let result;
      try {
        const rootId = current.root_goal_id || current.id;
        const prompt = buildGoalPursuitGraphPrompt(current);
        const resume = await resolvePursuitResumeFromLastPipelineRun(current);
        const oneShotOpts = {
          inputText: prompt,
          source: 'goal-deep-pursuit',
          goalPursuitContext: {
            parentGoalId: current.id,
            rootGoalId: rootId,
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
        const ui = getGoalPagePursuitSnapshot().pursuits?.[current.id]?.goalPipelineUi;
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
          await finalizePursuedGoalAfterGraph(current.id, voiceText, pipelineRunId, {
            rawOutputs: result.rawOutputs,
            sharedMemory: result.sharedMemory,
          });
        }
      } catch (e) {
        setActiveMindEntityProfile(normalized);
        await GoalItem.update(current.id, { status: 'open' }).catch(() => {});
        notifyMindStorageChanged({ source: 'goals' });
        throw e;
      }
      notifyMindStorageChanged({ source: 'goals' });

      if (result.voiceDeferredToScheduledSupervisor) break;

      if (isPipelinePauseOutcome(result)) {
        pipelinePaused = true;
        break;
      }

      if (runIndex >= maxRuns - 1) break;

      const next = await pickNextDeepGoalChildFromParent(current.id, maxDepth);
      if (next) {
        current = next;
      }
    }
    return { pipelinePaused };
  } finally {
    setActiveMindEntityProfile(prev);
  }
}
