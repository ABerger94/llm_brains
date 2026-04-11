import moment from 'moment';
import { emergenceReviewState } from './emergenceReviewState';

/** Pipeline post-processing may add a new MindBiography row after this many runs since the latest row’s created_date (see touchMindBiographyAfterPipeline). */
export const PIPELINE_BIOGRAPHY_SNAPSHOT_EVERY_N_RUNS = 5;

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
  if (n === 0) return [];
  const slice =
    typeof limit === 'number' && limit > 0 && limit < n ? sorted.slice(-limit) : sorted;
  let prevDayKey = null;
  return slice.map((run, i) => {
    const t = new Date(run.created_date).getTime();
    const m = moment(run.created_date);
    const dayKey = m.format('YYYY-MM-DD');
    const label =
      dayKey === prevDayKey ? m.format('h:mm a') : m.format('M/D');
    prevDayKey = dayKey;
    return {
      session: `R${i + 1}`,
      label,
      runCreatedAt: run.created_date,
      beliefs: beliefs.filter((b) => new Date(b.created_date).getTime() <= t).length,
      curiosity: curiosities.filter((c) => new Date(c.created_date).getTime() <= t).length,
      memories: memories.filter((m) => new Date(m.created_date).getTime() <= t).length,
      contradictionResolution: beliefs.filter((b) => {
        if ((b.status || '') !== 'resolved') return false;
        const tr = new Date(b.updated_date || b.created_date).getTime();
        return tr <= t;
      }).length,
      identity: biographies.filter((b) => new Date(b.created_date).getTime() <= t).length,
      emergence: emergences.filter((e) => new Date(e.created_date).getTime() <= t).length,
      goals: (goals || []).filter((g) => new Date(g.created_date).getTime() <= t).length,
    };
  });
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
 */
export function computeCognitiveHealthDerived(snapshot) {
  const { runs, beliefs, memories, curiosities, emergences, biographies, goals = [] } = snapshot;
  const emergencesForHealth = emergences.filter((e) => emergenceReviewState(e) !== 'rejected');

  const totalBeliefs = beliefs.length;
  const activeBeliefs = beliefs.filter((b) => (b.status || 'active') === 'active').length;
  const contradictedBeliefs = beliefs.filter((b) => b.status === 'contradicted').length;
  const resolvedBeliefs = beliefs.filter((b) => b.status === 'resolved').length;
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

  const openOrPursuing = curiosities.filter((c) => {
    const s = c.status || 'open';
    return s === 'open' || s === 'pursuing';
  }).length;
  const resolvedCuriosity = curiosities.filter((c) => (c.status || '') === 'resolved').length;
  const curiosityTotal = curiosities.length;

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
    { subject: 'Memory', value: Math.min(100, memories.length * 2) },
    { subject: 'Emergence', value: Math.min(100, emergencesForHealth.length * 12) },
  ];

  const beliefTrend = healthWeekOverWeekTrend(beliefs);
  const curiosityTrend = healthWeekOverWeekTrend(curiosities);
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
    resolvedCuriosity,
    curiosityTotal,
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
    memoryTrend,
    emergenceTrend,
    runTrend,
    identityLog,
  };
}
