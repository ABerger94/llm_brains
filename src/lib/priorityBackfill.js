import { getKvSync, setKvSync } from './browserStorage';
import { CuriosityItem, GoalItem } from './data';
import { notifyMindStorageChanged } from './mindStorageEvents';
import {
  clampPriority,
  curiosityRootBaseline,
  effectiveItemPriority,
  goalRootBaseline,
  priorityFromParentDepth,
  recencyPriorityNudge,
  stablePriorityJitter,
} from './priorityUtils';

const BACKFILL_KV_KEY = 'queue_priority_backfill_v1';

const ACTIVE = new Set(['open', 'pursuing', 'dormant']);

function computePrioritiesForRows(rows, kind) {
  const active = rows.filter((r) => ACTIVE.has(String(r.status || 'open').toLowerCase()));
  if (!active.length) return new Map();

  const idMap = new Map(active.map((r) => [String(r.id), r]));
  const byDepth = [...active].sort(
    (a, b) => (Number(a.pursuit_depth) || 0) - (Number(b.pursuit_depth) || 0)
  );

  const computed = new Map();
  const rootBaseline = kind === 'curiosity' ? curiosityRootBaseline : goalRootBaseline;
  const parentKey = kind === 'curiosity' ? 'parent_curiosity_id' : 'parent_goal_id';

  for (const row of byDepth) {
    const pid = row[parentKey];
    const parent = pid && idMap.has(String(pid)) ? idMap.get(String(pid)) : null;
    const d = Number(row.pursuit_depth) || 0;
    const pd = parent ? Number(parent.pursuit_depth) || 0 : 0;

    let value;
    if (!parent) {
      value = clampPriority(
        rootBaseline(row.source) + stablePriorityJitter(row.id) + recencyPriorityNudge(row),
        DEFAULT_FOR_KIND(kind)
      );
    } else {
      const parentEff = computed.has(String(parent.id))
        ? computed.get(String(parent.id))
        : effectiveItemPriority(parent);
      value = clampPriority(
        priorityFromParentDepth(parentEff, pd, d) + stablePriorityJitter(row.id) + recencyPriorityNudge(row),
        parentEff
      );
    }
    computed.set(String(row.id), value);
  }
  return computed;
}

function DEFAULT_FOR_KIND(kind) {
  return kind === 'curiosity' ? 0.55 : 0.5;
}

const BATCH_SIZE = 40;

/** Yield to the event loop every BATCH_SIZE writes so the main thread stays responsive. */
function yieldTick() {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * Recompute priority for every open/pursuing/dormant curiosity and goal row.
 * Writes are batched to avoid blocking the main thread during cold-start backfill.
 * @returns {{ curiosityUpdated: number, goalsUpdated: number }}
 */
export async function recomputeOpenQueuePriorities() {
  const [curiosities, goals] = await Promise.all([
    CuriosityItem.list('-created_date', 500),
    GoalItem.list('-created_date', 500),
  ]);

  const cMap = computePrioritiesForRows(curiosities, 'curiosity');
  const gMap = computePrioritiesForRows(goals, 'goal');

  let curiosityUpdated = 0;
  for (const [id, priority] of cMap) {
    await CuriosityItem.update(id, { priority });
    curiosityUpdated += 1;
    if (curiosityUpdated % BATCH_SIZE === 0) await yieldTick();
  }

  let goalsUpdated = 0;
  for (const [id, priority] of gMap) {
    await GoalItem.update(id, { priority });
    goalsUpdated += 1;
    if (goalsUpdated % BATCH_SIZE === 0) await yieldTick();
  }

  if (curiosityUpdated || goalsUpdated) {
    notifyMindStorageChanged({ source: 'curiosity' });
    notifyMindStorageChanged({ source: 'goals' });
  }

  return { curiosityUpdated, goalsUpdated };
}

/**
 * One-shot migration after storage is ready.
 */
export async function runPriorityQueueBackfillOnce() {
  try {
    if (getKvSync(BACKFILL_KV_KEY) === '1') {
      return { skipped: true, curiosityUpdated: 0, goalsUpdated: 0 };
    }
    const result = await recomputeOpenQueuePriorities();
    setKvSync(BACKFILL_KV_KEY, '1');
    return { skipped: false, ...result };
  } catch (e) {
    console.warn('[priorityBackfill] runPriorityQueueBackfillOnce', e);
    return { skipped: false, error: e, curiosityUpdated: 0, goalsUpdated: 0 };
  }
}
