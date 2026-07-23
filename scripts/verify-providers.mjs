/**
 * Smoke-test LLM providers: Hugging Face Inference router first (typical `npm run dev` / dev:hf),
 * then optional local OpenAI-compatible (LM Studio / Ollama) when HF is not configured.
 * Usage: node scripts/verify-providers.mjs
 */
import 'dotenv/config';
import OpenAI from 'openai';

function requiredEnv(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

function normalizeOpenAiCompatBase(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return u;
  if (/\/v1$/i.test(u)) return u;
  return `${u}/v1`;
}

const DEFAULT_HF_INFERENCE_BASE = 'https://router.huggingface.co';
const DEFAULT_HF_MODEL =
  'dphn/Dolphin-Mistral-24B-Venice-Edition:featherless-ai,mlabonne/NeuralDaredevil-8B-abliterated:featherless-ai';

function parseCommaModels(raw, fallbackSingle) {
  if (raw && raw.trim()) {
    const parts = raw.split(/[,]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts;
  }
  const fb = String(fallbackSingle || '').trim();
  if (!fb) return [];
  return fb.split(/[,]+/).map((s) => s.trim()).filter(Boolean);
}

function resolveHuggingfaceToken() {
  return requiredEnv('HF_TOKEN') || requiredEnv('HUGGINGFACE_API_TOKEN');
}

async function tryHuggingface() {
  const token = resolveHuggingfaceToken();
  if (!token) throw new Error('HF token missing');

  const baseRaw = requiredEnv('HF_INFERENCE_BASE_URL') || DEFAULT_HF_INFERENCE_BASE;
  const baseURL = normalizeOpenAiCompatBase(baseRaw);
  const models = parseCommaModels(requiredEnv('HF_INFERENCE_MODELS'), DEFAULT_HF_MODEL);
  if (!models.length) throw new Error('No HF models resolved; set HF_INFERENCE_MODELS');

  const model = models[0];
  const client = new OpenAI({ apiKey: token, baseURL });
  const completion = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
    max_tokens: 16,
    temperature: 0,
  });
  const text = completion.choices?.[0]?.message?.content ?? '';
  console.log(`[huggingface] ok (${baseURL}, model ${model}) —`, text.trim().slice(0, 80));
}

function firstLocalModel() {
  const raw = requiredEnv('LOCAL_LLM_MODELS');
  if (!raw) return 'llama3.2';
  const parts = raw.split(/[,]+/).map((s) => s.trim()).filter(Boolean);
  return parts[0] || 'llama3.2';
}

/** @returns {'ok'|'skip'} */
async function tryLocal() {
  const baseRaw = requiredEnv('LOCAL_LLM_BASE_URL') || requiredEnv('OLLAMA_BASE_URL');
  if (!baseRaw) {
    console.log('[local] skip (LOCAL_LLM_BASE_URL and OLLAMA_BASE_URL unset)');
    return 'skip';
  }

  const baseURL = normalizeOpenAiCompatBase(baseRaw);
  const apiKey = requiredEnv('LM_API_TOKEN') || requiredEnv('LOCAL_LLM_API_KEY') || 'lm-studio';
  const model = firstLocalModel();

  const client = new OpenAI({ apiKey, baseURL });
  const completion = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
    max_tokens: 16,
    temperature: 0,
  });
  const text = completion.choices?.[0]?.message?.content ?? '';
  console.log(`[local] ok (${baseURL}, model ${model}) —`, text.trim().slice(0, 80));
  return 'ok';
}

try {
  if (resolveHuggingfaceToken()) {
    await tryHuggingface();
    console.log('verify-providers: ok (Hugging Face)');
    process.exit(0);
  }

  const result = await tryLocal();
  if (result === 'skip') {
    console.log('verify-providers: skipped (set HF_TOKEN or LOCAL_LLM_BASE_URL in .env)');
    process.exit(0);
  }
  console.log('verify-providers: ok (local LLM)');
  process.exit(0);
} catch (e) {
  const tag = resolveHuggingfaceToken() ? '[huggingface]' : '[verify-providers]';
  console.error(tag, e?.message || e);
  process.exit(1);
}
