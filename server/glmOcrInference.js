/**
 * GLM-OCR via Hugging Face Inference (@huggingface/inference) + provider zai-org.
 * Matches Python: InferenceClient(provider="zai-org").image_to_text(..., model="zai-org/GLM-OCR")
 */

import { InferenceClient } from '@huggingface/inference';

function requiredEnv(name) {
  const value = process.env[name];
  return value && String(value).trim() ? String(value).trim() : null;
}

export function resolveHuggingfaceToken() {
  return requiredEnv('HF_TOKEN') || requiredEnv('HUGGINGFACE_API_TOKEN');
}

function glmOcrDisabled() {
  return /^1|true|yes$/i.test(String(process.env.GLM_OCR_DISABLED || '').trim());
}

function glmOcrModel() {
  return requiredEnv('GLM_OCR_MODEL') || 'zai-org/GLM-OCR';
}

function glmOcrProvider() {
  return requiredEnv('GLM_OCR_PROVIDER') || 'zai-org';
}

function glmOcrMaxChars() {
  const raw = String(process.env.GLM_OCR_MAX_CHARS || '').trim();
  if (!raw) return 48_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 48_000;
}

function glmOcrTimeoutMs() {
  const raw = String(process.env.GLM_OCR_TIMEOUT_MS || '').trim();
  if (!raw) return 180_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 180_000;
}

function glmOcrConcurrency() {
  const raw = String(process.env.GLM_OCR_CONCURRENCY || '').trim();
  if (!raw) return 2;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(6, n) : 2;
}

function truncateOcr(text) {
  const max = glmOcrMaxChars();
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n[…GLM-OCR output truncated to ${max} chars]`;
}

function normalizeImageToTextResult(out) {
  if (out == null) return '';
  if (typeof out === 'string') return out;
  if (typeof out === 'object') {
    if (typeof out.generated_text === 'string') return out.generated_text;
    if (typeof out.generatedText === 'string') return out.generatedText;
  }
  return String(out);
}

/**
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
export async function runGlmOcrOnImageBuffer(buffer, mimeType, signal) {
  const token = resolveHuggingfaceToken();
  if (!token) {
    throw new Error('HF_TOKEN not set');
  }
  const mime = String(mimeType || 'application/octet-stream').trim() || 'image/png';
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const blob = new Blob([buf], { type: mime.startsWith('image/') ? mime : 'image/png' });

  const provider = glmOcrProvider();
  const client = new InferenceClient(token, { provider });
  const raw = await client.imageToText(
    {
      model: glmOcrModel(),
      data: blob,
      provider,
    },
    { signal }
  );
  return truncateOcr(normalizeImageToTextResult(raw));
}

function isImageAttachment(a) {
  const k = String(a?.kind || '').toLowerCase();
  const m = String(a?.mimeType || '').toLowerCase();
  return k === 'image' || m.startsWith('image/');
}

/**
 * @param {Array<{
 *   id: string,
 *   kind: string,
 *   filename: string,
 *   mimeType: string,
 *   size: number,
 *   buffer?: Buffer | null,
 * }>} attachments
 * @returns {Promise<string>}
 */
export async function buildAttachmentBlockWithGlmOcr(attachments) {
  if (!attachments.length) return '';

  const conc = glmOcrConcurrency();
  /** @type {string[]} */
  const lines = [];

  async function oneLine(idx, a) {
    const base = `- [${idx + 1}] ${a.kind} ${a.filename} (${a.mimeType}, ${a.size} bytes)`;

    if (glmOcrDisabled()) {
      return `${base} · caption: (GLM-OCR disabled)`;
    }

    if (!isImageAttachment(a)) {
      return `${base} · caption: (not an image; GLM-OCR skipped)`;
    }

    const token = resolveHuggingfaceToken();
    if (!token) {
      return `${base} · caption: (GLM-OCR skipped: HF_TOKEN not set)`;
    }

    if (!a.buffer || !Buffer.isBuffer(a.buffer) || a.buffer.length === 0) {
      return `${base} · caption: (no image bytes; GLM-OCR skipped)`;
    }

    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), glmOcrTimeoutMs());
    try {
      const text = await runGlmOcrOnImageBuffer(a.buffer, a.mimeType, ac.signal);
      const body = String(text || '').trim() || '(empty GLM-OCR result)';
      return `${base} · GLM-OCR:\n"""\n${body}\n"""`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const short = msg.length > 220 ? `${msg.slice(0, 220)}…` : msg;
      return `${base} · caption: (GLM-OCR failed: ${short})`;
    } finally {
      clearTimeout(tid);
    }
  }

  for (let i = 0; i < attachments.length; i += conc) {
    const slice = attachments.slice(i, i + conc);
    const batchLines = await Promise.all(
      slice.map((a, j) => oneLine(i + j, a))
    );
    lines.push(...batchLines);
  }

  return ['ATTACHMENTS:', ...lines].join('\n');
}
