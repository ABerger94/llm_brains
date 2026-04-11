/**
 * Shared priority clamping, pipeline heuristics, and curiosity/goal output parsers.
 */

export const DEPTH_DECAY_PER_LEVEL = 0.92;

export const DEFAULT_CURIOUS_PIPELINE_PRIORITY = 0.55;
export const DEFAULT_GOAL_PIPELINE_PRIORITY = 0.5;
export const DEFAULT_PURSUIT_FOLLOWUP_BASE = 0.52;
export const DEFAULT_MANUAL_LIKE_PRIORITY = 0.5;

export function clampPriority(value, fallback = DEFAULT_MANUAL_LIKE_PRIORITY) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** Same default as queue cards when priority is missing. */
export function effectiveItemPriority(item) {
  const p = item?.priority;
  return typeof p === 'number' && !Number.isNaN(p) ? clampPriority(p, DEFAULT_MANUAL_LIKE_PRIORITY) : DEFAULT_MANUAL_LIKE_PRIORITY;
}

/** Deterministic jitter in ~[-0.02, 0.02] for id strings. */
export function stablePriorityJitter(id) {
  const s = String(id || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  const u = (h % 10001) / 10000;
  return (u - 0.5) * 0.04;
}

export function curiosityRootBaseline(source) {
  const s = String(source || '');
  if (s === 'pipeline') return DEFAULT_CURIOUS_PIPELINE_PRIORITY;
  if (s === 'pursuit-followup') return DEFAULT_PURSUIT_FOLLOWUP_BASE;
  return DEFAULT_MANUAL_LIKE_PRIORITY;
}

export function goalRootBaseline(source) {
  const s = String(source || '');
  if (s === 'pursuit-followup') return DEFAULT_PURSUIT_FOLLOWUP_BASE;
  if (s === 'pipeline') return DEFAULT_GOAL_PIPELINE_PRIORITY;
  return DEFAULT_MANUAL_LIKE_PRIORITY;
}

export function priorityFromParentDepth(parentEff, parentDepth, childDepth) {
  const pe = clampPriority(parentEff, DEFAULT_MANUAL_LIKE_PRIORITY);
  const steps = Math.max(0, Number(childDepth) - Number(parentDepth));
  const mult = steps === 0 ? 1 : Math.pow(DEPTH_DECAY_PER_LEVEL, steps);
  return clampPriority(pe * mult, pe);
}

/**
 * Follow-up row priority: optional LLM per-item score; else decay from parent + tiny index spread.
 */
export function computeFollowUpPriority({
  parentPriority,
  parentDepth,
  childDepth,
  llmPriority,
  candidateIndex = 0,
}) {
  const parentEff =
    typeof parentPriority === 'number' && !Number.isNaN(parentPriority)
      ? clampPriority(parentPriority, DEFAULT_MANUAL_LIKE_PRIORITY)
      : DEFAULT_MANUAL_LIKE_PRIORITY;
  const base = priorityFromParentDepth(parentEff, parentDepth, childDepth);
  if (llmPriority != null) {
    const lp = Number(llmPriority);
    if (Number.isFinite(lp)) return clampPriority(lp, base);
  }
  const jitter = candidateIndex * 0.0025;
  return clampPriority(base - jitter, 0);
}

/** Parse Curiosity module URGENCY line; null if absent/invalid. */
export function parseCuriosityUrgencyFromOutput(raw) {
  const m = String(raw || '').match(/URGENCY:\s*([\d.]+)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return clampPriority(n, DEFAULT_CURIOUS_PIPELINE_PRIORITY);
}

/** Parse Goal Generation GOAL_URGENCY line; null if absent/invalid. */
export function parseGoalUrgencyFromOutput(raw) {
  const m = String(raw || '').match(/GOAL_URGENCY:\s*([\d.]+)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return clampPriority(n, DEFAULT_GOAL_PIPELINE_PRIORITY);
}

/**
 * FOLLOWUP_CURIOSITIES JSON tail: items may include optional priority (0–1).
 * @returns {{ question: string, priority?: number }[]}
 */
export function parseFollowupCuriositiesFromModuleOutput(raw) {
  const text = String(raw || '');
  const idx = text.search(/FOLLOWUP_CURIOSITIES:\s*/i);
  if (idx === -1) return [];
  const sub = text.slice(idx).replace(/^FOLLOWUP_CURIOSITIES:\s*/i, '');
  const brace = sub.indexOf('{');
  if (brace === -1) return [];
  let depth = 0;
  let end = -1;
  for (let i = brace; i < sub.length; i += 1) {
    if (sub[i] === '{') depth += 1;
    else if (sub[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];
  try {
    const j = JSON.parse(sub.slice(brace, end + 1));
    const items = Array.isArray(j.items) ? j.items : [];
    const out = [];
    for (const it of items) {
      const question = String(it?.question || '').trim();
      if (question.length < 8) continue;
      const pr = it?.priority;
      const p =
        typeof pr === 'number' && !Number.isNaN(pr) ? clampPriority(pr, DEFAULT_MANUAL_LIKE_PRIORITY) : undefined;
      out.push(p !== undefined ? { question, priority: p } : { question });
      if (out.length >= 8) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Small recency boost for fresher rows (backfill). */
export function recencyPriorityNudge(row) {
  const raw = row?.updated_date || row?.created_date;
  if (!raw) return 0;
  const t = new Date(raw).getTime();
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (Date.now() - t) / 86400000);
  return 0.015 * Math.max(0, 1 - Math.min(1, ageDays / 60));
}

/**
 * Max effective priority among items whose UI status is open, pursuing, or dormant.
 */
export function maxActiveClusterPriority(items = [], pursuits, uiStatusFn) {
  const active = (st) => st === 'open' || st === 'pursuing' || st === 'dormant';
  let max = 0;
  for (const item of items || []) {
    const st = uiStatusFn(item, pursuits);
    if (!active(st)) continue;
    max = Math.max(max, effectiveItemPriority(item));
  }
  return max;
}
