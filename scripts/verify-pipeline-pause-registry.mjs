/**
 * Contract tests for server cooperative pause flags (no HTTP).
 *
 * Run: node scripts/verify-pipeline-pause-registry.mjs
 */
import {
  consumePipelinePauseIfRequested,
  pipelinePausePending,
  requestPipelinePause,
} from '../server/pipelinePauseRegistry.js';

const token = 'verify-pause-registry-test-token';

requestPipelinePause(token);
if (!pipelinePausePending(token)) {
  throw new Error('expected pause pending after request');
}
if (!consumePipelinePauseIfRequested(token)) {
  throw new Error('expected first consume to return true');
}
if (consumePipelinePauseIfRequested(token)) {
  throw new Error('expected second consume to return false (flag consumed)');
}
if (pipelinePausePending(token)) {
  throw new Error('expected flag cleared after consume');
}

requestPipelinePause('');
requestPipelinePause('   ');
if (pipelinePausePending('')) {
  throw new Error('empty token should not register');
}

console.log('verify-pipeline-pause-registry: all checks passed');
