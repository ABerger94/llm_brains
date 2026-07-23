/**
 * Browser replacement for server/calibration.js, aliased in only for the
 * browser-only build (see vite.config.js). The real module logs telemetry to
 * a JSON file (node:fs) to drive threshold recalibration over time — not
 * meaningful without persistent server-side history. No-op.
 */
export function logPipelineTelemetry() {}

export function recalibrateThresholds() {
  return null;
}
