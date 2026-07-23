/**
 * Asserts CONTEXT_MERGE_PRIORITY and overlap hints appear in Memory context after
 * merge, probabilistic retrieval (may no-op), and applyCrossChannelDigestHints.
 */
import { createSharedMemory } from '../server/pipeline.js';
import {
  mergeMindRuntimeIntoSharedMemory,
  buildMindContextForModule,
  applyProbabilisticMemoryRetrieval,
} from '../server/mindPolicy.js';
import { applyCrossChannelDigestHints, applyWorkspaceDigestAdmissionHints } from '../server/contextMerge.js';

const sm = createSharedMemory({
  existingSharedMemory: null,
  input: 'What do you remember about my mornings?',
});
sm.intent = 'recall routines';
mergeMindRuntimeIntoSharedMemory(sm, {
  persistedLongTermMemories: [
    {
      title: 'coffee habits',
      content: 'User drinks morning coffee regularly',
      memory_type: 'note',
      created_date: new Date().toISOString(),
    },
  ],
  persistedBeliefRows: [
    {
      statement: 'The user enjoys morning coffee every day',
      category: 'preference',
      confidence: 0.82,
      status: 'active',
    },
  ],
});

try {
  await applyProbabilisticMemoryRetrieval(sm);
} catch {
  /* embeddings optional */
}
applyCrossChannelDigestHints(sm);

sm.globalWorkspace = {
  provisionalStance: 'Morning coffee and routines matter for this recall question.',
  salience: ['coffee', 'mornings', 'habits'],
};
applyWorkspaceDigestAdmissionHints(sm);

const ctx = buildMindContextForModule('Memory', sm);
if (!ctx.includes('CONTEXT_MERGE_PRIORITY')) {
  console.error('fail: Memory context missing CONTEXT_MERGE_PRIORITY');
  process.exit(1);
}
if (!ctx.includes('Provenance:')) {
  console.error('fail: expected provenance line in store digest blocks');
  process.exit(1);
}
if (!ctx.includes('PERSISTED_BELIEF_STORE #1') || !ctx.includes('PERSISTED_LONG_TERM_MEMORY #1')) {
  console.error('fail: expected overlap hint linking belief and LTM rows');
  process.exit(1);
}
if (!ctx.includes('Workspace admission hints')) {
  console.error('fail: expected workspace admission hints after Integration-shaped globalWorkspace');
  process.exit(1);
}
console.log('test-llm-context-merge: ok');
