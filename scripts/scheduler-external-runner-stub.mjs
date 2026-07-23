#!/usr/bin/env node
/**
 * Scheduled tasks are stored in the browser (IndexedDB) and executed by the in-app scheduler when the app is open.
 * There is no server-side queue in this stack — a headless “daemon” cannot run due tasks without the client runtime.
 * Open the app (or use the Scheduler page) to process pending rows; catch-up is limited per tick via
 * runtime `schedulerCatchUpMaxDuePerTick`.
 */
console.log(
  '[scheduler-external-runner-stub] No-op: run scheduled work from the YourBrain UI (Scheduler) with the app open.'
);
process.exit(0);
