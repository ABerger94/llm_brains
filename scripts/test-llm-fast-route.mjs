/**
 * Verifies `POST /api/llm/text` with `llmRoute: "fast"` returns a response from
 * `LLM_FAST_HF_MODEL` (default meta-llama/…-8B-Instruct:featherless-ai) on the HF router.
 *
 * Prerequisites: server running, HF_TOKEN, network to router.huggingface.co
 *
 * Usage:
 *   node scripts/test-llm-fast-route.mjs
 *   API_BASE_URL=http://127.0.0.1:8790 node scripts/test-llm-fast-route.mjs
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_LLM_FAST_HF_MODEL = 'meta-llama/Llama-3.1-8B-Instruct:featherless-ai';

function resolveDefaultApiBase() {
  const fromEnv = String(process.env.API_BASE_URL || process.env.MYBRAIN_API_BASE || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');

  const tryFiles = [resolve('.dev-backend-port.hf'), resolve('.dev-backend-port')];
  for (const f of tryFiles) {
    if (existsSync(f)) {
      const raw = readFileSync(f, 'utf8').trim();
      const p = /^\d+$/.test(raw) ? raw : null;
      if (p) return `http://127.0.0.1:${p}`;
    }
  }
  return 'http://127.0.0.1:8790';
}

const expectedId =
  (process.env.LLM_FAST_HF_MODEL || process.env.EXPECTED_LLM_FAST_MODEL || DEFAULT_LLM_FAST_HF_MODEL)
    .split(/[,]+/)[0]
    .trim() || DEFAULT_LLM_FAST_HF_MODEL;

async function main() {
  const base = resolveDefaultApiBase();
  const h = await fetch(`${base}/api/health`);
  if (h.ok) {
    const hj = await h.json();
    const fr = hj?.llm?.fastRoute;
    if (fr && !fr.configured) {
      console.error(
        '[test-llm-fast-route] /api/health reports fast route not configured (need HF_TOKEN and non-empty effectiveModels).',
        fr
      );
      process.exit(1);
    }
  }

  const url = `${base}/api/llm/text`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Reply with one word: OK',
      systemPrompt: 'You are a concise assistant.',
      max_tokens: 32,
      temperature: 0,
      llmRoute: 'fast',
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error(`[test-llm-fast-route] HTTP ${r.status} from ${url}`, t.slice(0, 800));
    process.exit(1);
  }
  const j = await r.json();
  const model = String(j.model || '');
  if (!j.text && j.text !== '') {
    console.error('[test-llm-fast-route] missing text in response', j);
    process.exit(1);
  }
  if (model && !model.includes('Llama-3.1-8B') && !/8b.*instruct/i.test(model) && !model.includes('meta-llama')) {
    console.warn(
      '[test-llm-fast-route] model id may differ from default 8B — got:',
      model,
      'expected to contain 8B or meta-llama (LLM_FAST_HF_MODEL=',
      expectedId,
      ')'
    );
  }
  if (j.provider && j.provider !== 'huggingface') {
    console.warn(
      '[test-llm-fast-route] expected provider "huggingface" for fast route; got:',
      j.provider,
      '(set LLM_FAST_FALLBACK_TO_DEFAULT=0 and ensure HF_TOKEN + LLM_FAST_HF_MODEL)'
    );
  } else {
    console.log(
      '[test-llm-fast-route] ok — provider:',
      j.provider,
      'model:',
      j.model,
      'preview:',
      String(j.text).trim().slice(0, 80)
    );
  }
}

main().catch((e) => {
  console.error('[test-llm-fast-route]', e?.message || e);
  process.exit(1);
});
