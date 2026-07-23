/**
 * Asserts new prep-bundle normalizers attach to shared memory and surface in Memory module policy.
 */
import { createSharedMemory } from '../server/pipeline.js';
import {
  mergeMindRuntimeIntoSharedMemory,
  buildMindContextForModule,
  normalizeClientWorldEnvironmentPayload,
  normalizeClientCuriosityRowsPayload,
  normalizeClientGoalRowsPayload,
} from '../server/mindPolicy.js';

const rawEnv = [{ category: 'environment', key: 'k1', label: 'API', description: 'REST tools', confidence: 0.7 }];
const rawCur = [{ question: 'Why does latency spike?', status: 'open', priority: 0.6 }];
const rawGoal = [{ statement: 'Ship the integration manifest.', status: 'pursuing', priority: 0.55 }];

const nEnv = normalizeClientWorldEnvironmentPayload(rawEnv);
const nCur = normalizeClientCuriosityRowsPayload(rawCur);
const nGoal = normalizeClientGoalRowsPayload(rawGoal);
if (nEnv.length !== 1 || nCur.length !== 1 || nGoal.length !== 1) {
  console.error('fail: normalizers dropped rows');
  process.exit(1);
}

const sm = createSharedMemory({ existingSharedMemory: null, input: 'test integration bundle' });
mergeMindRuntimeIntoSharedMemory(sm, {
  phase: 'focus',
  arousal: 0.5,
  persistedWorldEnvironmentRows: rawEnv,
  persistedCuriosityRows: rawCur,
  persistedGoalRows: rawGoal,
});

if (!Array.isArray(sm.clientWorldEnvironmentDigest) || sm.clientWorldEnvironmentDigest.length !== 1) {
  console.error('fail: clientWorldEnvironmentDigest not merged');
  process.exit(1);
}

const ctx = buildMindContextForModule('Memory', sm);
if (!ctx.includes('PERSISTED_WORLD_ENVIRONMENT')) {
  console.error('fail: Memory context missing PERSISTED_WORLD_ENVIRONMENT');
  process.exit(1);
}
if (!ctx.includes('PERSISTED_OPEN_CURIOSITIES')) {
  console.error('fail: Memory context missing PERSISTED_OPEN_CURIOSITIES');
  process.exit(1);
}
if (!ctx.includes('PERSISTED_OPEN_GOALS')) {
  console.error('fail: Memory context missing PERSISTED_OPEN_GOALS');
  process.exit(1);
}

console.log('test-pipeline-integration-normalizers: ok');
