/**
 * Smoke test for recoverable-error detection used by graph resume + interrupted banners.
 *
 * Manual checklist (interactive graph):
 * 1. Cooperative pause: run graph → when server pauses, sky banner shows "Next: {module}" → Continue resumes there.
 * 2. Transient error: stop API or simulate 502 mid-run → amber banner + Resume → should retry.
 * 3. Dashboard: "Resume all" runs interactive graph checkpoint when present; "Rerun interrupted" skips main graph.
 */
import { isTransientReconnectFailure } from '../src/lib/transientPipelineFailure.js';

if (!isTransientReconnectFailure('HTTP 502: bad gateway')) {
  console.error('fail: 502 should be transient');
  process.exit(1);
}
if (!isTransientReconnectFailure('Failed to fetch')) {
  console.error('fail: fetch failure should be transient');
  process.exit(1);
}
if (isTransientReconnectFailure('')) {
  console.error('fail: empty should not be transient');
  process.exit(1);
}
if (isTransientReconnectFailure('SyntaxError: unexpected token')) {
  console.error('fail: arbitrary app error should not be transient');
  process.exit(1);
}
console.log('test-transient-pipeline-failure: ok');
