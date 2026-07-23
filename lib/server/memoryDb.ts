import "server-only";
import { Redis } from "@upstash/redis";

/**
 * Real, server-side persistent memory, keyed by an anonymous per-browser
 * mindId (see lib/mindId.ts) — there's no account system, so this is the
 * unit of "whose mind is this." Backed by Upstash Redis (the actively
 * maintained path for Vercel's KV storage — see README for the one-time
 * setup step in the Vercel dashboard).
 *
 * Without a Redis integration connected, this falls back to an in-memory
 * Map. That's fine for local `next dev` (a single long-running process) but
 * is NOT real persistence in production: each serverless invocation can get
 * a fresh instance, so data can vanish at any time. It exists purely so the
 * app still runs before you've done the one-time setup, not as a substitute
 * for it.
 */

export interface StoredEpisode {
  id: string;
  timestamp: number;
  sessionNumber: number;
  stimulus: string;
  emotion: string;
  reasoning: string;
  voice: string;
}

export interface MindData {
  identityNarrative: string;
  episodes: StoredEpisode[];
}

const MAX_EPISODES = 40;
const MAX_FIELD_LEN = 400;
const EMPTY_MIND: MindData = { identityNarrative: "", episodes: [] };

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

let redis: Redis | null = null;
function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

// Dev-only fallback — see module doc comment above.
const memoryFallbackStore = new Map<string, MindData>();

function keyFor(mindId: string): string {
  return `mindchain:mind:${mindId}`;
}

async function readMind(mindId: string): Promise<MindData> {
  const client = getRedis();
  if (client) {
    const data = await client.get<MindData>(keyFor(mindId));
    return data ?? { ...EMPTY_MIND };
  }
  return memoryFallbackStore.get(mindId) ?? { ...EMPTY_MIND };
}

async function writeMind(mindId: string, data: MindData): Promise<void> {
  const client = getRedis();
  if (client) {
    await client.set(keyFor(mindId), data);
    return;
  }
  memoryFallbackStore.set(mindId, data);
}

export function isBackendConfigured(): boolean {
  return getRedis() !== null;
}

export async function getMindData(mindId: string): Promise<MindData> {
  return readMind(mindId);
}

export async function setIdentityNarrative(mindId: string, text: string): Promise<MindData> {
  const data = await readMind(mindId);
  data.identityNarrative = truncate(text, MAX_FIELD_LEN * 2);
  await writeMind(mindId, data);
  return data;
}

export async function appendEpisode(
  mindId: string,
  episode: Omit<StoredEpisode, "id" | "sessionNumber">,
): Promise<MindData> {
  const data = await readMind(mindId);
  const entry: StoredEpisode = {
    id: `${episode.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    sessionNumber: data.episodes.length + 1,
    timestamp: episode.timestamp,
    stimulus: truncate(episode.stimulus, MAX_FIELD_LEN),
    emotion: truncate(episode.emotion, MAX_FIELD_LEN),
    reasoning: truncate(episode.reasoning, MAX_FIELD_LEN),
    voice: truncate(episode.voice, MAX_FIELD_LEN),
  };
  data.episodes = [...data.episodes, entry].slice(-MAX_EPISODES);
  await writeMind(mindId, data);
  return data;
}

export async function clearMind(mindId: string): Promise<void> {
  const client = getRedis();
  if (client) {
    await client.del(keyFor(mindId));
    return;
  }
  memoryFallbackStore.delete(mindId);
}
