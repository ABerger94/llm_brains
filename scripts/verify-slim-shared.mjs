/**
 * Quick check: continuation sharedMemory slimming keeps payloads bounded.
 */
import { slimSharedMemoryForPipelinePost } from '../src/lib/slimSharedMemory.js';

const huge = 'x'.repeat(25_000);
const sm = {
  moduleOutputs: { Perception: huge, 'Perception__meta': { ok: true } },
  originalInput: huge,
  identityNarrative: huge,
  narrativeHistory: [huge, 'short'],
};

const out = slimSharedMemoryForPipelinePost(sm);
if (!out.moduleOutputs.Perception || out.moduleOutputs.Perception.length >= 9000) {
  console.error('fail: Perception output not trimmed');
  process.exit(1);
}
if (out.moduleOutputs['Perception__meta'].ok !== true) {
  console.error('fail: __meta should be untouched');
  process.exit(1);
}
if (out.originalInput.length >= 33_000) {
  console.error('fail: originalInput not trimmed');
  process.exit(1);
}
console.log('verify-slim-shared: ok');
