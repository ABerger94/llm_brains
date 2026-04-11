/**
 * Embedding service: wraps OpenAI-compatible /v1/embeddings for HF Inference and LM Studio.
 * Provides cosine similarity, in-memory LRU cache, and graceful degradation.
 */

import OpenAI from 'openai';
import crypto from 'node:crypto';

const EPS = 1e-9;

function requiredEnv(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

function embeddingDisabled() {
  const v = String(process.env.EMBEDDING_DISABLED || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function resolveEmbeddingModel() {
  return requiredEnv('EMBEDDING_MODEL') || 'sentence-transformers/all-MiniLM-L6-v2';
}

function resolveCacheSize() {
  const raw = requiredEnv('EMBEDDING_CACHE_SIZE');
  if (raw && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 0 && n <= 100000) return n;
  }
  return 512;
}

/** Resolve the embedding API base URL, falling back to the LLM provider base. */
function resolveEmbeddingBaseURL() {
  const explicit = requiredEnv('EMBEDDING_BASE_URL');
  if (explicit) {
    const u = explicit.replace(/\/+$/, '');
    return /\/v1$/i.test(u) ? u : `${u}/v1`;
  }
  const hfBase = requiredEnv('HF_INFERENCE_BASE_URL') || 'https://router.huggingface.co';
  const localBase = requiredEnv('LOCAL_LLM_BASE_URL') || requiredEnv('OLLAMA_BASE_URL');
  const hfFirst = /^1|true|yes$/i.test(String(process.env.LLM_HF_FIRST || '').trim());
  const hfToken = requiredEnv('HF_TOKEN') || requiredEnv('HUGGINGFACE_API_TOKEN');

  let base;
  if (hfFirst && hfToken) {
    base = hfBase;
  } else if (localBase) {
    base = localBase;
  } else if (hfToken) {
    base = hfBase;
  }
  if (!base) return null;
  const u = base.replace(/\/+$/, '');
  return /\/v1$/i.test(u) ? u : `${u}/v1`;
}

function resolveEmbeddingApiKey() {
  const explicit = requiredEnv('EMBEDDING_API_KEY');
  if (explicit) return explicit;
  const hfToken = requiredEnv('HF_TOKEN') || requiredEnv('HUGGINGFACE_API_TOKEN');
  const hfFirst = /^1|true|yes$/i.test(String(process.env.LLM_HF_FIRST || '').trim());
  const localBase = requiredEnv('LOCAL_LLM_BASE_URL') || requiredEnv('OLLAMA_BASE_URL');
  if (hfFirst && hfToken) return hfToken;
  if (localBase) return requiredEnv('LM_API_TOKEN') || requiredEnv('LOCAL_LLM_API_KEY') || 'lm-studio';
  if (hfToken) return hfToken;
  return 'lm-studio';
}

// ── LRU Cache ─────────────────────────────────────────────────────────

class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key, val) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  get size() {
    return this.map.size;
  }
}

const cache = new LRUCache(resolveCacheSize());

function cacheKey(model, text) {
  return crypto.createHash('sha256').update(`${model}\0${text}`).digest('hex');
}

// ── Vector math ───────────────────────────────────────────────────────

function l2Norm(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  return Math.sqrt(s);
}

function normalizeVec(vec) {
  const norm = l2Norm(vec);
  if (norm < EPS) return vec;
  return vec.map((x) => x / norm);
}

/** Cosine similarity between two vectors. Assumes normalized input for speed; works on unnormalized too. */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > EPS ? dot / denom : 0;
}

/** Build a similarity matrix: result[i][j] = cosineSimilarity(vecs[i], vecs[j]). */
export function buildSimilarityMatrix(vecs) {
  const n = vecs.length;
  const mat = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    mat[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const s = cosineSimilarity(vecs[i], vecs[j]);
      mat[i][j] = s;
      mat[j][i] = s;
    }
  }
  return mat;
}

// ── API calls ─────────────────────────────────────────────────────────

let _client = null;

function getClient() {
  if (_client) return _client;
  const baseURL = resolveEmbeddingBaseURL();
  const apiKey = resolveEmbeddingApiKey();
  if (!baseURL) return null;
  _client = new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: { Authorization: `Bearer ${apiKey}` },
    timeout: 30_000,
  });
  return _client;
}

/** Reset cached client (e.g. after env change). */
export function resetEmbeddingClient() {
  _client = null;
}

/**
 * Get embeddings for one or more texts.
 * @param {string[]} texts
 * @param {{ model?: string }} [options]
 * @returns {Promise<number[][]>} L2-normalized vectors
 */
export async function getEmbeddings(texts, options = {}) {
  if (embeddingDisabled()) return null;
  if (!texts || !texts.length) return [];

  const model = options.model || resolveEmbeddingModel();
  const results = new Array(texts.length);
  const uncached = [];
  const uncachedIdx = [];

  for (let i = 0; i < texts.length; i++) {
    const key = cacheKey(model, texts[i]);
    const hit = cache.get(key);
    if (hit !== undefined) {
      results[i] = hit;
    } else {
      uncached.push(texts[i]);
      uncachedIdx.push(i);
    }
  }

  if (uncached.length > 0) {
    const client = getClient();
    if (!client) return null;

    try {
      const resp = await client.embeddings.create({
        model,
        input: uncached,
      });
      const data = resp.data || [];
      data.sort((a, b) => a.index - b.index);
      for (let j = 0; j < data.length; j++) {
        const vec = normalizeVec(data[j].embedding);
        const origIdx = uncachedIdx[j];
        results[origIdx] = vec;
        cache.set(cacheKey(model, uncached[j]), vec);
      }
    } catch (err) {
      console.warn('[embeddingService] Embedding API call failed, returning null:', err?.message || err);
      return null;
    }
  }

  if (results.some((v) => v === undefined)) {
    console.warn('[embeddingService] Sparse results from embedding API; returning null for safety');
    return null;
  }

  return results;
}

/**
 * Get embedding for a single text.
 * @param {string} text
 * @param {{ model?: string }} [options]
 * @returns {Promise<number[]|null>}
 */
export async function getEmbedding(text, options = {}) {
  const vecs = await getEmbeddings([text], options);
  if (!vecs || !vecs.length) return null;
  return vecs[0];
}

/**
 * Compute pairwise similarities between a query and a list of texts.
 * @param {string} query
 * @param {string[]} candidates
 * @returns {Promise<number[]|null>} similarity scores, or null if embeddings unavailable
 */
export async function querySimilarities(query, candidates) {
  if (embeddingDisabled()) return null;
  if (!candidates.length) return [];
  const all = [query, ...candidates];
  const vecs = await getEmbeddings(all);
  if (!vecs) return null;
  const qVec = vecs[0];
  return vecs.slice(1).map((v) => cosineSimilarity(qVec, v));
}

/** Diagnostic: cache stats for health endpoint. */
export function embeddingCacheStats() {
  return {
    size: cache.size,
    maxSize: resolveCacheSize(),
    disabled: embeddingDisabled(),
    model: resolveEmbeddingModel(),
    baseURL: resolveEmbeddingBaseURL(),
  };
}
