/** Grouped like the Scheduler UI — human labels for `task_type`. */
export const SCHEDULER_TASK_GROUPS = [
  {
    label: 'Graph pipeline',
    tasks: {
      pipeline_run: 'Graph pipeline (full SSE stack)',
      consciousness_stream: 'Graph pipeline — scheduled (saves chat + run)',
      diagnostic: 'Diagnostic pass (full pipeline)',
      metacognition_review: 'Metacognition & reruns review',
      supervisor_pipeline_rerun: 'Supervisor pipeline continuation',
      metacognition_pipeline_rerun: 'Supervisor pipeline continuation (legacy)',
      belief_tension_review: 'Belief tension review (Belief Map)',
      curiosity_pursuit: 'Curiosity pursuit (open questions)',
      goal_pursuit: 'Goal pursuit (goal stack)',
    },
  },
  {
    label: 'Self & identity',
    tasks: {
      consolidation_pass: 'Offline consolidation (self & world hints)',
      biography_update: 'Mind biography',
      dmn_reflection: 'DMN reflection (default mode narrative)',
    },
  },
  {
    label: 'Knowledge',
    tasks: {
      belief_extraction: 'Belief extraction (from pipeline outputs)',
      curiosity_generation: 'Curiosity generation',
      world_model_update: 'World model extract / merge',
    },
  },
  {
    label: 'Memory & time',
    tasks: {
      dreaming: 'Dreaming (memories + beliefs)',
      memory_synthesis: 'Memory integration (thematic LTM note)',
      temporal_reflection: 'Temporal reflection (timeline event)',
    },
  },
  {
    label: 'Analytics',
    tasks: {
      cognitive_health_snapshot: 'Cognitive health snapshot',
      emergence_detection: 'Emergence detection (scan recent runs)',
    },
  },
];

export const SCHEDULER_TASK_LABELS = Object.fromEntries(
  SCHEDULER_TASK_GROUPS.flatMap((g) => Object.entries(g.tasks))
);

/**
 * @param {string | undefined} taskType
 */
export function getSchedulerTaskTypeLabel(taskType) {
  const k = String(taskType || '').trim();
  return (k && SCHEDULER_TASK_LABELS[k]) || k || 'Scheduled task';
}
