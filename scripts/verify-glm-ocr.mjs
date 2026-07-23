/**
 * Smoke-test GLM-OCR (requires HF_TOKEN with Inference access).
 * Run: node scripts/verify-glm-ocr.mjs
 */

import { runGlmOcrOnImageBuffer, resolveHuggingfaceToken } from '../server/glmOcrInference.js';

/** 1x1 PNG (minimal valid file). */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function main() {
  if (!resolveHuggingfaceToken()) {
    console.log('verify-glm-ocr: skipped (set HF_TOKEN or HUGGINGFACE_API_TOKEN)');
    process.exit(0);
  }
  try {
    const text = await runGlmOcrOnImageBuffer(PNG_1X1, 'image/png');
    console.log('verify-glm-ocr: ok');
    console.log(String(text || '').trim().slice(0, 500) || '(empty)');
  } catch (e) {
    console.error('verify-glm-ocr: failed', e?.message || e);
    process.exit(1);
  }
}

main();
