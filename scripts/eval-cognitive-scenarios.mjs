/**
 * Offline cognitive checks: stub LLM returns fixed module outputs; validates redaction and markers.
 */
process.env.LLM_CHUNKED_MODULE_CALLS = 'off';

import { runPipeline, formatSharedMemoryForModule } from '../server/pipeline.js';
import { MODULES } from '../shared/pipelineModules.mjs';

const STUB = {
  Perception: 'structured perception ok',
  Attention: '- salient point one about the user request',
  Memory: 'memory context',
  Learning: 'learning\nSURPRISE_ASSESSMENT: {"score":0.2,"note":"ok"}\nWORKING_MEMORY_PROMOTE: {"ids":[]}',
  'Temporal Awareness': 'now',
  Planning: 'plan\nUSER_STANCE_PREDICTION: {"expectUserWants":"answer","confidence":0.5}',
  Reasoning: 'reasoning chain',
  Emotion: 'neutral',
  'Theory of Mind': 'user wants clarity',
  'Belief Store':
    'beliefs ok\nBELIEF_REVISIONS: {"revisions":[]}\nEPISTEMIC_CLAIMS: {"claims":[{"text":"User asked X","kind":"user_attributed","confidence":0.9}]}',
  'Self-Reflection': 'this reasoning is flawed in ways X',
  Identity: 'SELF_MODEL_DELTA: {}\nself',
  'Social Cognition': 'collaborative',
  'Contradiction Engine': 'no severe contradictions',
  Metacognition: 'PROCEED ok',
  Integration:
    'ok\nINTEGRATION_JSON: {"salience":["s"],"conflicts":[],"openQuestions":[],"provisionalStance":"ps","integrationConfidence":0.6,"epistemicThreads":[{"thread":"t","kind":"user"}]}',
  Language: 'language draft',
  Curiosity: 'q?',
  'Goal Generation': 'goalar',
  'Somatic Marker': 'calm',
  Narrative: 'internal narrative',
  Voice: 'final voice line',
};

async function callLLM(systemPrompt, userContent, options) {
  if (String(systemPrompt || '').includes('ingest one fragment')) {
    return {
      text: JSON.stringify({ chunkIndex: 0, bullets: ['stub-ingest'] }),
      provider: 'stub',
      model: 'stub',
    };
  }
  const mod = MODULES.find((m) => m.systemPrompt === systemPrompt);
  const name = mod?.name || 'Perception';
  const text = STUB[name] || `stub-${name}`;
  return { text, provider: 'stub', model: 'stub-model' };
}

async function main() {
  const { sharedMemory } = await runPipeline({
    input: 'user turn one\n---\n\nWhat is 2+2?',
    existingSharedMemory: null,
    callLLM,
    options: { maxMetacognitionReruns: 0, preserveModuleTrace: false },
  });

  const voiceJson = formatSharedMemoryForModule(sharedMemory, 'Voice');
  if (voiceJson.includes('this reasoning is flawed')) {
    console.error('fail: Voice shared memory should redact Self-Reflection text');
    process.exit(1);
  }
  if (!voiceJson.includes('redacted for Voice')) {
    console.error('fail: Voice should contain redaction placeholder for critic modules');
    process.exit(1);
  }
  const claims = sharedMemory.epistemicClaims || [];
  if (!claims.length || claims[0].kind !== 'user_attributed') {
    console.error('fail: epistemicClaims not parsed from Belief Store');
    process.exit(1);
  }
  const gw = sharedMemory.globalWorkspace || {};
  if (!Array.isArray(gw.epistemicThreads) || !gw.epistemicThreads.length) {
    console.error('fail: epistemicThreads missing from integration');
    process.exit(1);
  }
  if (!(sharedMemory.predictionHistory || []).length) {
    console.error('fail: predictionHistory should record Planning output');
    process.exit(1);
  }

  const rerunStub = { ...STUB, Metacognition: 'RERUN deeper pass' };
  async function callLLMRerun(systemPrompt, userContent, options) {
    if (String(systemPrompt || '').includes('ingest one fragment')) {
      return { text: JSON.stringify({ chunkIndex: 0, bullets: ['stub-ingest'] }), provider: 'stub', model: 'stub' };
    }
    const mod = MODULES.find((m) => m.systemPrompt === systemPrompt);
    const name = mod?.name || 'Perception';
    const text = rerunStub[name] || `stub-${name}`;
    return { text, provider: 'stub', model: 'stub-model' };
  }
  const rerunResult = await runPipeline({
    input: 'user turn two\n---\n\nRERUN cap test',
    existingSharedMemory: null,
    callLLM: callLLMRerun,
    options: { maxMetacognitionReruns: 0, preserveModuleTrace: false },
  });
  if (rerunResult.continuationRequired) {
    console.error(
      'fail: explicit RERUN with maxMetacognitionReruns 0 must complete in one leg (no continuation; cap exceeded)'
    );
    process.exit(1);
  }
  if (!String(rerunResult.sharedMemory.moduleOutputs.Integration || '').trim()) {
    console.error('fail: Integration must run when RERUN cap is 0 (forced proceed to Voice)');
    process.exit(1);
  }
  const capFlags = rerunResult.sharedMemory.metaCognitionFlags || [];
  if (!capFlags.some((f) => f.supervisor === 'Metacognition' && f.capExceeded)) {
    console.error('fail: Metacognition RERUN with max=0 should record capExceeded on metaCognitionFlags');
    process.exit(1);
  }

  const perLegStub = { ...STUB, Metacognition: 'RERUN per-leg continuation test' };
  async function callLLMPerLeg(systemPrompt, userContent, options) {
    if (String(systemPrompt || '').includes('ingest one fragment')) {
      return { text: JSON.stringify({ chunkIndex: 0, bullets: ['stub-ingest'] }), provider: 'stub', model: 'stub' };
    }
    const mod = MODULES.find((m) => m.systemPrompt === systemPrompt);
    const name = mod?.name || 'Perception';
    const text = perLegStub[name] || `stub-${name}`;
    return { text, provider: 'stub', model: 'stub-model' };
  }
  const leg1 = await runPipeline({
    input: 'per-leg metacognition cap\n---\n\ntest',
    existingSharedMemory: null,
    callLLM: callLLMPerLeg,
    options: {
      maxMetacognitionReruns: 1,
      deferMetacognitionRerun: false,
      preserveModuleTrace: false,
    },
  });
  if (!leg1.continuationRequired) {
    console.error('fail: leg1 RERUN with max=1 must return continuationRequired');
    process.exit(1);
  }
  if (leg1.sharedMemory.metacognitionRerunsUsed !== 1) {
    console.error(
      `fail: leg1 expected metacognitionRerunsUsed 1, got ${leg1.sharedMemory.metacognitionRerunsUsed}`
    );
    process.exit(1);
  }
  const leg2 = await runPipeline({
    input: 'per-leg metacognition cap\n---\n\ntest',
    existingSharedMemory: leg1.sharedMemory,
    callLLM: callLLMPerLeg,
    options: {
      maxMetacognitionReruns: 1,
      deferMetacognitionRerun: false,
      pipelineMetacognitionContinuation: true,
      preserveModuleTrace: false,
    },
  });
  if (!leg2.continuationRequired) {
    console.error(
      'fail: leg2 continuation with max=1 must allow another RERUN (per-leg cap; expected continuationRequired)'
    );
    process.exit(1);
  }

  console.log('eval-cognitive-scenarios: ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
