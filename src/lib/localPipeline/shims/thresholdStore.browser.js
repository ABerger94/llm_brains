/**
 * Browser replacement for server/thresholdStore.js, aliased in only for the
 * browser-only build (see vite.config.js). The real store persists
 * recalibrated thresholds to a JSON file (node:fs) and falls back to
 * `defaultValue` until a calibration exists. Since calibration.browser.js
 * never recalibrates anything, always returning `defaultValue` here is
 * exactly that same "no calibration yet" behavior, not a degraded one.
 */
export function getThreshold(_name, defaultValue) {
  return defaultValue;
}
