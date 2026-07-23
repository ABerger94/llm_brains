import dotenv from 'dotenv';
import cors from 'cors';
import express from 'express';
import OpenAI from 'openai';
import multer from 'multer';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Always load project-root `.env` (cwd may not be the repo when the server is spawned). */
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Hugging Face router + local LM use explicit OpenAI client instances; strip global cloud env so the SDK never picks them up by default.
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;
delete process.env.GROQ_API_KEY;

import {
  runPipeline,
  runSingleModule,
  createSharedMemory,
  formatSharedMemoryForModule,
  snapshotGlobalWorkspaceForCarryover,
  slimSharedMemoryForSse,
} from './pipeline.js';
import { requestPipelinePause } from './pipelinePauseRegistry.js';
import {
  initWorkspaceDb,
  insertWorkspaceSnapshot,
  getWorkspaceDbStatus,
  getLatestWorkspaceSnapshot,
  buildPipelineProgressRecord,
  insertScheduledTask,
  listScheduledTasks,
  deleteScheduledTask,
  setSchedulerPaused,
  isSchedulerPaused,
} from './workspaceDb.js';
import { startServerScheduler, stopServerScheduler } from './serverScheduler.js';
import { normalizeExecutionResume } from '../shared/pipelineExecutionResume.mjs';
import {
  mergeMindRuntimeIntoSharedMemory,
  buildMindContextForModule,
  refreshInteroceptionAndPolicy,
} from './mindPolicy.js';
import { MODULES } from './prompts.js';
import { clampSharedMemoryForPipeline } from './sanitizeSharedMemory.js';
import { buildPipelineUserInput } from './pipelineInputCompose.js';
import {
  resolveDefaultLlmTimeoutMs,
  resolveDefaultLocalMaxTokens,
  resolveLocalLlmStallTimeoutMs,
  resolveLocalLlmSoftTimeoutMs,
  localLlmLowSpec,
  localLlmContextBudgetChars,
} from './llmEnv.js';
import {
  applyContextBudgetToCallOptions,
  healthContextBudgetFields,
  parseLlmJsonText,
  truncateUserContentToContext,
} from './llmContextBudget.js';
import { getEmbeddings, embeddingCacheStats } from './embeddingService.js';
import { recalibrateThresholds } from './calibration.js';
import { getAllThresholds } from './thresholdStore.js';
import { buildAttachmentBlockWithGlmOcr } from './glmOcrInference.js';
import { mountMindSnapshotSync } from './mindSnapshotSync.js';

const app = express();

const MIND_SNAPSHOT_DATA_DIR = String(process.env.MIND_SNAPSHOT_DATA_DIR || '').trim()
  ? path.resolve(String(process.env.MIND_SNAPSHOT_DATA_DIR).trim())
  : path.join(__dirname, '..', '.data');
const MIND_SNAPSHOT_SYNC_TOKEN = String(process.env.MIND_SNAPSHOT_SYNC_TOKEN || '').trim();

/** Browsers send `Origin` when the UI and API are different sites (e.g. direct :8787 calls). Vite’s same-port proxy often omits cross-origin checks. */
function parseExtraCorsOrigins() {
  const raw = String(process.env.CORS_ORIGINS || '').trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function defaultCorsOrigins() {
  const ports = [5174, 3000];
  const origins = [];
  for (const p of ports) {
    origins.push(
      `http://localhost:${p}`,
      `http://127.0.0.1:${p}`,
      `http://[::1]:${p}`
    );
  }
  origins.push('http://localhost:3001', 'http://127.0.0.1:3001', 'http://[::1]:3001');
  return origins;
}

const corsAllowedOrigins = new Set([...defaultCorsOrigins(), ...parseExtraCorsOrigins()]);

const CORS_DEV_PORTS = new Set(['5174', '3000', '3001']);

/** Allow typical single-user dev UIs: localhost, Tailscale 100.x, LAN private IPs, *.ts.net — only on Vite/preview ports. */
function isLikelyLocalBrainUiOrigin(origin) {
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  const scheme = u.protocol;
  if (scheme !== 'http:' && scheme !== 'https:') return false;
  const port = u.port || (scheme === 'https:' ? '443' : '80');
  if (!CORS_DEV_PORTS.has(port)) return false;

  const host = u.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.endsWith('.ts.net')) return true;
  if (/^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (corsAllowedOrigins.has(origin)) return callback(null, true);
      if (isLikelyLocalBrainUiOrigin(origin)) return callback(null, true);
      console.warn('[cors] blocked origin:', origin);
      return callback(null, false);
    },
  })
);
// Pipeline continuations POST the full sharedMemory snapshot; default 2mb is too small.
// Mind snapshot PUT sends raw octet-stream (often 50–300MB+). If `express.json` runs first, some
// stacks mis-handle the body and the 32mb JSON cap yields HTTP 413 — so skip JSON parsing for that route.
const jsonParser = express.json({ limit: '32mb' });
app.use((req, res, next) => {
  if (req.method === 'PUT' && req.path === '/api/mind-snapshot') return next();
  return jsonParser(req, res, next);
});

mountMindSnapshotSync(app, { dataDir: MIND_SNAPSHOT_DATA_DIR, syncToken: MIND_SNAPSHOT_SYNC_TOKEN });

const ATTACHMENT_MAX_FILES = 24;
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024,
    files: ATTACHMENT_MAX_FILES,
  },
});

function inferAttachmentKind(mimetype) {
  const m = String(mimetype || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  return 'file';
}

function attachmentMulterErrorHandler(err, res) {
  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({
      error:
        'One or more files exceed the 12MB server limit. Use smaller files or fewer attachments per request.',
    });
    return true;
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    res
      .status(400)
      .json({ error: `Too many files (maximum ${ATTACHMENT_MAX_FILES} per request).` });
    return true;
  }
  if (err.code === 'LIMIT_PART_COUNT' || err.code === 'LIMIT_FIELD_KEY') {
    res.status(400).json({ error: 'Upload request was rejected (size or form limits).' });
    return true;
  }
  return false;
}

function attachmentUploadStack(fieldName) {
  return [
    (req, res, next) => {
      attachmentUpload.array(fieldName, ATTACHMENT_MAX_FILES)(req, res, (err) => {
        if (!err) return next();
        if (attachmentMulterErrorHandler(err, res)) return;
        console.error('Upload multipart error:', err);
        res.status(400).json({ error: err.message || 'Upload failed.' });
      });
    },
    async (req, res) => {
      try {
        const files = req.files || [];
        if (!files.length) {
          res.status(400).json({
            error: `No files uploaded. Use multipart form field "${fieldName}".`,
          });
          return;
        }

        const attachments = [];

        for (const f of files) {
          const id = crypto.randomUUID();

          const record = storeAttachment({
            id,
            kind: inferAttachmentKind(f.mimetype),
            filename: f.originalname,
            mimeType: f.mimetype || 'application/octet-stream',
            size: f.size,
            uploadedAt: nowIso(),
            caption: null,
            captionProvider: null,
            buffer: Buffer.isBuffer(f.buffer) ? Buffer.from(f.buffer) : null,
          });

          attachments.push(record);
        }

        res.json({ attachments });
      } catch (err) {
        console.error('Upload failed:', err);
        res.status(500).json({ error: err?.message || 'Upload failed' });
      }
    },
  ];
}

const attachmentStore = new Map();
const ATTACHMENT_TTL_MS = 30 * 60 * 1000;

function storeAttachment(record) {
  attachmentStore.set(record.id, record);
  setTimeout(() => attachmentStore.delete(record.id), ATTACHMENT_TTL_MS).unref?.();
  return record;
}

function requiredEnv(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

/** LM Studio server auth: `Authorization: Bearer <token>` (see LM_API_TOKEN in .env). */
function resolveLmBearerToken() {
  return requiredEnv('LM_API_TOKEN') || requiredEnv('LOCAL_LLM_API_KEY') || 'lm-studio';
}

/** Ollama / LM Studio / llama.cpp server expect OpenAI-compatible base ending in `/v1`. */
function normalizeOpenAiCompatBase(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return u;
  if (/\/v1$/i.test(u)) return u;
  return `${u}/v1`;
}

/**
 * Node often resolves `localhost` to ::1 while many local LLM servers bind IPv4 only (127.0.0.1).
 * Coerce loopback names so LOCAL_LLM_BASE_URL=http://localhost:1234 still connects reliably.
 */
function coerceLoopbackToIpv4(url) {
  const s = String(url || '').trim();
  if (!s) return s;
  try {
    const u = new URL(s);
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '::1') {
      u.hostname = '127.0.0.1';
      return u.toString().replace(/\/+$/, '');
    }
  } catch {
    /* leave unchanged if not a full URL */
  }
  return s.replace(/\/+$/, '');
}

function parseLocalModelList(raw) {
  if (!raw || !raw.trim()) return ['llama3.2', 'llama3.1:8b'];
  const parts = raw.split(/[,]+/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : ['llama3.2'];
}

function resolveHuggingfaceToken() {
  return requiredEnv('HF_TOKEN') || requiredEnv('HUGGINGFACE_API_TOKEN');
}

const DEFAULT_HF_INFERENCE_BASE = 'https://router.huggingface.co';
/**
 * Default HF Inference router models (OpenAI-compatible /v1/chat/completions).
 * Primary: Venice Dolphin 24B via Featherless; fallback: Neural Daredevil 8B.
 * Override with HF_INFERENCE_MODELS in .env (comma-separated fallbacks allowed).
 */
const DEFAULT_HF_MODEL =
  'dphn/Dolphin-Mistral-24B-Venice-Edition:featherless-ai,mlabonne/NeuralDaredevil-8B-abliterated:featherless-ai';

const DEFAULT_OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
/**
 * dolphin3.0-r1-mistral-24b is not in OpenRouter’s public model catalog (404). Venice Dolphin 24B :free exists;
 * Mistral Small 24B is a reliable second hop (same 24B family as Dolphin R1’s base).
 */
const DEFAULT_OPENROUTER_MODEL =
  'cognitivecomputations/dolphin-mistral-24b-venice-edition:free,mistralai/mistral-small-24b-instruct-2501';

/** Hugging Face router: fast lane for early bundle / small instruct (OpenAI client model id with :featherless-ai). */
const DEFAULT_LLM_FAST_HF_MODEL = 'meta-llama/Llama-3.1-8B-Instruct:featherless-ai';

/** Comma-separated model ids; `fallbackSingle` may also be comma-separated. */
function parseCommaModelList(raw, fallbackSingle) {
  if (raw && raw.trim()) {
    const parts = raw.split(/[,]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts;
  }
  const fb = String(fallbackSingle || '').trim();
  if (!fb) return [];
  return fb.split(/[,]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * @param {{ openrouterApiKey?: string }} [opts]
 * @returns {Array<{ id: string, getKey: () => string, type: string, baseURL: string, models: string[], extraHeaders?: Record<string, string> }>}
 */
function buildProviderList(opts = {}) {
  const providers = [];
  const clientOpenrouterKey = String(opts.openrouterApiKey || '').trim();

  const hfToken = resolveHuggingfaceToken();
  const hfBaseRaw = requiredEnv('HF_INFERENCE_BASE_URL') || DEFAULT_HF_INFERENCE_BASE;
  const hfModels = parseCommaModelList(requiredEnv('HF_INFERENCE_MODELS'), DEFAULT_HF_MODEL);

  /** @type {typeof providers[0] | null} */
  let hfProvider = null;
  if (hfToken && hfModels.length > 0) {
    const hfBase = String(hfBaseRaw || '').trim().replace(/\/+$/, '');
    hfProvider = {
      id: 'huggingface',
      getKey: () => hfToken,
      type: 'openai_compat',
      baseURL: normalizeOpenAiCompatBase(hfBase),
      models: hfModels,
    };
  }

  const rawLocal = requiredEnv('LOCAL_LLM_BASE_URL') || requiredEnv('OLLAMA_BASE_URL');
  /** @type {typeof providers[0] | null} */
  let localProvider = null;
  if (rawLocal) {
    const localBase = coerceLoopbackToIpv4(rawLocal);
    localProvider = {
      id: 'local',
      getKey: () => resolveLmBearerToken(),
      type: 'openai_compat',
      baseURL: normalizeOpenAiCompatBase(localBase),
      models: parseLocalModelList(requiredEnv('LOCAL_LLM_MODELS')),
    };
  }

  const envOpenrouterKey = requiredEnv('OPENROUTER_API_KEY');
  const openrouterEffectiveKey = envOpenrouterKey || clientOpenrouterKey;
  /** @type {typeof providers[0] | null} */
  let openrouterProvider = null;
  if (openrouterEffectiveKey) {
    const orBaseRaw = requiredEnv('OPENROUTER_BASE_URL') || DEFAULT_OPENROUTER_BASE;
    const orBase = String(orBaseRaw || '').trim().replace(/\/+$/, '');
    const orModels = parseCommaModelList(requiredEnv('OPENROUTER_MODELS'), DEFAULT_OPENROUTER_MODEL);
    const ref = requiredEnv('OPENROUTER_HTTP_REFERER');
    const titleRaw = requiredEnv('OPENROUTER_APP_TITLE');
    const extraHeaders = {};
    if (ref) extraHeaders['HTTP-Referer'] = ref;
    if (ref || titleRaw) extraHeaders['X-Title'] = titleRaw || 'MetaSelf-CognitiveStack';
    openrouterProvider = {
      id: 'openrouter',
      getKey: () => envOpenrouterKey || clientOpenrouterKey,
      type: 'openai_compat',
      baseURL: normalizeOpenAiCompatBase(orBase),
      models: orModels.length ? orModels : parseCommaModelList(null, DEFAULT_OPENROUTER_MODEL),
      ...(Object.keys(extraHeaders).length ? { extraHeaders } : {}),
    };
  }

  const localFirst = /^1|true|yes$/i.test(String(process.env.LLM_LOCAL_FIRST || '').trim());
  const hfFirst = /^1|true|yes$/i.test(String(process.env.LLM_HF_FIRST || '').trim());
  const cloudFirst = hfFirst && !localFirst;

  const ordered = cloudFirst
    ? [hfProvider, openrouterProvider, localProvider]
    : [localProvider, openrouterProvider, hfProvider];

  for (const p of ordered) {
    if (p) providers.push(p);
  }

  if (providers.length === 0) {
    console.error(
      '[LLM] No providers: set HF_TOKEN + HF_INFERENCE_MODELS (Hugging Face router; use model:featherless-ai for Featherless), OPENROUTER_API_KEY and/or OpenRouter key in app Settings, and/or LOCAL_LLM_BASE_URL + LOCAL_LLM_MODELS.'
    );
    return [];
  }

  return providers;
}

/**
 * Fast LLM path: Hugging Face router only, models from `LLM_FAST_HF_MODEL` (comma-separated) or
 * default {@link DEFAULT_LLM_FAST_HF_MODEL}.
 * @returns {ReturnType<typeof buildProviderList>|null}
 */
function buildFastHfProviderOnly() {
  const hfToken = resolveHuggingfaceToken();
  if (!hfToken) return null;
  const hfBaseRaw = requiredEnv('HF_INFERENCE_BASE_URL') || DEFAULT_HF_INFERENCE_BASE;
  const hfBase = String(hfBaseRaw || '').trim().replace(/\/+$/, '');
  const models = parseCommaModelList(requiredEnv('LLM_FAST_HF_MODEL'), DEFAULT_LLM_FAST_HF_MODEL);
  if (!models.length) return null;
  return [
    {
      id: 'huggingface',
      getKey: () => hfToken,
      type: 'openai_compat',
      baseURL: normalizeOpenAiCompatBase(hfBase),
      models,
    },
  ];
}

/**
 * @param {string} providerId
 * @param {string} model
 * @param {{ openrouterApiKey?: string }} [opts]
 */
function buildNarrowedProviderList(providerId, model, opts = {}) {
  const all = buildProviderList(opts);
  const p = all.find((x) => x.id === providerId);
  if (!p) return null;
  return [{ ...p, models: [model] }];
}

function computeBackendProfile(providerIds) {
  if (!providerIds || !providerIds.length) return 'none';
  return providerIds.join('_');
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeError(err) {
  return {
    name: err?.name,
    message: err?.message || String(err),
    status: err?.status,
    code: err?.code,
  };
}

function getProviderList() {
  return buildProviderList();
}

function extractOpenrouterApiKeyFromRequest(req) {
  const b = req?.body || {};
  const fromOpts = typeof b.options?.openrouterApiKey === 'string' ? b.options.openrouterApiKey : '';
  const top = typeof b.openrouterApiKey === 'string' ? b.openrouterApiKey : '';
  return String(fromOpts || top || '').trim();
}

function pipelineContinuationMemory(sm, options) {
  return sm
    ? clampSharedMemoryForPipeline(sm, {
        continuation: options?.pipelineMetacognitionContinuation === true,
      })
    : null;
}

/** When the client did not send priorTurnGlobalWorkspace, load last SQLite snapshot for sessionId. */
function hydratePriorWorkspaceFromDb(sharedMemory) {
  if (!sharedMemory || typeof sharedMemory !== 'object') return sharedMemory;
  if (sharedMemory.priorTurnGlobalWorkspace && typeof sharedMemory.priorTurnGlobalWorkspace === 'object') {
    return sharedMemory;
  }
  const sid = sharedMemory.sessionId;
  if (!sid) return sharedMemory;
  try {
    const latest = getLatestWorkspaceSnapshot(sid);
    if (latest?.globalWorkspace) {
      return {
        ...sharedMemory,
        priorTurnGlobalWorkspace: snapshotGlobalWorkspaceForCarryover(latest.globalWorkspace),
      };
    }
  } catch (e) {
    console.warn('[workspaceDb] hydrate skipped:', e?.message || e);
  }
  return sharedMemory;
}

/**
 * When the client reconnects without options.executionResume / rerun counts, merge the last SQLite
 * pipeline_progress snapshot for this session (cooperative pause, continuation, or completed leg).
 */
function applyServerPipelineProgressFromDb(sharedMemory, options) {
  if (!sharedMemory || typeof sharedMemory !== 'object' || !options || typeof options !== 'object') {
    return;
  }
  const sid = sharedMemory.sessionId;
  if (!sid || !getWorkspaceDbStatus().enabled) return;
  try {
    const latest = getLatestWorkspaceSnapshot(String(sid).slice(0, 200));
    const p = latest?.pipelineProgress;
    if (!p || typeof p !== 'object') return;
    if (!options.executionResume && p.executionCursor) {
      const n = normalizeExecutionResume(p.executionCursor);
      if (n) options.executionResume = n;
    }
    if (p.metacognitionRerunsUsed != null && sharedMemory.metacognitionRerunsUsed == null) {
      sharedMemory.metacognitionRerunsUsed = p.metacognitionRerunsUsed;
    }
    if (options.maxMetacognitionReruns == null && p.maxMetacognitionReruns != null) {
      options.maxMetacognitionReruns = p.maxMetacognitionReruns;
    }
    if (p.iterationCount != null && sharedMemory.iterationCount == null) {
      sharedMemory.iterationCount = p.iterationCount;
    }
  } catch (e) {
    console.warn('[workspaceDb] applyServerPipelineProgressFromDb:', e?.message || e);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** After 429 / quota signals, temporarily prefer other providers (next pipeline modules benefit). */
const providerCooldownUntil = new Map();

/** Last successful chat completion (for dashboard / health). */
let lastSuccessfulLlmCall = null;
let activeLlmInvocations = 0;

function getPreferredFirstHop() {
  for (const p of getProviderList()) {
    if (!p.getKey?.()) continue;
    const m = p.models?.[0];
    if (m) return { provider: p.id, model: m };
  }
  return null;
}

function extractHttpStatus(err) {
  const s = err?.status ?? err?.response?.status ?? err?.statusCode;
  return typeof s === 'number' && s > 0 ? s : null;
}

function errorBlob(err) {
  return `${err?.message ?? ''} ${err?.error?.message ?? ''} ${typeof err?.error === 'object' ? JSON.stringify(err.error) : ''} ${err?.code ?? ''}`.toLowerCase();
}

function readRetryAfterMs(err) {
  const h = err?.headers;
  if (!h) return null;
  const v = h['retry-after'] ?? h['Retry-After'];
  if (v == null) return null;
  const sec = Number(v);
  if (Number.isFinite(sec)) return Math.min(120_000, Math.max(1000, sec * 1000));
  const when = Date.parse(String(v));
  if (!Number.isNaN(when)) return Math.min(120_000, Math.max(0, when - Date.now()));
  return null;
}

function isContextLengthError(err) {
  const t = errorBlob(err);
  if (t.includes('context_length') || t.includes('maximum context') || t.includes('too many tokens')) return true;
  if (t.includes('n_keep') && t.includes('n_ctx')) return true;
  if (t.includes('context length') && (t.includes('token') || t.includes('exceed') || t.includes('greater'))) return true;
  if (t.includes('token') && (t.includes('exceed') || t.includes('limit') || t.includes('long'))) return true;
  const st = extractHttpStatus(err);
  if (st === 400 && (t.includes('context') || t.includes('token') || t.includes('length'))) return true;
  return false;
}

/** True if any normalized failure looks like llama.cpp / LM Studio prompt larger than n_ctx. */
function failuresSuggestNctxMismatch(failures) {
  if (!Array.isArray(failures) || !failures.length) return false;
  const b = failures
    .map((f) => String(f?.error?.message ?? f?.error ?? ''))
    .join(' ')
    .toLowerCase();
  if (b.includes('n_keep') && b.includes('n_ctx')) return true;
  if (b.includes('tokens to keep') && b.includes('n_ctx')) return true;
  return false;
}

function isModelNotFoundError(err) {
  const st = extractHttpStatus(err);
  if (st === 404) return true;
  const t = errorBlob(err);
  return t.includes('model_not_found') || t.includes('does not exist') || t.includes('invalid model');
}

function shouldRestProviderAfterError(status, err) {
  if (status === 429 || status === 402) return true;
  if (status === 401 || status === 403) return true;
  const t = errorBlob(err);
  if (t.includes('rate_limit') || t.includes('rate limit')) return true;
  if (t.includes('quota') || t.includes('billing') || t.includes('exceeded your current quota')) return true;
  return false;
}

function cooldownMsForProvider(status, err) {
  const ra = readRetryAfterMs(err);
  if (ra) return ra;
  if (status === 429) return 25_000 + Math.floor(Math.random() * 15_000);
  /* Depleted credits / billing: avoid a failed HF hop on every pipeline module for a while. */
  if (status === 402) return 600_000;
  if (status === 401 || status === 403) return 180_000;
  const t = errorBlob(err);
  if (t.includes('quota') || t.includes('billing')) return 90_000;
  return 15_000;
}

function providersAvailableNow(providers) {
  const now = Date.now();
  const ready = providers.filter((p) => {
    const until = providerCooldownUntil.get(p.id);
    return !until || now >= until;
  });
  return ready.length > 0 ? ready : [...providers];
}

function backoffAfterFailureMs(status, err, options) {
  if (typeof options?.providerBackoffMs === 'number') {
    if (status === 429) return Math.max(options.providerBackoffMs, 2000);
    return options.providerBackoffMs;
  }
  if (status === 429) return 2500 + Math.floor(Math.random() * 800);
  if (status === 408 || status === 502 || status === 503 || status === 504) return 1200;
  if (!status && String(err?.message || '').includes('Timeout')) return 800;
  return 400;
}

const SOFT_TIMEOUT_OUTPUT_SUFFIX =
  '\n\n[Stopped at time budget; output may be incomplete.]';

/**
 * Local LLM: use streaming so we can fail fast if the server stops sending chunks (hang / bad model id).
 * Optional soft deadline (resolveLocalLlmSoftTimeoutMs): return partial text and continue the pipeline.
 */
async function callOpenAICompatStreamingWithStall({
  apiKey,
  baseURL,
  model,
  systemPrompt,
  userContent,
  options,
  httpTimeoutMs,
  stallMs,
  extraHeaders,
}) {
  const token = apiKey || resolveLmBearerToken();
  const cap = httpTimeoutMs ?? resolveDefaultLlmTimeoutMs();
  const sdkTimeout = Math.min(7_200_000, Math.max(60_000, cap + 15_000));
  const client = new OpenAI({
    apiKey: token,
    baseURL,
    defaultHeaders: { Authorization: `Bearer ${token}`, ...(extraHeaders || {}) },
    timeout: sdkTimeout,
  });
  const ac = new AbortController();

  const softCap = options?.disableSoftTimeout ? 0 : resolveLocalLlmSoftTimeoutMs(cap);
  let softDeadlineHit = false;
  let softTimer = null;
  if (softCap > 0 && softCap < cap) {
    softTimer = setTimeout(() => {
      softDeadlineHit = true;
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
    }, softCap);
  }

  const stream = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt || '' },
      { role: 'user', content: userContent || '' },
    ],
    temperature: options?.temperature ?? 0.6,
    max_tokens: options?.max_tokens ?? resolveDefaultLocalMaxTokens(),
    top_p: options?.top_p ?? 0.9,
    stream: true,
    signal: ac.signal,
  });

  let out = '';
  let lastActivity = Date.now();
  let stalledByWatchdog = false;
  let hardTimeout = false;

  const stallInterval = setInterval(() => {
    if (Date.now() - lastActivity < stallMs) return;
    stalledByWatchdog = true;
    clearInterval(stallInterval);
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
  }, Math.min(1_000, Math.max(250, Math.floor(stallMs / 5))));

  const overallTimer = setTimeout(() => {
    hardTimeout = true;
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
  }, cap);

  try {
    for await (const part of stream) {
      lastActivity = Date.now();
      const t = part.choices?.[0]?.delta?.content ?? '';
      if (t) out += t;
    }
    return { text: out, partialDueToSoftTimeout: false };
  } catch (err) {
    if (softDeadlineHit && out.length > 0 && !hardTimeout && !stalledByWatchdog) {
      return { text: `${out}${SOFT_TIMEOUT_OUTPUT_SUFFIX}`, partialDueToSoftTimeout: true };
    }
    if (softDeadlineHit && out.length === 0 && !hardTimeout && !stalledByWatchdog) {
      throw new Error(
        `Soft time budget expired after ${softCap}ms with no tokens. Are LOCAL_LLM_BASE_URL and the loaded model available?`
      );
    }
    if (hardTimeout) {
      throw new Error(`Timeout after ${cap}ms`);
    }
    if (stalledByWatchdog) {
      throw new Error(
        `Local LLM stalled: no stream data for ${stallMs}ms. Confirm LOCAL_LLM_BASE_URL, the server is running, the model is loaded, and LOCAL_LLM_MODELS matches the server's id (see ${baseURL.replace(/\/v1\/?$/i, '')}/v1/models). Raise LOCAL_LLM_STALL_MS if your machine is very slow between tokens.`
      );
    }
    throw err;
  } finally {
    if (softTimer) clearTimeout(softTimer);
    clearInterval(stallInterval);
    clearTimeout(overallTimer);
  }
}

async function callOpenAICompat({
  apiKey,
  baseURL,
  model,
  systemPrompt,
  userContent,
  options,
  httpTimeoutMs,
  providerId,
  extraHeaders,
}) {
  /**
   * Streaming stall watchdog aborts if no chunk arrives for LOCAL_LLM_STALL_MS (default 120s).
   * Map/ingest prompts often have long time-to-first-token; that is not a hung server — use
   * disableStallWatchdog on those calls (falls back to non-streaming local path, still bounded by LOCAL_LLM_TIMEOUT_MS).
   */
  const stallMs =
    providerId === 'local' && !options?.disableStallWatchdog ? resolveLocalLlmStallTimeoutMs() : 0;
  if (stallMs > 0) {
    return callOpenAICompatStreamingWithStall({
      apiKey,
      baseURL,
      model,
      systemPrompt,
      userContent,
      options,
      httpTimeoutMs,
      stallMs,
      extraHeaders,
    });
  }

  const token = apiKey || resolveLmBearerToken();
  const sdkTimeout = Math.min(
    7_200_000,
    Math.max(60_000, (httpTimeoutMs ?? resolveDefaultLlmTimeoutMs()) + 15_000)
  );
  const client = new OpenAI({
    apiKey: token,
    baseURL,
    defaultHeaders: { Authorization: `Bearer ${token}`, ...(extraHeaders || {}) },
    timeout: sdkTimeout,
  });
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt || '' },
      { role: 'user', content: userContent || '' },
    ],
    temperature: options?.temperature ?? 0.6,
    max_tokens: options?.max_tokens ?? resolveDefaultLocalMaxTokens(),
    top_p: options?.top_p ?? 0.9,
  });
  const text = completion.choices?.[0]?.message?.content ?? '';
  return { text, partialDueToSoftTimeout: false };
}

/**
 * Stream chat completion (OpenAI-compatible). Writes SSE lines: data: {"text":"..."} or data: {"error":"..."}
 */
async function streamOpenAICompatChat({ apiKey, baseURL, model, systemPrompt, userContent, options, res, extraHeaders }) {
  const token = apiKey || resolveLmBearerToken();
  const sdkTimeout = Math.min(
    7_200_000,
    Math.max(60_000, resolveDefaultLlmTimeoutMs() + 15_000)
  );
  const client = new OpenAI({
    apiKey: token,
    baseURL,
    defaultHeaders: { Authorization: `Bearer ${token}`, ...(extraHeaders || {}) },
    timeout: sdkTimeout,
  });
  const stream = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt || '' },
      { role: 'user', content: userContent || '' },
    ],
    temperature: options?.temperature ?? 0.6,
    max_tokens: options?.max_tokens ?? resolveDefaultLocalMaxTokens(),
    top_p: options?.top_p ?? 0.9,
    stream: true,
  });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  try {
    for await (const part of stream) {
      const t = part.choices?.[0]?.delta?.content ?? '';
      if (t) res.write(`data: ${JSON.stringify({ text: t })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err?.message || String(err) })}\n\n`);
  }
  res.end();
}

function stripLlmRoutingFromOptions(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const o = { ...obj };
  delete o.llmRoute;
  delete o.onlyProviderId;
  delete o.onlyModel;
  return o;
}

/**
 * @param {any[]} PROVIDERS
 * @param {object} rest - contains failures (mutated), runWithProvider, tryProviders local state
 */
async function executeCallLLMWithProviderList(
  systemPrompt,
  userContent,
  options,
  budgeted,
  timeoutMs,
  PROVIDERS,
  failures
) {
  if (!PROVIDERS.length) {
    const err = new Error(
      'No LLM configured. Set HF_TOKEN and HF_INFERENCE_MODELS (router; e.g. model:featherless-ai), OPENROUTER_API_KEY and/or OpenRouter key in Settings, and/or LOCAL_LLM_BASE_URL and LOCAL_LLM_MODELS. Restart the backend after editing .env.'
    );
    err.failures = [];
    throw err;
  }

  const runWithProvider = async (provider, model, callOpts) => {
    const apiKey = provider.getKey();
    if (provider.type === 'openai_compat') {
      return callOpenAICompat({
        apiKey,
        baseURL: provider.baseURL,
        model,
        systemPrompt,
        userContent,
        options: callOpts,
        httpTimeoutMs: timeoutMs,
        providerId: provider.id,
        extraHeaders: provider.extraHeaders,
      });
    }
    throw new Error(`Unknown provider type: ${provider.type}`);
  };

  const tryProviders = async (providerList) => {
    for (const provider of providerList) {
      const apiKey = provider.getKey();
      if (!apiKey) {
        failures.push({ provider: provider.id, error: { message: 'Missing API key' } });
        continue;
      }

      let skipRestOfProvider = false;

      for (const model of provider.models) {
        if (skipRestOfProvider) break;

        const attemptTag = `${provider.id}:${model}`;
        const startedAt = Date.now();

        let callOpts = { ...budgeted };
        let contextRetries = 0;
        const maxContextRetries = 2;

        for (;;) {
          let timeoutId;
          try {
            const slow = new Promise((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
            });
            const realWork = runWithProvider(provider, model, callOpts);
            realWork.catch(() => {});
            slow.catch(() => {});
            const raced = await Promise.race([realWork, slow]);
            if (timeoutId) clearTimeout(timeoutId);
            timeoutId = undefined;

            providerCooldownUntil.delete(provider.id);

            const resolved = (raced?.text ?? raced ?? '').toString();
            const partialDueToSoftTimeout = Boolean(raced?.partialDueToSoftTimeout);
            console.log(
              `[callLLM] used ${attemptTag} in ${Date.now() - startedAt}ms` +
                (partialDueToSoftTimeout ? ' (soft timeout partial)' : '')
            );
            lastSuccessfulLlmCall = {
              provider: provider.id,
              model,
              at: new Date().toISOString(),
            };
            return {
              text: resolved,
              provider: provider.id,
              model,
              partialDueToSoftTimeout,
            };
          } catch (err) {
            if (timeoutId) clearTimeout(timeoutId);

            const status = extractHttpStatus(err);

            if (isContextLengthError(err) && contextRetries < maxContextRetries) {
              const cur = callOpts.max_tokens ?? budgeted.max_tokens ?? resolveDefaultLocalMaxTokens();
              callOpts = {
                ...callOpts,
                max_tokens: Math.max(200, Math.floor(cur * 0.42)),
              };
              contextRetries += 1;
              console.warn(
                `[callLLM] context/token limit for ${attemptTag}, retry with max_tokens=${callOpts.max_tokens}`
              );
              await sleep(200);
              continue;
            }

            failures.push({ provider: provider.id, model, error: normalizeError(err) });
            console.warn(`[callLLM] failed ${attemptTag} (${status ?? 'no-status'})`);

            if (shouldRestProviderAfterError(status, err)) {
              const ms = cooldownMsForProvider(status, err);
              providerCooldownUntil.set(provider.id, Date.now() + ms);
              console.warn(`[callLLM] cooling down ${provider.id} for ~${Math.round(ms / 1000)}s`);
              skipRestOfProvider = true;
            } else if (isModelNotFoundError(err)) {
              /* try next model, no provider-wide cooldown */
            }

            const wait = backoffAfterFailureMs(status, err, options);
            if (wait > 0) await sleep(wait);
            break;
          }
        }
      }
    }
    return null;
  };

  const readyProviders = providersAvailableNow(PROVIDERS);
  const result = await tryProviders(readyProviders);
  if (result) return result;

  /* If every ready provider failed with a connection error (unreachable, not rate-limited),
     try cooled-down providers before giving up — a 429-throttled remote API is better than nothing. */
  const triedIds = new Set(readyProviders.map((p) => p.id));
  const cooledDown = PROVIDERS.filter((p) => !triedIds.has(p.id));
  if (cooledDown.length > 0) {
    const allConnectionErrors = failures.every(
      (f) => !f.error?.status && /connect|ECONNREFUSED|ENOTFOUND|network/i.test(f.error?.message ?? '')
    );
    if (allConnectionErrors) {
      console.warn(`[callLLM] all ready providers unreachable — retrying cooled-down: ${cooledDown.map((p) => p.id).join(', ')}`);
      const fallback = await tryProviders(cooledDown);
      if (fallback) return fallback;
    }
  }

  let msg = 'All LLM providers failed.';
  const ids = PROVIDERS.map((p) => p.id);
  if (ids.includes('local') && ids.length === 1) {
    const localP = PROVIDERS.find((p) => p.id === 'local');
    const base = String(localP?.baseURL || '').replace(/\/v1$/i, '');
    msg += ` Local-only mode: ensure the local server is running (e.g. LM Studio at ${base || 'your LOCAL_LLM_BASE_URL'}), the model id matches LOCAL_LLM_MODELS, and LM_API_TOKEN is set if the server requires a Bearer token.`;
  } else if (ids.includes('huggingface') || ids.includes('openrouter')) {
    msg +=
      ' Check HF_TOKEN + HF_INFERENCE_MODELS (model must have an Inference Provider on Hugging Face; try comma-separated fallbacks), OPENROUTER_MODELS ids from https://openrouter.ai/api/v1/models, OPENROUTER_API_KEY or Settings, and LOCAL_LLM_BASE_URL (load a model in LM Studio).';
  }
  if (failuresSuggestNctxMismatch(failures)) {
    msg +=
      ' Local llama.cpp/LM Studio reported prompt/context overflow: set LLM_CONTEXT_TOKENS_MAX to your loaded model n_ctx (e.g. 4096 or slightly lower for slack), or enable LOCAL_LLM_COMPRESS_SHARED_MEMORY, reduce LOCAL_LLM_CONTEXT_BUDGET_CHARS, or reload the model with a larger context window.';
  }
  const error = new Error(msg);
  error.failures = failures;
  throw error;
}

async function executeCallLLM(systemPrompt, userContent, options = {}) {
  const openrouterApiKey = String(options.openrouterApiKey || '').trim();
  const route = String(options.llmRoute || 'default').toLowerCase();
  const onlyPid = String(options.onlyProviderId || '').trim();
  const onlyMod = String(options.onlyModel || '').trim();

  const optionsNoSecret = stripLlmRoutingFromOptions({ ...options });
  delete optionsNoSecret.openrouterApiKey;
  const timeoutMs = optionsNoSecret.timeoutMs ?? resolveDefaultLlmTimeoutMs();
  const budgeted = applyContextBudgetToCallOptions(
    systemPrompt,
    userContent,
    optionsNoSecret,
    resolveDefaultLocalMaxTokens()
  );

  if (onlyPid && onlyMod) {
    const narrowed = buildNarrowedProviderList(onlyPid, onlyMod, { openrouterApiKey });
    if (narrowed?.length) {
      return await executeCallLLMWithProviderList(
        systemPrompt,
        userContent,
        options,
        budgeted,
        timeoutMs,
        narrowed,
        []
      );
    }
  }

  if (route === 'fast') {
    const fastP = buildFastHfProviderOnly();
    if (fastP?.length) {
      try {
        return await executeCallLLMWithProviderList(
          systemPrompt,
          userContent,
          options,
          budgeted,
          timeoutMs,
          fastP,
          []
        );
      } catch (e) {
        if (/^1|true|yes$/i.test(String(process.env.LLM_FAST_FALLBACK_TO_DEFAULT || '').trim())) {
          console.warn('[callLLM] fast route failed — falling back to default providers:', e?.message || e);
          return await executeCallLLMWithProviderList(
            systemPrompt,
            userContent,
            options,
            budgeted,
            timeoutMs,
            buildProviderList({ openrouterApiKey }),
            []
          );
        }
        throw e;
      }
    }
    console.warn('[callLLM] fast route unavailable (no HF token or LLM_FAST_HF_MODEL) — using default list');
  }

  return await executeCallLLMWithProviderList(
    systemPrompt,
    userContent,
    options,
    budgeted,
    timeoutMs,
    buildProviderList({ openrouterApiKey }),
    []
  );
}

export async function callLLM(systemPrompt, userContent, options = {}) {
  activeLlmInvocations += 1;
  try {
    return await executeCallLLM(systemPrompt, userContent, options);
  } finally {
    activeLlmInvocations -= 1;
  }
}

/** Minimal liveness for browser preflight (scheduled tasks, graph one-shot) — no provider enumeration. */
app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, ping: true });
});

app.get('/api/health', (req, res) => {
  const providerList = getProviderList();
  const providerIds = providerList.map((p) => p.id);
  const hasLocalProvider = providerIds.includes('local');
  const hasHfProvider = providerIds.includes('huggingface');
  const hasOpenrouterProvider = providerIds.includes('openrouter');
  const localFirst = /^1|true|yes$/i.test(String(process.env.LLM_LOCAL_FIRST || '').trim());
  const hfFirst = /^1|true|yes$/i.test(String(process.env.LLM_HF_FIRST || '').trim());
  const fastHfProvider = buildFastHfProviderOnly();
  res.json({
    ok: true,
    now: nowIso(),
    pipeline: {
      sseStream: true,
      postSse: ['/api/pipeline/stream', '/api/pipeline/run-stream'],
      webFetch: {
        disabled: /^1|true|yes$/i.test(String(process.env.WEB_FETCH_DISABLED || '').trim()),
        braveSearchConfigured: Boolean(String(process.env.BRAVE_SEARCH_API_KEY || '').trim()),
      },
    },
    configuredProviders: providerList.map((p) => ({
      id: p.id,
      configured: Boolean(p.getKey()),
      models: p.models,
    })),
    huggingfaceInference: {
      configured: hasHfProvider && Boolean(resolveHuggingfaceToken()),
      hint: hasHfProvider
        ? 'Hugging Face Inference router (OpenAI-compatible). Use HF_INFERENCE_MODELS with :featherless-ai (or another provider) to match InferenceClient(provider=…).'
        : 'Set HF_TOKEN and HF_INFERENCE_MODELS for models that list an Inference Provider on their HF card (Dolphin 3.0 R1 24B has none).',
    },
    openrouterInference: {
      configured: hasOpenrouterProvider,
      hint: hasOpenrouterProvider
        ? 'Middle hop when three tiers exist; order set by LLM_LOCAL_FIRST vs LLM_HF_FIRST (default dev uses HF first; UI on port 5174). Key: OPENROUTER_API_KEY or Settings (sent per request).'
        : 'Set OPENROUTER_API_KEY or save an OpenRouter key in app Settings to include OpenRouter in the provider chain.',
    },
    localInference: {
      configured: hasLocalProvider,
      defaultTimeoutMs: resolveDefaultLlmTimeoutMs(),
      softTimeoutMs: resolveLocalLlmSoftTimeoutMs(resolveDefaultLlmTimeoutMs()) || null,
      softTimeoutHint:
        'LOCAL_LLM_SOFT_BUFFER_MS (default 120000) or LOCAL_LLM_SOFT_TIMEOUT_MS: local streaming returns partial output before hard timeout so the pipeline can continue.',
      stallTimeoutMs: resolveLocalLlmStallTimeoutMs(),
      lowSpecMode: localLlmLowSpec(),
      contextBudgetChars: localLlmContextBudgetChars(),
      /** Hint only — no secrets */
      hint: hasLocalProvider
        ? 'Fallback/local OpenAI-compatible API (LM Studio / Ollama). Ensure the server is running and LOCAL_LLM_MODELS matches the loaded model id. Use LM Studio port (e.g. 1234), not the Vite dev port (5174 for npm run dev; 3000 for dev:local).'
        : 'Optional fallback: set LOCAL_LLM_BASE_URL (e.g. http://127.0.0.1:1234) and LOCAL_LLM_MODELS.',
    },
    llm: {
      lastCall: lastSuccessfulLlmCall,
      inFlight: activeLlmInvocations,
      tryFirst: getPreferredFirstHop(),
      backendProfile: computeBackendProfile(providerIds),
      providerIds,
      localFirst,
      hfFirst,
      fastRoute: {
        /** Same base as `HF_INFERENCE_BASE_URL`; `llmRoute: "fast"` uses only this tier + `LLM_FAST_HF_MODEL`. */
        defaultModel: DEFAULT_LLM_FAST_HF_MODEL,
        effectiveModels: fastHfProvider?.[0]?.models ?? [],
        configured: Boolean(fastHfProvider?.length),
        fallbackToDefaultOnFailure: /^1|true|yes$/i.test(String(process.env.LLM_FAST_FALLBACK_TO_DEFAULT || '').trim()),
      },
      ...healthContextBudgetFields(),
    },
    workspaceDb: getWorkspaceDbStatus(),
    embeddingService: embeddingCacheStats(),
  });
});

app.post('/api/uploads/attachments', ...attachmentUploadStack('attachments'));
/** @deprecated Prefer POST /api/uploads/attachments with field "attachments". */
app.post('/api/uploads/images', ...attachmentUploadStack('images'));

app.post('/api/llm/text', async (req, res) => {
  try {
    const {
      prompt,
      systemPrompt = '',
      temperature = 0.7,
      max_tokens = resolveDefaultLocalMaxTokens(),
      top_p = 0.9,
      timeoutMs,
      llmRoute,
      onlyProviderId,
      onlyModel,
    } = req.body || {};

    if (!prompt || !String(prompt).trim()) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    const promptClamped = truncateUserContentToContext(
      String(systemPrompt || ''),
      String(prompt),
      max_tokens,
      resolveDefaultLocalMaxTokens()
    );

    const orKey = extractOpenrouterApiKeyFromRequest(req);
    const result = await callLLM(String(systemPrompt || ''), promptClamped, {
      temperature,
      max_tokens,
      top_p,
      timeoutMs,
      providerBackoffMs: 400,
      ...(orKey ? { openrouterApiKey: orKey } : {}),
      ...(llmRoute != null && String(llmRoute).trim() ? { llmRoute: String(llmRoute).trim() } : {}),
      ...(onlyProviderId != null && String(onlyProviderId).trim() ? { onlyProviderId: String(onlyProviderId).trim() } : {}),
      ...(onlyModel != null && String(onlyModel).trim() ? { onlyModel: String(onlyModel).trim() } : {}),
    });

    res.json({ text: result.text, provider: result.provider, model: result.model });
  } catch (err) {
    console.error('LLM text failed:', err);
    res.status(500).json({ error: err?.message || 'LLM text failed', details: err?.failures });
  }
});

app.post('/api/llm/text-stream', async (req, res) => {
  try {
    const {
      prompt,
      systemPrompt = '',
      temperature = 0.7,
      max_tokens = resolveDefaultLocalMaxTokens(),
      top_p = 0.9,
    } = req.body || {};

    if (!prompt || !String(prompt).trim()) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    const promptClamped = truncateUserContentToContext(
      String(systemPrompt || ''),
      String(prompt),
      max_tokens,
      resolveDefaultLocalMaxTokens()
    );

    const options = { temperature, max_tokens, top_p, providerBackoffMs: 400 };
    const failures = [];
    const orKey = extractOpenrouterApiKeyFromRequest(req);
    const PROVIDERS = providersAvailableNow(buildProviderList({ openrouterApiKey: orKey }));

    for (const provider of PROVIDERS) {
      const apiKey = provider.getKey();
      if (!apiKey) continue;
      if (provider.type !== 'openai_compat') continue;

      for (const model of provider.models) {
        try {
          await streamOpenAICompatChat({
            apiKey,
            baseURL: provider.baseURL,
            model,
            systemPrompt: String(systemPrompt || ''),
            userContent: promptClamped,
            options,
            res,
            extraHeaders: provider.extraHeaders,
          });
          return;
        } catch (err) {
          failures.push({ provider: provider.id, model, error: normalizeError(err) });
          console.warn(`[text-stream] failed ${provider.id}/${model}`, err?.message || err);
          if (res.headersSent) return;
        }
      }
    }

    if (!res.headersSent) {
      const err = new Error('All LLM providers failed for streaming.');
      err.failures = failures;
      res.status(500).json({ error: err.message, details: failures });
    }
  } catch (err) {
    console.error('LLM text-stream failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || 'LLM text-stream failed' });
    }
  }
});

app.post('/api/llm/json', async (req, res) => {
  try {
    const {
      prompt,
      systemPrompt = '',
      temperature = 0.2,
      max_tokens = resolveDefaultLocalMaxTokens(),
      top_p = 0.9,
    } = req.body || {};
    if (!prompt || !String(prompt).trim()) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    const jsonSystem = [
      systemPrompt || '',
      '',
      'You must respond with ONLY valid JSON. No markdown. No commentary. No code fences.',
    ]
      .join('\n')
      .trim();

    const promptClamped = truncateUserContentToContext(
      jsonSystem,
      String(prompt),
      max_tokens,
      resolveDefaultLocalMaxTokens()
    );

    const orKey = extractOpenrouterApiKeyFromRequest(req);
    const result = await callLLM(jsonSystem, promptClamped, {
      temperature,
      max_tokens,
      top_p,
      providerBackoffMs: 400,
      ...(orKey ? { openrouterApiKey: orKey } : {}),
    });

    const data = parseLlmJsonText(result.text);
    if (data == null || typeof data !== 'object') {
      throw new Error('Model did not return valid JSON.');
    }

    res.json({ data, provider: result.provider, model: result.model });
  } catch (err) {
    console.error('LLM json failed:', err);
    res.status(500).json({ error: err?.message || 'LLM json failed', details: err?.failures });
  }
});

function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function sseSend(res, payload) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch (serErr) {
    console.error('SSE JSON.stringify failed:', serErr);
    body = JSON.stringify({
      type: 'error',
      message: serErr?.message || 'Failed to serialize pipeline event (payload too large or non-JSON-safe).',
      details: { cause: 'serialization' },
    });
  }
  res.write(`data: ${body}\n\n`);
  /* Helps proxies / OS TCP not coalesce huge `module_complete` lines with the next event. */
  if (typeof res.flush === 'function') res.flush();
}

function pipelineStreamGetHint(_req, res) {
  res.status(405).set('Allow', 'POST').json({
    error: 'Use POST',
    hint: 'SSE pipeline: POST JSON { input, sharedMemory?, options?, attachmentIds?, pauseToken?, pauseSupport? } to /api/pipeline/stream or /api/pipeline/run-stream.',
  });
}

app.get('/api/pipeline/module-defaults', (_req, res) => {
  try {
    res.json({
      modules: MODULES.map(({ name, systemPrompt }) => ({ name, systemPrompt })),
    });
  } catch (err) {
    console.error('module-defaults failed:', err);
    res.status(500).json({ error: err?.message || 'Failed to load module defaults' });
  }
});

app.get('/api/pipeline/run-stream', pipelineStreamGetHint);
app.get('/api/pipeline/stream', pipelineStreamGetHint);

/** Cooperative pause: client POST { pauseToken } while a matching stream POST includes the same options.pauseToken (pauseSupport may be omitted; send pauseSupport false to disable). */
app.post('/api/pipeline/pause-request', (req, res) => {
  try {
    const token = String(req.body?.pauseToken || '').trim();
    if (!token) {
      res.status(400).json({ error: 'pauseToken is required' });
      return;
    }
    requestPipelinePause(token);
    res.json({ ok: true });
  } catch (err) {
    console.error('pause-request failed:', err);
    res.status(500).json({ error: err?.message || 'pause-request failed' });
  }
});

/** Same as multiple single-token pause-requests in one round-trip (avoids browser per-host connection limits with many SSE streams). */
const MAX_BULK_PAUSE_TOKENS = 64;
app.post('/api/pipeline/pause-request-bulk', (req, res) => {
  try {
    const raw = req.body?.pauseTokens;
    if (!Array.isArray(raw)) {
      res.status(400).json({ error: 'pauseTokens array is required' });
      return;
    }
    if (raw.length > MAX_BULK_PAUSE_TOKENS) {
      res.status(400).json({ error: `pauseTokens: at most ${MAX_BULK_PAUSE_TOKENS} entries` });
      return;
    }
    const seen = new Set();
    for (const x of raw) {
      const t = String(x || '').trim();
      if (t) seen.add(t);
    }
    for (const t of seen) {
      requestPipelinePause(t);
    }
    const n = seen.size;
    res.json({
      ok: true,
      tokenCount: n,
      okCount: n,
      failCount: 0,
      errors: [],
    });
  } catch (err) {
    console.error('pause-request-bulk failed:', err);
    res.status(500).json({ error: err?.message || 'pause-request-bulk failed' });
  }
});

async function postPipelineSseStream(req, res) {
  let streamStarted = false;
  try {
    const body = req.body || {};
    const {
      input,
      sharedMemory,
      options: rawOptions,
      attachmentIds,
      pauseToken: pauseTokenBody,
      pauseSupport: pauseSupportBody,
    } = body;
    const options = { ...(rawOptions && typeof rawOptions === 'object' ? rawOptions : {}) };
    if (pauseTokenBody != null && String(pauseTokenBody).trim()) {
      options.pauseToken = String(pauseTokenBody).trim();
    }
    if (pauseSupportBody !== undefined) {
      options.pauseSupport = pauseSupportBody;
    }
    const inputText = String(input || '');
    const ids = Array.isArray(attachmentIds) ? attachmentIds : [];
    const attachments = ids.map((id) => attachmentStore.get(id)).filter(Boolean);
    let safeShared = pipelineContinuationMemory(sharedMemory, options);
    if (safeShared) safeShared = hydratePriorWorkspaceFromDb(safeShared);

    if (!inputText.trim() && attachments.length === 0) {
      res.status(400).json({ error: 'input is required (or provide attachmentIds)' });
      return;
    }

    if (safeShared) applyServerPipelineProgressFromDb(safeShared, options);

    const attachmentBlock = attachments.length ? await buildAttachmentBlockWithGlmOcr(attachments) : '';

    const composedInput = buildPipelineUserInput(inputText, attachmentBlock, options?.recentDialogue);

    sseInit(res);
    streamStarted = true;
    // Do NOT call res.end() on req 'close'. Since Node 16+, IncomingMessage 'close' means the
    // request was fully received (POST body consumed), not that the client dropped the socket.
    // Ending the response there cuts off SSE while runPipeline is still running.

    const orKey = extractOpenrouterApiKeyFromRequest(req);
    const pipelineResult = await runPipeline({
      input: composedInput,
      existingSharedMemory: safeShared,
      callLLM: (sp, uc, o) => executeCallLLM(sp, uc, { ...o, ...(orKey ? { openrouterApiKey: orKey } : {}) }),
      options: options || {},
      onEvent: (evt) => sseSend(res, evt),
    });

    if (pipelineResult.pipelinePaused) {
      try {
        insertWorkspaceSnapshot({
          sessionId: pipelineResult.sharedMemory?.sessionId,
          globalWorkspace: pipelineResult.sharedMemory?.globalWorkspace,
          rerunsUsed: pipelineResult.rerunsUsed,
          voiceOutput: '',
          pipelineProgress: buildPipelineProgressRecord({
            sharedMemory: pipelineResult.sharedMemory,
            rerunsUsed: pipelineResult.rerunsUsed,
            executionCursor: pipelineResult.executionCursor,
            maxMetacognitionReruns: options.maxMetacognitionReruns,
            pipelinePaused: true,
            continuationRequired: false,
          }),
        });
      } catch (e) {
        console.warn('[workspaceDb] insertWorkspaceSnapshot:', e?.message || e);
      }
      sseSend(res, { type: 'attachments', attachments });
      res.end();
      return;
    }

    if (pipelineResult.continuationRequired) {
      try {
        insertWorkspaceSnapshot({
          sessionId: pipelineResult.sharedMemory?.sessionId,
          globalWorkspace: pipelineResult.sharedMemory?.globalWorkspace,
          rerunsUsed: pipelineResult.rerunsUsed,
          voiceOutput: '',
          pipelineProgress: buildPipelineProgressRecord({
            sharedMemory: pipelineResult.sharedMemory,
            rerunsUsed: pipelineResult.rerunsUsed,
            executionCursor: null,
            maxMetacognitionReruns: options.maxMetacognitionReruns,
            pipelinePaused: false,
            continuationRequired: true,
          }),
        });
      } catch (e) {
        console.warn('[workspaceDb] insertWorkspaceSnapshot:', e?.message || e);
      }
      sseSend(res, {
        type: 'pipeline_continuation',
        sharedMemory: slimSharedMemoryForSse(pipelineResult.sharedMemory),
        rerunsUsed: pipelineResult.rerunsUsed,
        reason: pipelineResult.continuationReason,
        supervisor: pipelineResult.continuationSupervisor,
      });
      res.end();
      return;
    }

    try {
      insertWorkspaceSnapshot({
        sessionId: pipelineResult.sharedMemory?.sessionId,
        globalWorkspace: pipelineResult.sharedMemory?.globalWorkspace,
        rerunsUsed: pipelineResult.rerunsUsed,
        voiceOutput: pipelineResult.voiceOutput,
        pipelineProgress: buildPipelineProgressRecord({
          sharedMemory: pipelineResult.sharedMemory,
          rerunsUsed: pipelineResult.rerunsUsed,
          executionCursor: null,
          maxMetacognitionReruns: options.maxMetacognitionReruns,
          pipelinePaused: false,
          continuationRequired: false,
        }),
      });
    } catch (e) {
      console.warn('[workspaceDb] insertWorkspaceSnapshot:', e?.message || e);
    }

    sseSend(res, { type: 'attachments', attachments });
    res.end();
  } catch (err) {
    console.error('Pipeline stream failed:', err);
    if (streamStarted) {
      try {
        sseSend(res, {
          type: 'error',
          message: err?.message || String(err) || 'Pipeline stream failed',
          details: err?.failures,
        });
      } catch {
        /* response may be closed */
      }
      try {
        res.end();
      } catch {
        /* ignore */
      }
    } else {
      res.status(500).json({ error: err?.message || 'Pipeline stream failed', details: err?.failures });
    }
  }
}

app.post('/api/pipeline/stream', postPipelineSseStream);
app.post('/api/pipeline/run-stream', postPipelineSseStream);

/** Assemble Voice-module CONTEXT_AND_POLICY + SHARED_MEMORY_JSON (e.g. mind biography); no LLM call, no web fetch. */
app.post('/api/mind/voice-context-blocks', (req, res) => {
  try {
    const { sharedMemory: rawSm, options = {} } = req.body || {};
    if (!rawSm || typeof rawSm !== 'object') {
      res.status(400).json({ error: 'sharedMemory is required' });
      return;
    }
    const input = String(rawSm.originalInput ?? '(assembled mind biography context)');
    const sm = createSharedMemory({ existingSharedMemory: rawSm, input });
    mergeMindRuntimeIntoSharedMemory(sm, options);
    refreshInteroceptionAndPolicy(sm);
    const policyBlock = buildMindContextForModule('Voice', sm);
    const sharedMemoryJson = formatSharedMemoryForModule(sm, 'Voice');
    res.json({ policyBlock, sharedMemoryJson });
  } catch (err) {
    console.error('[voice-context-blocks]', err);
    res.status(500).json({ error: err?.message || 'voice-context-blocks failed' });
  }
});

app.post('/api/pipeline/run', async (req, res) => {
  try {
    const { input, sharedMemory, options: rawOpts, attachmentIds } = req.body || {};
    const opts = { ...(rawOpts && typeof rawOpts === 'object' ? rawOpts : {}) };
    const inputText = String(input || '');
    const ids = Array.isArray(attachmentIds) ? attachmentIds : [];
    const attachments = ids
      .map((id) => attachmentStore.get(id))
      .filter(Boolean);

    if (!inputText.trim() && attachments.length === 0) {
      res.status(400).json({ error: 'input is required (or provide attachmentIds)' });
      return;
    }

    const attachmentBlock = attachments.length ? await buildAttachmentBlockWithGlmOcr(attachments) : '';

    let cont = pipelineContinuationMemory(sharedMemory, opts);
    if (cont) cont = hydratePriorWorkspaceFromDb(cont);
    if (cont) applyServerPipelineProgressFromDb(cont, opts);
    const orKeyRun = extractOpenrouterApiKeyFromRequest(req);
    const result = await runPipeline({
      input: buildPipelineUserInput(inputText, attachmentBlock, opts?.recentDialogue),
      existingSharedMemory: cont,
      callLLM: (sp, uc, o) => executeCallLLM(sp, uc, { ...o, ...(orKeyRun ? { openrouterApiKey: orKeyRun } : {}) }),
      options: opts,
    });

    if (result.continuationRequired) {
      try {
        insertWorkspaceSnapshot({
          sessionId: result.sharedMemory?.sessionId,
          globalWorkspace: result.sharedMemory?.globalWorkspace,
          rerunsUsed: result.rerunsUsed,
          voiceOutput: '',
          pipelineProgress: buildPipelineProgressRecord({
            sharedMemory: result.sharedMemory,
            rerunsUsed: result.rerunsUsed,
            executionCursor: null,
            maxMetacognitionReruns: opts.maxMetacognitionReruns,
            pipelinePaused: false,
            continuationRequired: true,
          }),
        });
      } catch (e) {
        console.warn('[workspaceDb] insertWorkspaceSnapshot:', e?.message || e);
      }
      res.json({
        ...result,
        sharedMemory: slimSharedMemoryForSse(result.sharedMemory),
        attachments,
      });
      return;
    }

    if (result.pipelinePaused) {
      try {
        insertWorkspaceSnapshot({
          sessionId: result.sharedMemory?.sessionId,
          globalWorkspace: result.sharedMemory?.globalWorkspace,
          rerunsUsed: result.rerunsUsed,
          voiceOutput: '',
          pipelineProgress: buildPipelineProgressRecord({
            sharedMemory: result.sharedMemory,
            rerunsUsed: result.rerunsUsed,
            executionCursor: result.executionCursor,
            maxMetacognitionReruns: opts.maxMetacognitionReruns,
            pipelinePaused: true,
            continuationRequired: false,
          }),
        });
      } catch (e) {
        console.warn('[workspaceDb] insertWorkspaceSnapshot:', e?.message || e);
      }
      res.json({
        ...result,
        sharedMemory: slimSharedMemoryForSse(result.sharedMemory),
        attachments,
      });
      return;
    }

    try {
      insertWorkspaceSnapshot({
        sessionId: result.sharedMemory?.sessionId,
        globalWorkspace: result.sharedMemory?.globalWorkspace,
        rerunsUsed: result.rerunsUsed,
        voiceOutput: result.voiceOutput,
        pipelineProgress: buildPipelineProgressRecord({
          sharedMemory: result.sharedMemory,
          rerunsUsed: result.rerunsUsed,
          executionCursor: null,
          maxMetacognitionReruns: opts.maxMetacognitionReruns,
          pipelinePaused: false,
          continuationRequired: false,
        }),
      });
    } catch (e) {
      console.warn('[workspaceDb] insertWorkspaceSnapshot:', e?.message || e);
    }

    res.json({ ...result, attachments });
  } catch (err) {
    console.error('Pipeline run failed:', err);
    res.status(500).json({ error: err?.message || 'Pipeline run failed', details: err?.failures });
  }
});

app.get('/api/workspace/latest', (req, res) => {
  try {
    const sessionId = String(req.query.sessionId || '').trim();
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId query parameter is required' });
      return;
    }
    const row = getLatestWorkspaceSnapshot(sessionId);
    if (!row) {
      res.status(404).json({ error: 'no snapshot for this sessionId' });
      return;
    }
    res.json({ snapshot: row });
  } catch (err) {
    console.error('[workspace/latest]', err);
    res.status(500).json({ error: err?.message || 'workspace/latest failed' });
  }
});

app.post('/api/pipeline/module', async (req, res) => {
  try {
    const { moduleName, sharedMemory, options } = req.body || {};
    if (!moduleName) {
      res.status(400).json({ error: 'moduleName is required' });
      return;
    }
    if (!sharedMemory) {
      res.status(400).json({ error: 'sharedMemory is required' });
      return;
    }

    const orKeyMod = extractOpenrouterApiKeyFromRequest(req);
    const result = await runSingleModule({
      moduleName: String(moduleName),
      sharedMemory: clampSharedMemoryForPipeline(sharedMemory, {
        continuation: options?.pipelineMetacognitionContinuation === true,
      }),
      callLLM: (sp, uc, o) => executeCallLLM(sp, uc, { ...o, ...(orKeyMod ? { openrouterApiKey: orKeyMod } : {}) }),
      options: options || {},
    });

    res.json(result);
  } catch (err) {
    console.error('Run module failed:', err);
    res.status(500).json({ error: err?.message || 'Run module failed' });
  }
});

app.post('/api/calibrate', async (_req, res) => {
  try {
    const result = recalibrateThresholds();
    if (!result) {
      res.json({ ok: false, message: 'Not enough telemetry data for calibration (need >= 10 rows)' });
      return;
    }
    res.json({ ok: true, thresholds: result });
  } catch (err) {
    console.error('Calibration failed:', err);
    res.status(500).json({ error: err?.message || 'Calibration failed' });
  }
});

app.get('/api/thresholds', (_req, res) => {
  res.json({ thresholds: getAllThresholds() });
});

app.post('/api/embeddings', async (req, res) => {
  try {
    const { texts } = req.body || {};
    if (!Array.isArray(texts) || !texts.length) {
      res.status(400).json({ error: 'texts[] is required' });
      return;
    }
    const capped = texts.slice(0, 64).map((t) => String(t || '').slice(0, 8000));
    const embeddings = await getEmbeddings(capped);
    if (!embeddings) {
      res.status(503).json({ error: 'Embedding service unavailable (disabled or no provider)' });
      return;
    }
    res.json({ embeddings });
  } catch (err) {
    console.error('Embedding request failed:', err);
    res.status(500).json({ error: err?.message || 'Embedding failed' });
  }
});

const preferredPort = Number(process.env.PORT || 8787);
const HOST = process.env.BIND_HOST || '0.0.0.0';
/** Try consecutive ports when the preferred one is busy (leftover dev servers, stale nodemon, etc.). */
const portAttempts = Math.min(
  64,
  Math.max(2, Number.parseInt(String(process.env.PORT_ATTEMPTS || '24'), 10) || 24)
);

/** Where to write the bound port for Vite’s proxy (`MYBRAIN_DEV_PORT_FILE`: relative to repo root or absolute; default `.dev-backend-port`). */
function resolveDevBackendPortFilePath() {
  const repoRoot = path.join(__dirname, '..');
  const raw = String(process.env.MYBRAIN_DEV_PORT_FILE || '').trim();
  if (!raw) return path.join(repoRoot, '.dev-backend-port');
  if (path.isAbsolute(raw)) return raw;
  return path.join(repoRoot, raw);
}

// ─── Server-Side Scheduler API ─────────────────────────────────────────
app.post('/api/scheduler/enqueue', (req, res) => {
  try {
    const {
      taskType, scheduledAt, inputText, reason, mindStorageProfile,
      scheduledBy, recurrence, recurrenceInterval, recurrenceUnit, recurrenceEndDate,
    } = req.body || {};
    if (!taskType) return res.status(400).json({ error: 'taskType required' });
    const delayMinutes = req.body.delayMinutes;
    const at = scheduledAt || (delayMinutes
      ? new Date(Date.now() + Math.max(1, Number(delayMinutes) || 5) * 60_000).toISOString()
      : new Date().toISOString());
    const id = insertScheduledTask({
      taskType, scheduledAt: at, inputText, reason, mindStorageProfile,
      scheduledBy: scheduledBy || 'client',
      recurrence, recurrenceInterval, recurrenceUnit, recurrenceEndDate,
    });
    if (!id) return res.status(503).json({ error: 'Database not available' });
    res.json({ ok: true, id, scheduledAt: at });
  } catch (e) {
    console.error('[scheduler/enqueue]', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get('/api/scheduler/tasks', (_req, res) => {
  try {
    const status = typeof _req.query.status === 'string' ? _req.query.status : undefined;
    const limit = Math.min(500, Math.max(1, Number(_req.query.limit) || 100));
    const tasks = listScheduledTasks({ status, limit });
    res.json({ ok: true, tasks });
  } catch (e) {
    console.error('[scheduler/tasks]', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post('/api/scheduler/pause', (_req, res) => {
  try {
    setSchedulerPaused(true);
    res.json({ ok: true, paused: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post('/api/scheduler/resume', (_req, res) => {
  try {
    setSchedulerPaused(false);
    res.json({ ok: true, paused: false });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get('/api/scheduler/status', (_req, res) => {
  try {
    res.json({ ok: true, paused: isSchedulerPaused() });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.delete('/api/scheduler/tasks/:id', (req, res) => {
  try {
    const deleted = deleteScheduledTask(req.params.id);
    res.json({ ok: true, deleted });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

function startServer(port, attemptsLeft) {
  const server = http.createServer(app);
  /** Graph pipeline SSE can run a long time; Node defaults are usually 0, but set explicitly for clarity. */
  server.timeout = 0;
  if (typeof server.requestTimeout === 'number') server.requestTimeout = 0;
  if (typeof server.headersTimeout === 'number') server.headersTimeout = 0;

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 1) {
      const strict =
        /^1|true|yes$/i.test(String(process.env.MYBRAIN_DEV_STRICT_BIND || '').trim());
      if (strict) {
        console.error(
          `Port ${port} in use (MYBRAIN_DEV_STRICT_BIND=1 — no automatic port hop). Free the port or change PORT so it matches VITE_API_PROXY.`
        );
        process.exit(1);
        return;
      }
      const next = port + 1;
      console.warn(`Port ${port} in use, trying ${next}…`);
      startServer(next, attemptsLeft - 1);
      return;
    }
    console.error('Server failed to start:', err.message);
    if (err.code === 'EADDRINUSE') {
      console.error(
        'Port is still in use after all fallback attempts. Stop another MetaSelf-CognitiveStack / Node process on this port range, or set PORT to a free port.'
      );
    }
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    const portFile = resolveDevBackendPortFilePath();
    try {
      fs.writeFileSync(portFile, String(port), 'utf8');
    } catch (e) {
      console.warn(`Could not write dev port file (${path.basename(portFile)}):`, e.message);
    }
    const providers = getProviderList();
    console.log(
      `[LLM] Provider order: ${providers.map((p) => `${p.id} @ ${p.baseURL} (models: ${p.models.join(', ')})`).join(' → ') || '(none — check .env)'}`
    );
    if (localLlmLowSpec()) {
      console.log(
        `[LLM] LOCAL_LLM_LOW_SPEC: context budget ${localLlmContextBudgetChars()} chars · default wait ${resolveDefaultLlmTimeoutMs()}ms per LLM call`
      );
    }
    console.log(`MetaSelf-CognitiveStack backend listening on http://127.0.0.1:${port} (bound ${HOST}:${port})`);
    if (port !== preferredPort) {
      console.warn(
        `Note: wanted port ${preferredPort} but it was busy; using ${port}. Vite reads ${path.basename(resolveDevBackendPortFilePath())} (or VITE_API_PROXY) for the proxy.`
      );
    }
    console.log(
      'Pipeline routes: GET /api/pipeline/module-defaults | POST /api/pipeline/run | /api/pipeline/stream (SSE) | /api/pipeline/run-stream (SSE alias) | /api/pipeline/module'
    );
  });
}

initWorkspaceDb();
startServerScheduler((sp, uc, o) => executeCallLLM(sp, uc, o || {}));
startServer(preferredPort, portAttempts);

