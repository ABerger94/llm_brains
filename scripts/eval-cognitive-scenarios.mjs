/**
 * Offline cognitive checks: stub LLM returns fixed module outputs; validates redaction and markers.
 */
process.env.LLM_CHUNKED_MODULE_CALLS = 'off';

import { runPipeline, formatSharedMemoryForModule } from '../server/pipeline.js';
import { MODULES } from '../shared/pipelineModules.mjs';

const INTEGRATION_DRAFT =
  'ok\nINTEGRATION_JSON: {"salience":["s"],"conflicts":[],"openQuestions":[],"provisionalStance":"stance draft","integrationConfidence":0.6,"broadcastWinners":["w"],"phenomenalUnity":"partial","epistemicThreads":[{"thread":"t","kind":"user"}]}';

const INTEGRATION_FINAL =
  'ok\nINTEGRATION_JSON: {"salience":["s"],"conflicts":[],"openQuestions":[],"provisionalStance":"stance final","integrationConfidence":0.7,"broadcastWinners":["w"],"phenomenalUnity":"unified","epistemicThreads":[{"thread":"t","kind":"user"}]}';

const STUB = {
  SensorySalience: 'EXPLICIT\nSALIENT_1 what\n why',
  ContextMemory:
    'RETRIEVED\nSURPRISE_ASSESSMENT: {"score":0.2,"note":"ok"}\nWORKING_MEMORY_PROMOTE: {"ids":[]}',
  Deliberation:
    'GOAL\nUSER_STANCE_PREDICTION: {"expectUserWants":"answer","confidence":0.5}\nHYPOTHESES_JSON: {"hypotheses":[]}',
  Beliefs:
    'beliefs ok\nBELIEF_REVISIONS: {"revisions":[]}\nEPISTEMIC_CLAIMS: {"claims":[{"text":"User asked X","kind":"user_attributed","confidence":0.9}]}',
  SelfRelationTension: 'STRONG\nWEAK\nthis reasoning is flawed in ways X\nTENSIONS\nNONE',
  Integration: INTEGRATION_DRAFT,
  ExecutiveGate: 'PROCEED 0.9\n- ok',
  IntegrationFinalize: INTEGRATION_FINAL,
  Motivation: 'MAIN_QUESTION: q?\nURGENCY: 0.5\nTHREADS:\n- NONE\nGOAL_URGENCY: 0.5\nSOMATIC_MARKER: calm',
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
  const name = mod?.name || 'SensorySalience';
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
    console.error('fail: Voice shared memory should redact SelfRelationTension critic text');
    process.exit(1);
  }
  if (!voiceJson.includes('redacted for Voice')) {
    console.error('fail: Voice should contain redaction placeholder for critic modules');
    process.exit(1);
  }
  const claims = sharedMemory.epistemicClaims || [];
  if (!claims.length || claims[0].kind !== 'user_attributed') {
    console.error('fail: epistemicClaims not parsed from Beliefs');
    process.exit(1);
  }
  const gw = sharedMemory.globalWorkspace || {};
  if (!Array.isArray(gw.epistemicThreads) || !gw.epistemicThreads.length) {
    console.error('fail: epistemicThreads missing from integration finalize');
    process.exit(1);
  }
  if (!(sharedMemory.predictionHistory || []).length) {
    console.error('fail: predictionHistory should record Deliberation USER_STANCE_PREDICTION');
    process.exit(1);
  }

  const rerunStub = { ...STUB, ExecutiveGate: 'RERUN 0.85 deeper pass\n- fix' };
  async function callLLMRerun(systemPrompt, userContent, options) {
    if (String(systemPrompt || '').includes('ingest one fragment')) {
      return { text: JSON.stringify({ chunkIndex: 0, bullets: ['stub-ingest'] }), provider: 'stub', model: 'stub' };
    }
    const mod = MODULES.find((m) => m.systemPrompt === systemPrompt);
    const name = mod?.name || 'SensorySalience';
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
  if (!String(rerunResult.sharedMemory.moduleOutputs.IntegrationFinalize || '').trim()) {
    console.error('fail: IntegrationFinalize must run when RERUN cap is 0 (forced proceed to Voice)');
    process.exit(1);
  }
  const capFlags = rerunResult.sharedMemory.metaCognitionFlags || [];
  if (!capFlags.some((f) => f.supervisor === 'ExecutiveGate' && f.capExceeded)) {
    console.error('fail: ExecutiveGate RERUN with max=0 should record capExceeded on metaCognitionFlags');
    process.exit(1);
  }

  const perLegStub = { ...STUB, ExecutiveGate: 'RERUN 0.7 per-leg continuation test\n- fix' };
  async function callLLMPerLeg(systemPrompt, userContent, options) {
    if (String(systemPrompt || '').includes('ingest one fragment')) {
      return { text: JSON.stringify({ chunkIndex: 0, bullets: ['stub-ingest'] }), provider: 'stub', model: 'stub' };
    }
    const mod = MODULES.find((m) => m.systemPrompt === systemPrompt);
    const name = mod?.name || 'SensorySalience';
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
  if (leg2.continuationRequired) {
    console.error(
      'fail: leg2 with max=1 after leg1 consumed the rerun must finish inline (cumulative cap across continuation POSTs)'
    );
    process.exit(1);
  }
  const leg2CapExceeded = (leg2.sharedMemory.metaCognitionFlags || []).some(
    (f) => f.supervisor === 'ExecutiveGate' && f.capExceeded
  );
  if (!leg2CapExceeded) {
    console.error('fail: leg2 ExecutiveGate RERUN with exhausted cap should set capExceeded on metaCognitionFlags');
    process.exit(1);
  }
  if (!String(leg2.sharedMemory.moduleOutputs?.Voice || '').trim()) {
    console.error('fail: leg2 should reach Voice after forced PROCEED');
    process.exit(1);
  }

  console.log('eval-cognitive-scenarios: ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
