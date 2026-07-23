/**
 * Unit-test: early bundle delimiter parser (no network).
 * Usage: node scripts/test-pipeline-early-bundle.mjs
 */
import {
  EARLY_BUNDLE_MODULE_ORDER,
  buildEarlyBundleSystemPrompt,
  splitEarlyBundleToModuleOutputs,
} from '../shared/earlyBundle.mjs';

const mk = (n) => `<<<MODULE ${n}>>>`;
const en = (n) => `<<<END_MODULE ${n}>>>`;
const minBody = (n) => 'x'.repeat(n === 'SelfRelationTension' ? 12 : 24);

const parts = EARLY_BUNDLE_MODULE_ORDER.map((name) => `${mk(name)}\n${minBody(name)}\n${en(name)}`).join('\n');
const out = splitEarlyBundleToModuleOutputs(parts);
if (!out || EARLY_BUNDLE_MODULE_ORDER.some((k) => !out[k])) {
  console.error('parse failed', out);
  process.exit(1);
}
if (!buildEarlyBundleSystemPrompt() || !buildEarlyBundleSystemPrompt().includes('<<<MODULE SensorySalience')) {
  console.error('system prompt build failed');
  process.exit(1);
}
console.log('ok earlyBundle parse + prompt', Object.keys(out).length, 'modules');
