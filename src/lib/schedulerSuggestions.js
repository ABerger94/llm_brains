import {
  BeliefTension,
  CuriosityItem,
  GoalItem,
  EmergenceEvent,
  MindBiography,
  PipelineRun,
  ScheduledTask,
  WorldModel,
} from './data';
import { normalizeWorldModelCategory } from './worldModelSchema';
import { isCheckpointPipelineRun } from './pipelineRunCheckpoint';

/** Same set as ExtraPages SCHEDULER_PIPELINE_MIND_TASK_TYPES — avoid importing the page. */
const PIPELINE_MIND_TASK_TYPES = new Set([
  'pipeline_run',
  'consciousness_stream',
  'metacognition_review',
  'diagnostic',
  'belief_tension_review',
  'curiosity_pursuit',
  'goal_pursuit',
]);

export function suggestionUsesMindOptions(taskType) {
  return PIPELINE_MIND_TASK_TYPES.has(taskType);
}

function msDays(d) {
  return d * 24 * 60 * 60 * 1000;
}

function normSchedulerStatus(st) {
  const s = String(st ?? '')
    .trim()
    .toLowerCase();
  if (!s) return 'pending';
  if (s === 'canceled') return 'cancelled';
  return s;
}

/**
 * Rule-based scheduler suggestions from local store. Omits task types that already have a **pending or
 * running** row (running counts too so a stuck or active run does not suggest the same type again).
 * @returns {Promise<Array<{ id: string, task_type: string, title: string, detail: string, delayMinutes: number, input_text?: string }>>}
 */
export async function getSchedulerSuggestions() {
  const allTasks = await ScheduledTask.list('-created_date', 120);
  const busyTypes = new Set(
    allTasks
      .filter((t) => {
        const s = normSchedulerStatus(t.status);
        if (s === 'running') return true;
        // Pending but schedule-paused does not block suggestions — nothing will auto-run until resumed.
        if (s === 'pending' && t.schedule_paused === true) return false;
        return s === 'pending';
      })
      .map((t) => t.task_type)
      .filter(Boolean)
  );
  const hasBusyType = (type) => busyTypes.has(type);

  const [tensions, curious, goalStackItems, runsRaw, worldRows, bios, emergence] = await Promise.all([
    BeliefTension.filter({ tension_state: 'active' }, '-created_date', 50),
    CuriosityItem.list('-created_date', 100),
    GoalItem.list('-created_date', 100),
    PipelineRun.list('-created_date', 30),
    WorldModel.list('-updated_date', 120),
    MindBiography.list('-created_date', 2),
    EmergenceEvent.list('-created_date', 25),
  ]);
  const runs = runsRaw.filter((r) => !isCheckpointPipelineRun(r));

  const openCurious = curious.filter((c) => {
    const s = c.status || 'open';
    return s === 'open' || s === 'pursuing';
  });

  const openGoals = goalStackItems.filter((g) => {
    const s = g.status || 'open';
    return s === 'open' || s === 'pursuing' || s === 'dormant';
  });

  const goalRows = worldRows.filter((w) => normalizeWorldModelCategory(w.category) === 'goal');
  const now = Date.now();
  const weekAgo = now - msDays(7);
  const runsThisWeek = runs.filter((r) => new Date(r.created_date || 0).getTime() >= weekAgo);
  const lastRun = runs[0];
  const rerunCount = Number(lastRun?.loop_count) || 0;

  const lastBio = bios[0];
  const bioTouch = lastBio?.last_pipeline_touch || lastBio?.updated_date || lastBio?.created_date;
  const bioStale =
    !lastBio ||
    (bioTouch && now - new Date(bioTouch).getTime() > msDays(7));

  /** @type {Array<{ id: string, task_type: string, title: string, detail: string, delayMinutes: number, input_text?: string }>} */
  const out = [];

  if (tensions.length > 0 && !hasBusyType('belief_tension_review')) {
    out.push({
      id: 'belief-tensions',
      task_type: 'belief_tension_review',
      title: 'Belief tension review',
      detail: `${tensions.length} active tension(s); run a focused graph pass on the Belief Map.`,
      delayMinutes: 12,
    });
  }

  if (openCurious.length > 0 && !hasBusyType('curiosity_pursuit')) {
    out.push({
      id: 'curiosity-pursuit',
      task_type: 'curiosity_pursuit',
      title: 'Pursue a curiosity',
      detail: `${openCurious.length} open question(s); let the mind work one as Voice / pipeline.`,
      delayMinutes: 8,
    });
  }

  if (openGoals.length > 0 && !hasBusyType('goal_pursuit')) {
    out.push({
      id: 'goal-pursuit',
      task_type: 'goal_pursuit',
      title: 'Pursue a goal',
      detail: `${openGoals.length} open goal(s) on the stack; one soft graph or LLM pass.`,
      delayMinutes: 10,
    });
  }

  if (rerunCount >= 2 && !hasBusyType('metacognition_review')) {
    out.push({
      id: 'meta-reruns',
      task_type: 'metacognition_review',
      title: 'Metacognition check-in',
      detail: `Last saved run used ${rerunCount} supervisor rerun(s); review calibration.`,
      delayMinutes: 20,
    });
  }

  if (runs.length >= 4 && !hasBusyType('belief_extraction')) {
    out.push({
      id: 'belief-extract',
      task_type: 'belief_extraction',
      title: 'Merge beliefs from runs',
      detail: `${runs.length} recent pipeline run(s); extract structured beliefs.`,
      delayMinutes: 25,
    });
  }

  if (runs.length >= 2 && worldRows.length < 6 && !hasBusyType('world_model_update')) {
    out.push({
      id: 'world-model',
      task_type: 'world_model_update',
      title: 'Refresh world model',
      detail: 'Few world-model rows versus activity; run extract/merge.',
      delayMinutes: 30,
    });
  }

  if (bioStale && !hasBusyType('biography_update')) {
    out.push({
      id: 'biography',
      task_type: 'biography_update',
      title: 'Update mind biography',
      detail: lastBio
        ? 'Biography looks stale — schedule a new session snapshot.'
        : 'No biography yet — seed one from memory and runs.',
      delayMinutes: 35,
    });
  }

  if (runsThisWeek.length < 2 && runs.length > 0 && !hasBusyType('pipeline_run')) {
    const goalHint =
      goalRows.length >= 4
        ? `${goalRows.length} world-model goal(s) — consider integrating them in this pass.`
        : 'Light activity this week — short pipeline to re-integrate context.';
    out.push({
      id: 'quiet-pipeline',
      task_type: 'pipeline_run',
      title: 'Autonomous graph pass',
      detail: goalHint,
      delayMinutes: 15,
      input_text:
        goalRows.length >= 4
          ? 'Autonomous pass: integrate active goals from the world model with recent memories and beliefs. Summarize as Voice.'
          : '',
    });
  }

  if (
    openCurious.length === 0 &&
    runs.length >= 3 &&
    !hasBusyType('curiosity_generation') &&
    !hasBusyType('curiosity_pursuit')
  ) {
    out.push({
      id: 'curiosity-gen',
      task_type: 'curiosity_generation',
      title: 'Generate new questions',
      detail: 'No open curiosities; mine recent Voice outputs for questions.',
      delayMinutes: 40,
    });
  }

  if (emergence.length >= 3 && !hasBusyType('emergence_detection')) {
    out.push({
      id: 'emergence',
      task_type: 'emergence_detection',
      title: 'Scan emergence markers',
      detail: `${emergence.length} emergence event(s) logged; rescan recent runs.`,
      delayMinutes: 45,
    });
  }

  if (runs.length >= 5 && !hasBusyType('cognitive_health_snapshot')) {
    out.push({
      id: 'health',
      task_type: 'cognitive_health_snapshot',
      title: 'Cognitive health snapshot',
      detail: 'Enough activity for a stats-based wellness note.',
      delayMinutes: 50,
    });
  }

  if (runs.length >= 6 && !hasBusyType('diagnostic')) {
    out.push({
      id: 'diagnostic',
      task_type: 'diagnostic',
      title: 'Diagnostic pipeline',
      detail: 'Broad consistency pass over recent cognitive state.',
      delayMinutes: 60,
    });
  }

  const seen = new Set();
  const deduped = [];
  for (const s of out) {
    if (seen.has(s.task_type)) continue;
    seen.add(s.task_type);
    deduped.push(s);
  }

  return deduped.slice(0, 8);
}
