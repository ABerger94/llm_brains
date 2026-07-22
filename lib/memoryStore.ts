"use client";

/**
 * Persistent memory, backed by localStorage. This is what makes the mind
 * continuous across sessions instead of resetting to a blank slate each
 * time: real past episodes get stored, and a rolling self-narrative gets
 * consolidated after every run — the same episode is never stored twice in
 * full, it's folded into an updated summary, similar to how biological
 * memory consolidation compresses experience rather than accumulating a
 * verbatim transcript forever.
 */

export interface MemoryEpisode {
  id: string;
  timestamp: number;
  stimulus: string;
  emotion: string;
  decision: string;
  consciousOutput: string;
}

const EPISODES_KEY = "mindchain.episodes.v1";
const SELF_NARRATIVE_KEY = "mindchain.selfNarrative.v1";
const MAX_EPISODES = 40;
const MAX_FIELD_LEN = 400;

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

export function addEpisode(episode: Omit<MemoryEpisode, "id">): MemoryEpisode[] {
  if (!hasStorage()) return [];
  const entry: MemoryEpisode = {
    id: `${episode.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: episode.timestamp,
    stimulus: truncate(episode.stimulus, MAX_FIELD_LEN),
    emotion: truncate(episode.emotion, MAX_FIELD_LEN),
    decision: truncate(episode.decision, MAX_FIELD_LEN),
    consciousOutput: truncate(episode.consciousOutput, MAX_FIELD_LEN),
  };
  const next = [...getEpisodes(), entry].slice(-MAX_EPISODES);
  try {
    window.localStorage.setItem(EPISODES_KEY, JSON.stringify(next));
  } catch {
    // storage full/unavailable — memory just won't persist this run
  }
  return next;
}

export function getSelfNarrative(): string {
  if (!hasStorage()) return "";
  try {
    return window.localStorage.getItem(SELF_NARRATIVE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setSelfNarrative(text: string): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(SELF_NARRATIVE_KEY, truncate(text, MAX_FIELD_LEN * 2));
  } catch {
    // ignore
  }
}

export function clearMemory(): void {
  if (!hasStorage()) return;
  window.localStorage.removeItem(EPISODES_KEY);
  window.localStorage.removeItem(SELF_NARRATIVE_KEY);
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
      tokenize(`${ep.stimulus} ${ep.consciousOutput}`).filter((w) => !STOPWORDS.has(w)),
    );
    let score = 0;
    for (const w of queryWords) if (words.has(w)) score++;
    return { ep, score };
  });

  scored.sort((a, b) => b.score - a.score || b.ep.timestamp - a.ep.timestamp);
  const relevant = scored.filter((s) => s.score > 0).slice(0, limit);
  const chosen = relevant.length > 0 ? relevant.map((s) => s.ep) : episodes.slice(-limit).reverse();

  return chosen
    .map((ep) => {
      const when = timeAgo(ep.timestamp);
      return `- (${when}) Faced "${ep.stimulus}" — felt ${ep.emotion || "unclear"} — decided: ${ep.decision}`;
    })
    .join("\n");
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
