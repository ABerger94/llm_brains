/**
 * Asserts PRIOR_TURN_PREDICTION_AUDIT appears in Learning CONTEXT_AND_POLICY when options carry priorPredictionAudit.
 */
import { createSharedMemory, stripPriorPipelineTraceForNewTurn } from '../server/pipeline.js';
import { mergeMindRuntimeIntoSharedMemory, buildMindContextForModule } from '../server/mindPolicy.js';

const sm0 = createSharedMemory({
  existingSharedMemory: null,
  input: 'hello',
});
sm0.userStancePrediction = { expectUserWants: 'a friendly greeting', confidence: 0.7 };

const sm = createSharedMemory({
  existingSharedMemory: sm0,
  input: 'old --- \n\nactually I need help debugging code',
});
mergeMindRuntimeIntoSharedMemory(sm, {
  priorPredictionAudit: {
    at: new Date().toISOString(),
    sessionId: sm.sessionId,
    previousExpectUserWants: 'a friendly greeting',
    previousConfidence: 0.7,
    previousPrimaryTurnPreview: 'hello',
    newPrimaryTurnPreview: 'actually I need help debugging code',
    overlapScore: 0.05,
    heuristicAlignment: 'shifted',
  },
});
stripPriorPipelineTraceForNewTurn(sm);

const ctx = buildMindContextForModule('Learning', sm);
if (!ctx.includes('PRIOR_TURN_PREDICTION_AUDIT')) {
  console.error('fail: Learning context missing PRIOR_TURN_PREDICTION_AUDIT');
  process.exit(1);
}
if (!ctx.includes('shifted')) {
  console.error('fail: expected heuristic alignment in audit block');
  process.exit(1);
}
console.log('test-prior-prediction-audit: ok');
