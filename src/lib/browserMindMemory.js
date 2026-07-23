/**
 * Persistent memory for the "Browser Mind" page, ported from llm_brains'
 * lib/memoryStore.ts + lib/server/memoryDb.ts — but backed directly by this
 * app's existing IndexedDB storage (browserStorage.js), not Upstash Redis /
 * a server API route. There's no server component to this page at all: the
 * LLM runs in-browser (browserLlmEngine.js) and now so does its memory.
 *
 * A "session" = one full pipeline run. Each session:
 *  - appends a compact episode to episodic memory (capped at the most
 *    recent 40), and
 *  - has the Identity module (not a separate log) rewrite the persisted
 *    identity narrative in full — consolidation, not concatenation.
 *
 * Single local record (no per-browser mindId/account indirection needed —
 * everything here already lives in this browser's own IndexedDB).
 */

import { idbGetRecordValue, idbPutRecord, idbDeleteRecord } from './browserStorage';

const RECORD_ID = 'browser-mind-memory';
const ENTITY_TYPE = 'BrowserMindMemory';
const MAX_EPISODES = 40;
const OLDER_SESSION_LOOKBACK = 10;

const EMPTY_MIND = { identityNarrative: '', episodes: [] };

async function readMind() {
  const value = await idbGetRecordValue(RECORD_ID);
  return value ?? { ...EMPTY_MIND };
}

async function writeMind(data) {
  await idbPutRecord({ id: RECORD_ID, entityType: ENTITY_TYPE, value: data });
}

/** Fetches the current identity narrative + episode history. */
export async function fetchMindSnapshot() {
  return readMind();
}

/** Saves this session's rewritten identity narrative and/or a new episode in one round trip. */
export async function saveSession(update) {
  const data = await readMind();
  if (update.identityNarrative) {
    data.identityNarrative = update.identityNarrative;
  }
  if (update.newEpisode) {
    const entry = {
      id: `${update.newEpisode.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      sessionNumber: data.episodes.length + 1,
      ...update.newEpisode,
    };
    data.episodes = [...data.episodes, entry].slice(-MAX_EPISODES);
  }
  await writeMind(data);
  return data;
}

export async function clearMemory() {
  await idbDeleteRecord(RECORD_ID);
}

function summarizeEpisode(ep) {
  return `Session #${ep.sessionNumber} (${timeAgo(ep.timestamp)}): faced "${ep.stimulus}" — felt ${ep.emotion || 'unclear'} — concluded: ${ep.reasoning}`;
}

/** What Temporal Awareness needs to locate this run in the mind's own history. */
export function getTemporalSnapshot(episodes) {
  const mostRecent = episodes[episodes.length - 1];
  const olderIndex = episodes.length - 1 - OLDER_SESSION_LOOKBACK;
  const older = olderIndex >= 0 ? episodes[olderIndex] : undefined;
  return {
    sessionNumber: episodes.length + 1,
    totalSessions: episodes.length,
    mostRecentSessionSummary: mostRecent ? summarizeEpisode(mostRecent) : '',
    olderSessionSummary: older ? summarizeEpisode(older) : '',
  };
}

function tokenize(text) {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that',
  'you', 'your', 'i', 'my', 'me', 'as', 'from', 'into', 'about',
]);

/** Formats up to `limit` past episodes relevant to `stimulus` as plain text for a prompt. */
export function retrieveRelevantEpisodes(episodes, stimulus, limit = 3) {
  if (episodes.length === 0) return '';

  const queryWords = tokenize(stimulus).filter((w) => !STOPWORDS.has(w));
  const scored = episodes.map((ep) => {
    const words = new Set(
      tokenize(`${ep.stimulus} ${ep.reasoning} ${ep.voice}`).filter((w) => !STOPWORDS.has(w))
    );
    let score = 0;
    for (const w of queryWords) if (words.has(w)) score++;
    return { ep, score };
  });

  scored.sort((a, b) => b.score - a.score || b.ep.timestamp - a.ep.timestamp);
  const relevant = scored.filter((s) => s.score > 0).slice(0, limit);
  if (relevant.length === 0) return '';

  return relevant.map(({ ep }) => `- ${summarizeEpisode(ep)}`).join('\n');
}

export function timeAgo(timestamp) {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
