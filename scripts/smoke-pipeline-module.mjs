/**
 * One real pipeline module via HTTP (requires server; same callLLM as full pipeline).
 * Usage: API_PORT=8787 node scripts/smoke-pipeline-module.mjs
 */
import 'dotenv/config';
import { createSharedMemory } from '../server/pipeline.js';

const port = Number(process.env.API_PORT || process.env.PORT || 8787);
const base = `http://127.0.0.1:${port}`;

const sm = createSharedMemory({ existingSharedMemory: null, input: 'Smoke test: describe one neutral observation.' });

const res = await fetch(`${base}/api/pipeline/module`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({
    moduleName: 'Perception',
    sharedMemory: sm,
    options: { max_tokens: 120, temperature: 0.4 },
  }),
});

const bodyText = await res.text();
let json;
try {
  json = JSON.parse(bodyText);
} catch {
  console.error('Non-JSON response', res.status, bodyText.slice(0, 500));
  process.exit(1);
}

if (!res.ok) {
  console.error('HTTP', res.status, json);
  process.exit(1);
}

console.log('smoke-pipeline-module: ok', json.provider, json.model);
console.log('output preview:', String(json.output || '').slice(0, 200).replace(/\s+/g, ' '));
