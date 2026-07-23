"use client";

/**
 * Persistent memory, backed by a real server-side database (see
 * app/api/memory/route.ts + lib/server/memoryDb.ts), not just browser
 * localStorage. This is what makes the mind continuous across sessions
 * instead of resetting to a blank slate each time. A "session" is one full
 * pipeline run (one stimulus processed end-to-end). Each session:
 *  - appends a compact episode to episodic memory (capped at the most
 *    recent 40), and
 *  - has the Identity module (not a separate log) rewrite the persisted
 *    identity narrative in full — consolidation, not concatenation, same as
 *    how biological memory consolidation compresses experience rather than
 *    accumulating a verbatim transcript forever.
 *
 * The LLM itself still runs entirely in-browser (see lib/webllmEngine.ts) —
 * this module is only about where the resulting memory data lives. It's
 * fetched/saved through /api/memory, keyed by an anonymous per-browser
 * mindId (lib/mindId.ts), not tied to any account.
 */

import { getOrCreateMindId } from "./mindId";

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

export interface MindSnapshot {
  identityNarrative: string;
  episodes: MemoryEpisode[];
  /** False if the backend has no Redis connected — data won't reliably persist (see README). */
  backendConfigured: boolean;
}

const OLDER_SESSION_LOOKBACK = 10;
const EMPTY_SNAPSHOT: MindSnapshot = { identityNarrative: "", episodes: [], backendConfigured: false };

/** Fetches the current identity narrative + episode history from the backend. */
export async function fetchMindSnapshot(): Promise<MindSnapshot> {
  const mindId = getOrCreateMindId();
  if (!mindId) return EMPTY_SNAPSHOT;
  try {
    const res = await fetch(`/api/memory?mindId=${encodeURIComponent(mindId)}`, { cache: "no-store" });
    if (!res.ok) return EMPTY_SNAPSHOT;
    return (await res.json()) as MindSnapshot;
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

/** Saves this session's rewritten identity narrative and/or a new episode in one round trip. */
export async function saveSession(update: {
  identityNarrative?: string;
  newEpisode?: Omit<MemoryEpisode, "id" | "sessionNumber">;
}): Promise<MindSnapshot | null> {
  const mindId = getOrCreateMindId();
  if (!mindId) return null;
  try {
    const res = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mindId, ...update }),
    });
    if (!res.ok) return null;
    return (await res.json()) as MindSnapshot;
  } catch {
    return null;
  }
}

export async function clearMemory(): Promise<void> {
  const mindId = getOrCreateMindId();
  if (!mindId) return;
  try {
    await fetch(`/api/memory?mindId=${encodeURIComponent(mindId)}`, { method: "DELETE" });
  } catch {
    // non-fatal — worst case, old data just remains in the backend
  }
}

function summarizeEpisode(ep: MemoryEpisode): string {
  return `Session #${ep.sessionNumber} (${timeAgo(ep.timestamp)}): faced "${ep.stimulus}" — felt ${ep.emotion || "unclear"} — concluded: ${ep.reasoning}`;
}

/** What Temporal Awareness needs to locate this run in the mind's own history. */
export function getTemporalSnapshot(episodes: MemoryEpisode[]): TemporalSnapshot {
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
export function retrieveRelevantEpisodes(episodes: MemoryEpisode[], stimulus: string, limit = 3): string {
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

export function timeAgo(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
