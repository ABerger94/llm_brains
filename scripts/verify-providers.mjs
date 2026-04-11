/**
 * Smoke-test local OpenAI-compatible LLM (LM Studio / Ollama / llama.cpp).
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

function firstLocalModel() {
  const raw = requiredEnv('LOCAL_LLM_MODELS');
  if (!raw) return 'llama3.2';
  const parts = raw.split(/[,]+/).map((s) => s.trim()).filter(Boolean);
  return parts[0] || 'llama3.2';
}

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
  const result = await tryLocal();
  if (result === 'skip') {
    console.log('verify-providers: skipped (no local URL in .env)');
    process.exit(0);
  }
  console.log('verify-providers: done');
} catch (e) {
  console.error('[local] failed:', e?.message || e);
  process.exit(1);
}
