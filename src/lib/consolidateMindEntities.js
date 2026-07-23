/**
 * LLM-assisted deduplication of BeliefStore and CuriosityItem rows (merge clusters, remap references).
 */

import { normalizeBeliefMapCategory } from '../../shared/beliefMapCategory.mjs';
import { clipTextComplete } from '../../shared/textClip.mjs';
import { BeliefStore, CuriosityItem, ScheduledTask } from './data';
import { invokeLLM } from './llm';
import { notifyMindStorageChanged } from './mindStorageEvents';
import { isValidIndexedDbRecordKey } from './browserStorage';
import {
  flushCuriosityPursuitsPersistNow,
  getCuriosityPagePursuitSnapshot,
  removeCuriosityPursuit,
  upsertCuriosityPursuit,
} from './curiosityPagePursuitStore';

const BELIEF_LIMIT = 100;
const CURIOSITY_LIMIT = 120;

const CLUSTERS_SCHEMA = {
  type: 'object',
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keepId: { type: 'string' },
          mergeIds: { type: 'array', items: { type: 'string' } },
          canonicalStatement: { type: 'string' },
          canonicalQuestion: { type: 'string' },
        },
        required: ['keepId', 'mergeIds'],
      },
    },
  },
  required: ['clusters'],
};

function normalizeContradicts(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((x) => String(x || '').trim()).filter(Boolean))];
}

/**
 * @param {Map<string, string>} redirect deletedId -> keepId
 * @param {number} listLimit
 */
export async function remapBeliefContradictsWithRedirect(redirect, listLimit = 400) {
  if (redirect.size === 0) return;
  const rows = await BeliefStore.list('-created_date', listLimit);
  for (const b of rows) {
    const raw = normalizeContradicts(b.contradicts);
    const next = [];
    const seen = new Set();
    for (const c of raw) {
      const mapped = redirect.has(c) ? redirect.get(c) : c;
      if (!mapped || mapped === b.id) continue;
      if (seen.has(mapped)) continue;
      seen.add(mapped);
      next.push(mapped);
    }
    const prev = JSON.stringify(normalizeContradicts(b.contradicts));
    const nxt = JSON.stringify(next);
    if (prev !== nxt) {
      await BeliefStore.update(b.id, { contradicts: next });
    }
  }
}

/**
 * @returns {{ merged: number, deleted: number, message: string }}
 */
export async function consolidateDuplicateBeliefsInStore() {
  const rows = await BeliefStore.list('-created_date', BELIEF_LIMIT);
  if (rows.length < 2) {
    return { merged: 0, deleted: 0, message: 'Not enough beliefs to consolidate.' };
  }

  const payload = rows.map((b) => ({
    id: b.id,
    statement: clipTextComplete(String(b.statement || ''), 320, { ellipsis: true }),
    confidence: typeof b.confidence === 'number' ? b.confidence : 0.5,
    category: String(b.category || 'factual'),
    status: String(b.status || 'active'),
  }));

  const result = await invokeLLM({
    prompt: `You group NEAR-DUPLICATE beliefs: same proposition expressed similarly or redundantly. Only merge when they are truly the same claim.

RULES:
- Output disjoint clusters only. Each cluster has keepId (the id to keep) and mergeIds (all ids in that group, including keepId).
- mergeIds must have at least 2 entries — omit singletons.
- keepId must be one of mergeIds.
- Prefer keeping the more informative statement when choosing keepId (often the clearest or most recent).
- Optional canonicalStatement: improved single statement for the kept row (<= 900 chars); omit if unchanged.

BELIEFS:
${JSON.stringify(payload, null, 2)}`,
    response_json_schema: CLUSTERS_SCHEMA,
  });

  const clustersRaw = Array.isArray(result?.clusters) ? result.clusters : [];
  const idSet = new Set(rows.map((r) => r.id));
  const used = new Set();
  /** @type {Map<string, string>} */
  const redirect = new Map();
  /** @type {typeof clustersRaw} */
  const clusters = [];

  for (const c of clustersRaw) {
    const keepId = String(c.keepId || '').trim();
    const mergeIds = Array.isArray(c.mergeIds) ? c.mergeIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (!keepId || mergeIds.length < 2) continue;
    if (!mergeIds.includes(keepId)) continue;
    const unknown = mergeIds.filter((id) => !idSet.has(id));
    if (unknown.length) continue;
    const dup = mergeIds.some((id) => used.has(id));
    if (dup) continue;
    mergeIds.forEach((id) => used.add(id));
    for (const id of mergeIds) {
      if (id !== keepId) redirect.set(id, keepId);
    }
    clusters.push(c);
  }

  if (redirect.size === 0) {
    return { merged: 0, deleted: 0, message: 'No duplicate clusters found.' };
  }

  await remapBeliefContradictsWithRedirect(redirect, 400);

  let deleted = 0;
  let merged = 0;

  for (const c of clusters) {
    const keepId = String(c.keepId || '').trim();
    const mergeIds = Array.isArray(c.mergeIds) ? c.mergeIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (!keepId || mergeIds.length < 2 || !mergeIds.includes(keepId)) continue;
    if (mergeIds.some((id) => !idSet.has(id))) continue;

    const others = mergeIds.filter((id) => id !== keepId);
    if (others.length === 0) continue;

    const keep = await BeliefStore.retrieve(keepId);
    if (!keep) continue;

    const members = await Promise.all(mergeIds.map((id) => BeliefStore.retrieve(id)));
    if (members.some((m) => !m)) continue;

    let maxConf = typeof keep.confidence === 'number' ? keep.confidence : 0.5;
    let sumRein = Number(keep.times_reinforced) || 0;
    let sumChal = Number(keep.times_challenged) || 0;
    let bestReason = String(keep.reasoning || '');
    /** @type {Set<string>} */
    const conUnion = new Set(normalizeContradicts(keep.contradicts));

    for (const m of members) {
      if (!m || m.id === keepId) continue;
      const cf = typeof m.confidence === 'number' ? m.confidence : 0.5;
      maxConf = Math.max(maxConf, cf);
      sumRein += Number(m.times_reinforced) || 0;
      sumChal += Number(m.times_challenged) || 0;
      const r = String(m.reasoning || '').trim();
      if (r.length > bestReason.length) bestReason = r;
      for (const x of normalizeContradicts(m.contradicts)) {
        if (x !== keepId) conUnion.add(x);
      }
    }

    const contradicts = [...conUnion].filter((id) => id !== keepId);

    const canon = String(c.canonicalStatement || '').trim();
    const statement = canon
      ? clipTextComplete(canon, 900, { ellipsis: false })
      : keep.statement;

    /** @type {Map<string, number>} */
    const catCounts = new Map();
    for (const m of members) {
      if (!m) continue;
      const ck = normalizeBeliefMapCategory(m.category);
      if (!ck) continue;
      catCounts.set(ck, (catCounts.get(ck) || 0) + 1);
    }
    let mergedCategory = normalizeBeliefMapCategory(keep.category) ?? 'factual';
    let bestCatCount = catCounts.get(mergedCategory) || 0;
    for (const [ck, n] of catCounts) {
      if (n > bestCatCount) {
        bestCatCount = n;
        mergedCategory = ck;
      }
    }

    await BeliefStore.update(keepId, {
      statement,
      confidence: Math.min(1, Math.max(0.05, maxConf)),
      category: mergedCategory,
      times_reinforced: sumRein,
      times_challenged: sumChal,
      ...(bestReason ? { reasoning: clipTextComplete(bestReason, 1200, { ellipsis: false }) } : {}),
      contradicts,
      status: keep.status || 'active',
    });

    merged += 1;
    for (const oid of others) {
      if (!isValidIndexedDbRecordKey(oid)) continue;
      await BeliefStore.delete(oid);
      deleted += 1;
    }
  }

  notifyMindStorageChanged({ source: 'beliefs' });
  return {
    merged,
    deleted,
    message: `Merged ${merged} cluster(s); removed ${deleted} duplicate row(s).`,
  };
}

/**
 * Remap parent/root and scheduled tasks; merge pursuit slot from -> into keep.
 * @param {Map<string, string>} redirect oldId -> keepId
 */
async function remapCuriosityReferences(redirect) {
  if (redirect.size === 0) return;
  const all = await CuriosityItem.listAll('-created_date');
  const snap = getCuriosityPagePursuitSnapshot();

  for (const item of all) {
    const origP = item.parent_curiosity_id != null ? String(item.parent_curiosity_id) : '';
    const origR = item.root_curiosity_id != null ? String(item.root_curiosity_id) : '';
    let pid = origP;
    let rid = origR;
    if (pid && redirect.has(pid)) pid = redirect.get(pid);
    if (rid && redirect.has(rid)) rid = redirect.get(rid);
    const patch = {};
    if (pid !== origP) patch.parent_curiosity_id = pid || null;
    if (rid !== origR) patch.root_curiosity_id = rid;
    if (Object.keys(patch).length) {
      await CuriosityItem.update(item.id, patch);
    }
  }

  const tasks = await ScheduledTask.listAll('-created_date');
  for (const t of tasks) {
    const tid = String(t.target_curiosity_id || '').trim();
    if (!tid || !redirect.has(tid)) continue;
    const next = redirect.get(tid);
    if (next && next !== tid) {
      await ScheduledTask.update(t.id, { target_curiosity_id: next });
    }
  }

  for (const [fromId, toId] of redirect.entries()) {
    const from = String(fromId);
    const to = String(toId);
    const a = snap.pursuits[from];
    const b = snap.pursuits[to];
    if (a && !b && (a.running || a.cooperativePaused || a.interruptedByReload || (a.pursuitProgress && a.pursuitProgress !== 'Starting…'))) {
      upsertCuriosityPursuit(to, { ...a, running: false });
    }
    removeCuriosityPursuit(from);
  }
}

/**
 * @param {{ skipRunningIds?: Set<string> }} [opts]
 * @returns {Promise<{ merged: number, deleted: number, message: string, skippedRunning?: number }>}
 */
export async function consolidateDuplicateCuriosityItemsInStore(opts = {}) {
  const raw = await CuriosityItem.listAll('-created_date');
  const rows = raw.slice(0, CURIOSITY_LIMIT);
  if (rows.length < 2) {
    return { merged: 0, deleted: 0, message: 'Not enough questions to consolidate.' };
  }

  const skipRunning = opts.skipRunningIds || new Set();
  const payload = rows.map((q) => ({
    id: q.id,
    question: clipTextComplete(String(q.question || ''), 280, { ellipsis: true }),
    status: String(q.status || 'open'),
    priority: typeof q.priority === 'number' ? q.priority : 0.5,
    parent_curiosity_id: q.parent_curiosity_id || null,
    root_curiosity_id: q.root_curiosity_id || null,
  }));

  const result = await invokeLLM({
    prompt: `You group NEAR-DUPLICATE curiosity questions: the same or paraphrased inquiry. Only merge when they are the same question.

RULES:
- Output disjoint clusters. Each cluster: keepId (row to keep), mergeIds (all ids in the group including keepId).
- mergeIds must have at least 2 entries.
- keepId must be in mergeIds.
- Optional canonicalQuestion: single clearer question (<= 500 chars).

QUESTIONS:
${JSON.stringify(payload, null, 2)}`,
    response_json_schema: CLUSTERS_SCHEMA,
  });

  const clustersRaw = Array.isArray(result?.clusters) ? result.clusters : [];
  const idSet = new Set(rows.map((r) => r.id));
  const used = new Set();
  /** @type {Map<string, string>} */
  const redirect = new Map();
  /** @type {typeof clustersRaw} */
  const clusters = [];
  let skippedRunning = 0;

  for (const c of clustersRaw) {
    const keepId = String(c.keepId || '').trim();
    const mergeIds = Array.isArray(c.mergeIds) ? c.mergeIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (!keepId || mergeIds.length < 2) continue;
    if (!mergeIds.includes(keepId)) continue;
    const unknown = mergeIds.filter((id) => !idSet.has(id));
    if (unknown.length) continue;
    if (mergeIds.some((id) => skipRunning.has(id))) {
      skippedRunning += 1;
      continue;
    }
    const dup = mergeIds.some((id) => used.has(id));
    if (dup) continue;
    mergeIds.forEach((id) => used.add(id));
    for (const id of mergeIds) {
      if (id !== keepId) redirect.set(id, keepId);
    }
    clusters.push(c);
  }

  if (redirect.size === 0) {
    return {
      merged: 0,
      deleted: 0,
      message: skippedRunning ? 'No clusters applied (skipped groups with active pursuit).' : 'No duplicate clusters found.',
      skippedRunning,
    };
  }

  await remapCuriosityReferences(redirect);

  let deleted = 0;
  let merged = 0;

  for (const c of clusters) {
    const keepId = String(c.keepId || '').trim();
    const mergeIds = Array.isArray(c.mergeIds) ? c.mergeIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (!keepId || mergeIds.length < 2 || !mergeIds.includes(keepId)) continue;
    if (mergeIds.some((id) => !idSet.has(id))) continue;
    if (mergeIds.some((id) => skipRunning.has(id))) continue;

    const others = mergeIds.filter((id) => id !== keepId);
    if (others.length === 0) continue;

    const keep = await CuriosityItem.retrieve(keepId);
    if (!keep) continue;

    const members = await Promise.all(mergeIds.map((id) => CuriosityItem.retrieve(id)));
    if (members.some((m) => !m)) continue;

    let maxP = typeof keep.priority === 'number' ? keep.priority : 0.5;
    let sumRet = Number(keep.times_returned_to) || 0;
    let bestThread = String(keep.pursuit_thread || '').trim();

    for (const m of members) {
      if (!m || m.id === keepId) continue;
      const p = typeof m.priority === 'number' ? m.priority : 0.5;
      maxP = Math.max(maxP, p);
      sumRet += Number(m.times_returned_to) || 0;
      const th = String(m.pursuit_thread || '').trim();
      if (th.length > bestThread.length) bestThread = th;
    }

    const canon = String(c.canonicalQuestion || '').trim();
    const question = canon ? clipTextComplete(canon, 500, { ellipsis: false }) : keep.question;

    const rootKeep = keep.root_curiosity_id || keep.id;
    await CuriosityItem.update(keepId, {
      question,
      priority: maxP,
      times_returned_to: sumRet,
      ...(bestThread ? { pursuit_thread: bestThread } : {}),
      root_curiosity_id: rootKeep,
      parent_curiosity_id: keep.parent_curiosity_id || null,
    });

    merged += 1;
    for (const oid of others) {
      if (!isValidIndexedDbRecordKey(oid)) continue;
      await CuriosityItem.delete(oid);
      deleted += 1;
    }
  }

  flushCuriosityPursuitsPersistNow();
  notifyMindStorageChanged({ source: 'curiosity' });
  notifyMindStorageChanged({ source: 'scheduled-tasks' });
  return {
    merged,
    deleted,
    message: `Merged ${merged} cluster(s); removed ${deleted} duplicate row(s).`,
    skippedRunning,
  };
}
