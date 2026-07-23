import moment from 'moment';
import { emergenceReviewState } from './emergenceReviewState';
import { countCuriosityItemsByUiStatus } from './curiosityQueueMetrics';
import { countGoalItemsByUiStatus } from './goalQueueMetrics';

/** Pipeline post-processing may add a new MindBiography row after this many runs since the latest row’s created_date (see touchMindBiographyAfterPipeline). */
export const PIPELINE_BIOGRAPHY_SNAPSHOT_EVERY_N_RUNS = 5;

/**
 * Beliefs/memories/etc. are often persisted milliseconds after the PipelineRun row is created. Without this grace,
 * cumulative counts at each run’s timestamp stay at zero until a later run — especially visible on System B with few runs.
 */
export const HEALTH_GROWTH_RUN_ARTIFACT_GRACE_MS = 120_000;

export const HEALTH_CHART = {
  axis: 'hsl(0 0% 50%)',
  grid: 'hsl(0 0% 18%)',
  cyan: 'hsl(187 86% 53%)',
  amber: 'hsl(43 74% 66%)',
  /** Memories line + any shared indigo series (matches UI indigo-500 / indigo-400 on dark). */
  indigo: 'hsl(239 84% 67%)',
  sky: 'hsl(199 89% 48%)',
  pink: 'hsl(330 81% 60%)',
  emerald: 'hsl(142 71% 45%)',
  /** Goals line — distinct from emerald (contradiction) and amber (curiosity). */
  goals: 'hsl(263 72% 58%)',
  tooltipBg: 'hsl(0 0% 8%)',
  tooltipBorder: 'hsl(0 0% 16%)',
};

function healthRecordsInWindow(records, msStart, msEnd, field = 'created_date') {
  return records.filter((r) => {
    const t = new Date(r[field]).getTime();
    return t > msStart && t <= msEnd;
  }).length;
}

/** Compare last 7 days vs previous 7 days creation counts. */
export function healthWeekOverWeekTrend(records, field = 'created_date') {
  const now = Date.now();
  const w = 7 * 24 * 60 * 60 * 1000;
  const recent = healthRecordsInWindow(records, now - w, now, field);
  const prev = healthRecordsInWindow(records, now - 2 * w, now - w, field);
  if (recent > prev) return 1;
  if (recent < prev) return -1;
  return 0;
}

function healthParseIdentityKeywords(bio) {
  const k = bio?.identity_keywords;
  if (Array.isArray(k)) return k.map((x) => String(x).toLowerCase().trim()).filter(Boolean);
  if (typeof k === 'string' && k.trim()) {
    return k
      .split(/[,;]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function healthParseCoreValues(bio) {
  const v = bio?.core_values;
  if (Array.isArray(v)) return v.map((x) => String(x).toLowerCase().trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    return v
      .split(/[,;]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function healthTokenizeSummary(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function healthJaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0.5;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0.5 : inter / union;
}

export function healthIdentityStabilityScore(biographies) {
  if (!biographies || biographies.length < 2) {
    if (biographies?.length === 1) return 0.55;
    return 0.5;
  }
  const [latest, prev] = biographies;
  const kwA = healthParseIdentityKeywords(latest);
  const kwB = healthParseIdentityKeywords(prev);
  const cvA = healthParseCoreValues(latest);
  const cvB = healthParseCoreValues(prev);
  const kw = healthJaccard(kwA, kwB);
  const cv = healthJaccard(cvA, cvB);
  const sum = healthJaccard(healthTokenizeSummary(latest.summary), healthTokenizeSummary(prev.summary));
  const hasKw = kwA.length + kwB.length > 0;
  const hasCv = cvA.length + cvB.length > 0;
  if (!hasKw && !hasCv) return sum > 0 ? sum : 0.5;
  if (!hasCv) return 0.55 * kw + 0.45 * sum;
  if (!hasKw) return 0.55 * cv + 0.45 * sum;
  return 0.45 * kw + 0.35 * cv + 0.2 * sum;
}

function recordTimeMs(rec, field = 'created_date') {
  const n = new Date(rec?.[field]).getTime();
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Cumulative store counts as of `cutoffMs` (inclusive), matching per-run growth chart semantics.
 */
function growthCountsAtCutoffMs(
  cutoffMs,
  beliefs,
  curiosities,
  memories,
  emergences,
  biographies,
  goals
) {
  if (!Number.isFinite(cutoffMs)) {
    return {
      beliefs: 0,
      curiosity: 0,
      memories: 0,
      contradictionResolution: 0,
      identity: 0,
      emergence: 0,
      goals: 0,
    };
  }
  const beforeCutoff = (rec, field = 'created_date') => {
    const t = recordTimeMs(rec, field);
    return Number.isFinite(t) && t <= cutoffMs;
  };
  return {
    beliefs: beliefs.filter((b) => beforeCutoff(b, 'created_date')).length,
    curiosity: curiosities.filter((c) => beforeCutoff(c, 'created_date')).length,
    memories: memories.filter((mem) => beforeCutoff(mem, 'created_date')).length,
    contradictionResolution: beliefs.filter((b) => {
      if ((b.status || '') !== 'resolved') return false;
      const tr = recordTimeMs(b, 'updated_date') || recordTimeMs(b, 'created_date');
      return Number.isFinite(tr) && tr <= cutoffMs;
    }).length,
    identity: biographies.filter((b) => beforeCutoff(b, 'created_date')).length,
    emergence: emergences.filter((e) => beforeCutoff(e, 'created_date')).length,
    goals: (goals || []).filter((g) => beforeCutoff(g, 'created_date')).length,
  };
}

function growthRowCountsEqual(a, b) {
  return (
    a.beliefs === b.beliefs &&
    a.curiosity === b.curiosity &&
    a.memories === b.memories &&
    a.contradictionResolution === b.contradictionResolution &&
    a.identity === b.identity &&
    a.emergence === b.emergence &&
    a.goals === b.goals
  );
}

export function healthBuildGrowthOverRuns(
  runs,
  beliefs,
  curiosities,
  memories,
  emergences,
  biographies,
  goals,
  limit
) {
  const sorted = [...runs].sort(
    (x, y) => new Date(x.created_date).getTime() - new Date(y.created_date).getTime()
  );
  const n = sorted.length;
  const g = goals || [];

  /** No pipeline runs: still chart store growth if anything exists (e.g. manual biography with no runs yet). */
  if (n === 0) {
    const nowMs = Date.now();
    const counts = growthCountsAtCutoffMs(
      nowMs,
      beliefs,
      curiosities,
      memories,
      emergences,
      biographies,
      g
    );
    const empty =
      counts.beliefs +
        counts.curiosity +
        counts.memories +
        counts.contradictionResolution +
        counts.identity +
        counts.emergence +
        counts.goals ===
      0;
    if (empty) return [];
    return [
      {
        session: 'S1',
        label: 'Now',
        runCreatedAt: new Date(nowMs).toISOString(),
        ...counts,
      },
    ];
  }

  const slice =
    typeof limit === 'number' && limit > 0 && limit < n ? sorted.slice(-limit) : sorted;
  let prevDayKey = null;
  const rows = slice.map((run, i) => {
    const tRun = recordTimeMs(run, 'created_date');
    const cutoffMs =
      Number.isFinite(tRun) ? tRun + HEALTH_GROWTH_RUN_ARTIFACT_GRACE_MS : NaN;
    const m = moment(run.created_date);
    const dayKey = m.format('YYYY-MM-DD');
    const label =
      dayKey === prevDayKey ? m.format('h:mm a') : m.format('M/D');
    prevDayKey = dayKey;
    const counts = growthCountsAtCutoffMs(
      cutoffMs,
      beliefs,
      curiosities,
      memories,
      emergences,
      biographies,
      g
    );
    return {
      session: `R${i + 1}`,
      label,
      runCreatedAt: run.created_date,
      ...counts,
    };
  });

  const nowMs = Date.now();
  const atNow = growthCountsAtCutoffMs(
    nowMs,
    beliefs,
    curiosities,
    memories,
    emergences,
    biographies,
    g
  );
  const last = rows[rows.length - 1];
  if (last && !growthRowCountsEqual(last, atNow)) {
    rows.push({
      session: `R${rows.length + 1}`,
      label: 'Now',
      runCreatedAt: new Date(nowMs).toISOString(),
      ...atNow,
    });
  }

  return rows;
}

/**
 * @param {{
 *   runs: unknown[],
 *   beliefs: unknown[],
 *   memories: unknown[],
 *   curiosities: unknown[],
 *   feedback: unknown[],
 *   dreams: unknown[],
 *   emergences: unknown[],
 *   biographies: unknown[],
 *   goals?: unknown[],
 *   positiveRatings: number,
 *   negativeRatings: number,
 * }} snapshot
 * @param {Record<string, { running?: boolean }>} [curiosityPursuits] Live Curiosity pursuit slots (same as Curiosity Queue). When set, status counts match /curiosity (stale DB `pursuing` without a running slot counts as open).
 * @param {Record<string, { running?: boolean }>} [goalPursuits] Live Goal pursuit slots (same as Goals stack).
 */
export function computeCognitiveHealthDerived(snapshot, curiosityPursuits = {}, goalPursuits = {}) {
  const { runs, beliefs, memories, curiosities, emergences, biographies, goals = [] } = snapshot;
  const emergencesForHealth = emergences.filter((e) => emergenceReviewState(e) !== 'rejected');

  const totalBeliefs = beliefs.length;
  const activeBeliefs = beliefs.filter((b) => (b.status || 'active') === 'active').length;
  const contradictedBeliefs = beliefs.filter((b) => b.status === 'contradicted').length;
  const resolvedBeliefs = beliefs.filter((b) => b.status === 'resolved').length;
  const deprecatedBeliefs = beliefs.filter((b) => b.status === 'deprecated').length;
  const tensionDenom = resolvedBeliefs + contradictedBeliefs;
  const contradictionResolutionRate = tensionDenom > 0 ? resolvedBeliefs / tensionDenom : null;

  const avgConfidence =
    beliefs.length > 0
      ? beliefs.reduce((s, b) => s + (typeof b.confidence === 'number' ? b.confidence : 0.5), 0) / beliefs.length
      : 0;

  const meanConf = avgConfidence;
  const variance =
    beliefs.length > 0
      ? beliefs.reduce(
          (s, b) => s + Math.pow((typeof b.confidence === 'number' ? b.confidence : 0.5) - meanConf, 2),
          0
        ) / beliefs.length
      : 0;
  const beliefVolatility = Math.sqrt(variance);

  const {
    open: curiosityOpen,
    pursuing: curiosityPursuing,
    resolved: resolvedCuriosity,
    dormant: curiosityDormant,
    total: curiosityTotal,
  } = countCuriosityItemsByUiStatus(curiosities, curiosityPursuits);
  const openOrPursuing = curiosityOpen + curiosityPursuing;

  const {
    open: goalOpen,
    pursuing: goalPursuing,
    resolved: goalResolved,
    dormant: goalDormant,
    total: goalTotal,
  } = countGoalItemsByUiStatus(goals, goalPursuits);
  const goalOpenOrPursuing = goalOpen + goalPursuing;

  const identityStability = healthIdentityStabilityScore(biographies);

  const identityEmergences = emergencesForHealth.filter(
    (e) => String(e.emergence_category || '').toLowerCase() === 'identity_shift'
  );
  const identityLog = [
    ...biographies.map((bio) => ({ kind: 'biography', date: bio.created_date, bio })),
    ...identityEmergences.map((event) => ({ kind: 'emergence', date: event.created_date, event })),
  ]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 36);

  const growthData = healthBuildGrowthOverRuns(
    runs,
    beliefs,
    curiosities,
    memories,
    emergencesForHealth,
    biographies,
    goals
  );

  const radarData = [
    { subject: 'Beliefs', value: Math.min(100, activeBeliefs * 4 + contradictedBeliefs * 2) },
    ...(contradictionResolutionRate != null
      ? [{ subject: 'Contr. res.', value: Math.round(contradictionResolutionRate * 100) }]
      : []),
    { subject: 'Identity', value: Math.round(identityStability * 100) },
    { subject: 'Curiosity', value: Math.min(100, openOrPursuing * 10 + curiosityTotal * 2) },
    { subject: 'Goals', value: Math.min(100, goalOpenOrPursuing * 10 + goalTotal * 2) },
    { subject: 'Memory', value: Math.min(100, memories.length * 2) },
    { subject: 'Emergence', value: Math.min(100, emergencesForHealth.length * 12) },
  ];

  const beliefTrend = healthWeekOverWeekTrend(beliefs);
  const curiosityTrend = healthWeekOverWeekTrend(curiosities);
  const goalTrend = healthWeekOverWeekTrend(goals);
  const memoryTrend = healthWeekOverWeekTrend(memories);
  const emergenceTrend = healthWeekOverWeekTrend(emergencesForHealth);
  const runTrend = healthWeekOverWeekTrend(runs);

  return {
    totalBeliefs,
    activeBeliefs,
    contradictedBeliefs,
    resolvedBeliefs,
    contradictionResolutionRate,
    avgConfidence,
    beliefVolatility,
    openOrPursuing,
    curiosityOpen,
    curiosityPursuing,
    curiosityDormant,
    resolvedCuriosity,
    curiosityTotal,
    goalOpen,
    goalPursuing,
    goalDormant,
    goalResolved,
    goalTotal,
    goalOpenOrPursuing,
    deprecatedBeliefs,
    identityStability,
    growthData,
    radarData,
    emergencePreview: emergencesForHealth.slice(0, 5),
    runCount: runs.length,
    memoryCount: memories.length,
    emergenceCount: emergencesForHealth.length,
    dreamCount: snapshot.dreams.length,
    feedbackBalance: `${snapshot.positiveRatings} / ${snapshot.negativeRatings}`,
    beliefTrend,
    curiosityTrend,
    goalTrend,
    memoryTrend,
    emergenceTrend,
    runTrend,
    identityLog,
  };
}
