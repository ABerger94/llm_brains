"use client";

/**
 * Persistent memory, backed by localStorage. This is what makes the mind
 * continuous across sessions instead of resetting to a blank slate each
 * time. A "session" is one full pipeline run (one stimulus processed
 * end-to-end). Each session:
 *  - appends a compact episode to episodic memory (capped at the most
 *    recent 40), and
 *  - has the Identity module (not a separate log) rewrite the persisted
 *    identity narrative in full — consolidation, not concatenation, same as
 *    how biological memory consolidation compresses experience rather than
 *    accumulating a verbatim transcript forever.
 */

export interface MemoryEpisode {
  id: string;
  timestamp: number;
  sessionNumber: number;
  stimulus: string;
  emotion: string;
  reasoning: string;
  voice: string;
}

export interface TemporalSnapshot {
  /** 1-indexed number of the session about to run. */
  sessionNumber: number;
  /** Completed sessions before this one. */
  totalSessions: number;
  mostRecentSessionSummary: string;
  /** A session from roughly 10 sessions back, "" if not enough history exists. */
  olderSessionSummary: string;
}

const EPISODES_KEY = "mindchain.episodes.v1";
const IDENTITY_NARRATIVE_KEY = "mindchain.identityNarrative.v1";
const MAX_EPISODES = 40;
const MAX_FIELD_LEN = 400;
const OLDER_SESSION_LOOKBACK = 10;

function hasStorage(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

export function getEpisodes(): MemoryEpisode[] {
  if (!hasStorage()) return [];
  try {
    const raw = window.localStorage.getItem(EPISODES_KEY);
    return raw ? (JSON.parse(raw) as MemoryEpisode[]) : [];
  } catch {
    return [];
  }
}

export function addEpisode(episode: Omit<MemoryEpisode, "id" | "sessionNumber">): MemoryEpisode[] {
  if (!hasStorage()) return [];
  const existing = getEpisodes();
  const entry: MemoryEpisode = {
    id: `${episode.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    sessionNumber: existing.length + 1,
    timestamp: episode.timestamp,
    stimulus: truncate(episode.stimulus, MAX_FIELD_LEN),
    emotion: truncate(episode.emotion, MAX_FIELD_LEN),
    reasoning: truncate(episode.reasoning, MAX_FIELD_LEN),
    voice: truncate(episode.voice, MAX_FIELD_LEN),
  };
  const next = [...existing, entry].slice(-MAX_EPISODES);
  try {
    window.localStorage.setItem(EPISODES_KEY, JSON.stringify(next));
  } catch {
    // storage full/unavailable — memory just won't persist this run
  }
  return next;
}

export function getIdentityNarrative(): string {
  if (!hasStorage()) return "";
  try {
    return window.localStorage.getItem(IDENTITY_NARRATIVE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setIdentityNarrative(text: string): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(IDENTITY_NARRATIVE_KEY, truncate(text, MAX_FIELD_LEN * 2));
  } catch {
    // ignore
  }
}

export function clearMemory(): void {
  if (!hasStorage()) return;
  window.localStorage.removeItem(EPISODES_KEY);
  window.localStorage.removeItem(IDENTITY_NARRATIVE_KEY);
}

function summarizeEpisode(ep: MemoryEpisode): string {
  return `Session #${ep.sessionNumber} (${timeAgo(ep.timestamp)}): faced "${ep.stimulus}" — felt ${ep.emotion || "unclear"} — concluded: ${ep.reasoning}`;
}

/** What Temporal Awareness needs to locate this run in the mind's own history. */
export function getTemporalSnapshot(): TemporalSnapshot {
  const episodes = getEpisodes();
  const mostRecent = episodes[episodes.length - 1];
  const olderIndex = episodes.length - 1 - OLDER_SESSION_LOOKBACK;
  const older = olderIndex >= 0 ? episodes[olderIndex] : undefined;
  return {
    sessionNumber: episodes.length + 1,
    totalSessions: episodes.length,
    mostRecentSessionSummary: mostRecent ? summarizeEpisode(mostRecent) : "",
    olderSessionSummary: older ? summarizeEpisode(older) : "",
  };
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for",
  "with", "is", "are", "was", "were", "be", "been", "it", "this", "that",
  "you", "your", "i", "my", "me", "as", "from", "into", "about",
]);

/** Formats up to `limit` past episodes relevant to `stimulus` as plain text for a prompt. */
export function retrieveRelevantEpisodes(stimulus: string, limit = 3): string {
  const episodes = getEpisodes();
  if (episodes.length === 0) return "";

  const queryWords = tokenize(stimulus).filter((w) => !STOPWORDS.has(w));
  const scored = episodes.map((ep) => {
    const words = new Set(
      tokenize(`${ep.stimulus} ${ep.reasoning} ${ep.voice}`).filter((w) => !STOPWORDS.has(w)),
    );
    let score = 0;
    for (const w of queryWords) if (words.has(w)) score++;
    return { ep, score };
  });

  scored.sort((a, b) => b.score - a.score || b.ep.timestamp - a.ep.timestamp);
  const relevant = scored.filter((s) => s.score > 0).slice(0, limit);
  // No genuine overlap: return nothing rather than forcing in unrelated past
  // episodes just because *something* exists in storage — a small model
  // will blend whatever it's given, and an unrelated memory bleeding into an
  // unrelated new stimulus produces incoherent mashups, not continuity.
  if (relevant.length === 0) return "";

  return relevant.map(({ ep }) => `- ${summarizeEpisode(ep)}`).join("\n");
}

function timeAgo(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export { timeAgo };
