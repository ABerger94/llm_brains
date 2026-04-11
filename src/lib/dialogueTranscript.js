import { BELIEF_TENSION_REVIEW_PRIMARY_MARKER } from '../../shared/beliefRevisionsVoice.mjs';
import { DEFAULT_GRAPH_SESSION_ID } from './graphPipelineSessionScope';

/**
 * Effective graph session id for a conversation row (matches graph pipeline transcript rules).
 * @param {{ graph_session_id?: string | null }} row
 * @returns {string}
 */
export function effectiveGraphSessionId(row) {
  const tag = row?.graph_session_id;
  if (tag != null && String(tag).trim()) return String(tag).trim();
  return DEFAULT_GRAPH_SESSION_ID;
}

/**
 * @param {object[]} rows
 * @returns {Map<string, object[]>} sessionId -> messages sorted by created_date ascending
 */
export function groupMessagesBySession(rows) {
  /** @type {Map<string, object[]>} */
  const map = new Map();
  for (const r of rows || []) {
    const sid = effectiveGraphSessionId(r);
    if (!map.has(sid)) map.set(sid, []);
    map.get(sid).push(r);
  }
  for (const arr of map.values()) {
    const dateMs = (r) => { const t = Date.parse(r?.created_date); return Number.isFinite(t) ? t : 0; };
    arr.sort((a, b) => dateMs(a) - dateMs(b));
  }
  return map;
}

/**
 * @typedef {{
 *   userText: string,
 *   voiceText: string | null,
 *   userCreated: string,
 *   voiceCreated: string | null,
 *   userId: string,
 *   voiceId: string | null,
 * }} UserVoicePair
 */

/**
 * Pair user turns with Voice (assistant) using reply_to first, then next unused assistant in time order.
 * @param {object[]} sortedRows - messages for one session, any order
 * @returns {UserVoicePair[]}
 */
export function pairUserVoiceForSession(sortedRows) {
  const rows = [...sortedRows].sort(
    (a, b) => new Date(a.created_date).getTime() - new Date(b.created_date).getTime()
  );
  const usedAssistantIds = new Set();
  const pairedUserIds = new Set();
  /** @type {UserVoicePair[]} */
  const pairs = [];

  for (const r of rows) {
    if ((r.role || '') !== 'user') continue;
    const voiceRow = rows.find((x) => x.role === 'assistant' && x.reply_to === r.id);
    if (voiceRow) {
      usedAssistantIds.add(voiceRow.id);
      pairedUserIds.add(r.id);
      pairs.push({
        userText: String(r.content || '').trim(),
        voiceText: String(voiceRow.content || '').trim() || null,
        userCreated: r.created_date,
        voiceCreated: voiceRow.created_date,
        userId: r.id,
        voiceId: voiceRow.id,
      });
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if ((r.role || '') !== 'user' || pairedUserIds.has(r.id)) continue;
    let voiceRow = null;
    for (let j = i + 1; j < rows.length; j++) {
      const x = rows[j];
      if (x.role === 'assistant' && !usedAssistantIds.has(x.id)) {
        voiceRow = x;
        break;
      }
    }
    if (voiceRow) {
      usedAssistantIds.add(voiceRow.id);
      pairedUserIds.add(r.id);
      pairs.push({
        userText: String(r.content || '').trim(),
        voiceText: String(voiceRow.content || '').trim() || null,
        userCreated: r.created_date,
        voiceCreated: voiceRow.created_date,
        userId: r.id,
        voiceId: voiceRow.id,
      });
    } else {
      pairs.push({
        userText: String(r.content || '').trim(),
        voiceText: null,
        userCreated: r.created_date,
        voiceCreated: null,
        userId: r.id,
        voiceId: null,
      });
    }
  }

  pairs.sort((a, b) => new Date(a.userCreated).getTime() - new Date(b.userCreated).getTime());
  return pairs;
}

/**
 * @param {Map<string, object[]>} bySession
 * @returns {{ sessionId: string, lastActivity: number, userCount: number, pairCount: number }[]}
 */
export function summarizeSessionsForDialogueIndex(bySession) {
  const out = [];
  for (const [sessionId, msgs] of bySession.entries()) {
    const userCount = msgs.filter((m) => (m.role || '') === 'user').length;
    if (userCount === 0) continue;
    let lastActivity = 0;
    for (const m of msgs) {
      const t = new Date(m.created_date).getTime();
      if (!Number.isNaN(t)) lastActivity = Math.max(lastActivity, t);
    }
    const pairs = pairUserVoiceForSession(msgs);
    out.push({ sessionId, lastActivity, userCount, pairCount: pairs.length });
  }
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  return out;
}

/**
 * @param {string} sessionId
 * @param {{ id: string, label?: string }[]} registryRows
 * @returns {string}
 */
export function labelForDialogueSession(sessionId, registryRows) {
  const sid = String(sessionId || '').trim();
  const row = (registryRows || []).find((r) => r && String(r.id).trim() === sid);
  if (row && typeof row.label === 'string' && row.label.trim()) return row.label.trim();
  if (sid === DEFAULT_GRAPH_SESSION_ID) return 'Default';
  return sid.length > 14 ? `${sid.slice(0, 8)}…${sid.slice(-4)}` : sid;
}

/**
 * Pipeline run ids stored with this graph session (links CuriosityItem/GoalItem via last_pursuit_pipeline_run_id).
 * @param {string} sessionId
 * @param {object[]} pipelineRuns
 * @returns {Set<string>}
 */
export function pipelineRunIdsForGraphSession(sessionId, pipelineRuns) {
  const sid = String(sessionId || '').trim();
  const ids = new Set();
  for (const r of pipelineRuns || []) {
    const g = r?.graph_session_id;
    const effective = (g != null && String(g).trim()) ? String(g).trim() : DEFAULT_GRAPH_SESSION_ID;
    if (effective === sid) {
      ids.add(String(r.id));
    }
  }
  return ids;
}

function sortItemsByRecent(a, b) {
  const ta = new Date(a.updated_date || a.created_date || 0).getTime();
  const tb = new Date(b.updated_date || b.created_date || 0).getTime();
  return tb - ta;
}

/**
 * Curiosity rows whose last graph pursuit run belongs to this dialogue session.
 */
export function curiosityItemsForDialogueSession(sessionId, curiosityItems, pipelineRuns) {
  const runIds = pipelineRunIdsForGraphSession(sessionId, pipelineRuns);
  const out = (curiosityItems || []).filter((it) => {
    const rid = it?.last_pursuit_pipeline_run_id;
    return rid != null && runIds.has(String(rid));
  });
  out.sort(sortItemsByRecent);
  return out;
}

/**
 * Goal rows whose last graph pursuit run belongs to this dialogue session.
 */
export function goalItemsForDialogueSession(sessionId, goalItems, pipelineRuns) {
  const runIds = pipelineRunIdsForGraphSession(sessionId, pipelineRuns);
  const out = (goalItems || []).filter((it) => {
    const rid = it?.last_pursuit_pipeline_run_id;
    return rid != null && runIds.has(String(rid));
  });
  out.sort(sortItemsByRecent);
  return out;
}

/**
 * Recent items with something to show as an answer (resolution or pursuit thread), for the dialogue index.
 * @param {object[]} items
 * @param {number} limit
 */
export function recentCuriosityWithAnswers(items, limit = 8) {
  const pool = (items || []).filter((it) => {
    const res = String(it?.resolution || '').trim();
    const th = String(it?.pursuit_thread || '').trim();
    return res.length > 0 || th.length > 0;
  });
  pool.sort(sortItemsByRecent);
  return pool.slice(0, Math.max(0, limit));
}

export function recentGoalsWithAnswers(items, limit = 8) {
  const pool = (items || []).filter((it) => {
    const res = String(it?.resolution || '').trim();
    const th = String(it?.pursuit_thread || '').trim();
    return res.length > 0 || th.length > 0;
  });
  pool.sort(sortItemsByRecent);
  return pool.slice(0, Math.max(0, limit));
}

export function truncateDialogueSnippet(text, maxLen = 560) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}

/** @param {object | null | undefined} item */
export function effectiveCuriosityRootId(item) {
  if (!item?.id) return '';
  const r = item.root_curiosity_id;
  if (r != null && String(r).trim()) return String(r).trim();
  return String(item.id);
}

/**
 * All curiosity items in the same thread cluster as `rootId` (root id = root_curiosity_id || id).
 * Sorted by pursuit_depth then created_date (ascending).
 * @param {string} rootId
 * @param {object[]} items
 */
export function curiosityThreadItems(rootId, items) {
  const r = String(rootId || '').trim();
  if (!r) return [];
  const out = (items || []).filter((it) => effectiveCuriosityRootId(it) === r);
  out.sort((a, b) => {
    const da = Number(a.pursuit_depth ?? 0);
    const db = Number(b.pursuit_depth ?? 0);
    if (da !== db) return da - db;
    const ta = new Date(a.created_date || 0).getTime();
    const tb = new Date(b.created_date || 0).getTime();
    return ta - tb;
  });
  return out;
}

/** @param {object | null | undefined} item */
export function effectiveGoalRootId(item) {
  if (!item?.id) return '';
  const r = item.root_goal_id;
  if (r != null && String(r).trim()) return String(r).trim();
  return String(item.id);
}

/**
 * @param {string} rootId
 * @param {object[]} items
 */
export function goalThreadItems(rootId, items) {
  const r = String(rootId || '').trim();
  if (!r) return [];
  const out = (items || []).filter((it) => effectiveGoalRootId(it) === r);
  out.sort((a, b) => {
    const da = Number(a.pursuit_depth ?? 0);
    const db = Number(b.pursuit_depth ?? 0);
    if (da !== db) return da - db;
    const ta = new Date(a.created_date || 0).getTime();
    const tb = new Date(b.created_date || 0).getTime();
    return ta - tb;
  });
  return out;
}

/**
 * Primary answer line for dialogue detail: resolution, else pursuit_thread.
 * @param {object} item
 */
export function curiosityAnswerBody(item) {
  const res = String(item?.resolution || '').trim();
  if (res) return res;
  return String(item?.pursuit_thread || '').trim();
}

/**
 * @param {object} item
 */
export function goalAnswerBody(item) {
  const res = String(item?.resolution || '').trim();
  if (res) return res;
  return String(item?.pursuit_thread || '').trim();
}

function ensureArray(x) {
  if (Array.isArray(x)) return x;
  return [];
}

/**
 * True if this saved pipeline run was a belief tension review (scheduled or same primary prompt).
 * @param {{ input?: string }} run
 */
export function isBeliefTensionReviewPipelineRun(run) {
  return String(run?.input || '').includes(BELIEF_TENSION_REVIEW_PRIMARY_MARKER);
}

/**
 * Parse the scheduled belief-tension prompt: active tensions + belief sample lines.
 * @param {string} input
 * @returns {{ stemTensions: string[], stemBeliefs: string[] }}
 */
export function parseBeliefTensionReviewPrompt(input) {
  const s = String(input || '');
  if (!s.includes(BELIEF_TENSION_REVIEW_PRIMARY_MARKER)) {
    return { stemTensions: [], stemBeliefs: [] };
  }
  const m = s.match(
    /Active tensions \(Belief Map\):\s*([\s\S]*?)Active beliefs \(sample\):\s*([\s\S]*?)(?:This mind|$)/i
  );
  const bulletLines = (block) => {
    if (!block) return [];
    const lines = block.split(/\r?\n/);
    const out = [];
    for (const raw of lines) {
      const t = String(raw || '')
        .replace(/^\s*[-*•]\s*/, '')
        .trim();
      if (!t || /^\(none\b/i.test(t)) continue;
      out.push(t);
    }
    return out.slice(0, 14);
  };
  if (!m) {
    return { stemTensions: [], stemBeliefs: [] };
  }
  const stemTensions = bulletLines(m[1]);
  const stemBeliefs = bulletLines(m[2]).map((line) => line.replace(/^["']|["']$/g, '').trim());
  return { stemTensions, stemBeliefs };
}

/**
 * Questions, goals, beliefs, and tensions tied to a belief tension review run:
 * merges the scheduled prompt (what triggered the pass) with Integration / shared memory after the run.
 * @param {{ input?: string, shared_memory?: object }} run
 */
export function relationsFromBeliefTensionReviewRun(run) {
  const parsed = parseBeliefTensionReviewPrompt(run?.input || '');
  const sm = run?.shared_memory && typeof run.shared_memory === 'object' ? run.shared_memory : {};
  const gw = sm.globalWorkspace || {};

  const fromSm = {
    questions: ensureArray(gw.openQuestions)
      .map((x) => String(x).trim())
      .filter(Boolean),
    curiosityQueue: ensureArray(sm.curiosityQueue)
      .map((x) => String(x).trim())
      .filter(Boolean),
    goals: [
      ...ensureArray(sm.activeGoals?.immediate),
      ...ensureArray(sm.activeGoals?.longTerm),
    ]
      .map((x) => String(x).trim())
      .filter(Boolean),
    beliefs: ensureArray(sm.beliefStore)
      .map((b) => {
        if (b && typeof b === 'object') return String(b.belief || '').trim();
        return String(b || '').trim();
      })
      .filter(Boolean),
    tensions: ensureArray(sm.beliefTensions)
      .map((t) => String(t?.description || '').trim())
      .filter(Boolean),
  };

  const mergeDedupe = (lists, cap) => {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
      for (const x of list) {
        const k = x.toLowerCase().slice(0, 160);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(x);
        if (out.length >= cap) return out;
      }
    }
    return out;
  };

  const relatedQuestions = mergeDedupe([fromSm.questions, fromSm.curiosityQueue], 12);
  const relatedBeliefs = mergeDedupe([fromSm.beliefs], 12);
  const relatedTensions = mergeDedupe([fromSm.tensions], 12);

  return {
    stemTensions: parsed.stemTensions,
    stemBeliefs: parsed.stemBeliefs,
    relatedQuestions,
    relatedGoals: fromSm.goals.slice(0, 12),
    relatedBeliefs,
    relatedTensions,
  };
}

/**
 * Recent belief tension review runs, newest first.
 * @param {object[]} pipelineRuns
 * @param {number} limit
 */
export function recentBeliefTensionReviewRuns(pipelineRuns, limit = 12) {
  const pool = (pipelineRuns || []).filter((r) => isBeliefTensionReviewPipelineRun(r));
  pool.sort((a, b) => {
    const ta = new Date(a.created_date || 0).getTime();
    const tb = new Date(b.created_date || 0).getTime();
    return tb - ta;
  });
  return pool.slice(0, Math.max(0, limit));
}

/**
 * Belief tension review pipeline runs for a dialogue session (matches {@link effectiveGraphSessionId}).
 * @param {string} sessionId
 * @param {object[]} pipelineRuns
 */
export function beliefTensionReviewsForDialogueSession(sessionId, pipelineRuns) {
  const sid = String(sessionId || '').trim() || DEFAULT_GRAPH_SESSION_ID;
  const pool = (pipelineRuns || []).filter(
    (r) => isBeliefTensionReviewPipelineRun(r) && effectiveGraphSessionId(r) === sid
  );
  pool.sort((a, b) => {
    const ta = new Date(a.created_date || 0).getTime();
    const tb = new Date(b.created_date || 0).getTime();
    return tb - ta;
  });
  return pool;
}
