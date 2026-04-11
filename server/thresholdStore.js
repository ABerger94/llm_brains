/**
 * Threshold store: loads calibrated thresholds from a JSON file (written by calibration.js)
 * and provides getThreshold(name, default) for all code sites that previously used magic numbers.
 */

import fs from 'node:fs';
import path from 'node:path';

const CALIBRATED_THRESHOLDS_FILE = path.resolve(
  process.cwd(),
  String(process.env.CALIBRATED_THRESHOLDS_PATH || '.data/calibrated-thresholds.json').trim()
);

let _thresholds = {};
let _loadedAt = 0;
const RELOAD_INTERVAL_MS = 60_000;

function loadThresholds() {
  try {
    if (!fs.existsSync(CALIBRATED_THRESHOLDS_FILE)) return;
    const raw = fs.readFileSync(CALIBRATED_THRESHOLDS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      _thresholds = parsed;
      _loadedAt = Date.now();
    }
  } catch (e) {
    console.warn('[thresholdStore] Failed to load calibrated thresholds:', e?.message || e);
  }
}

loadThresholds();

function maybeReload() {
  if (Date.now() - _loadedAt > RELOAD_INTERVAL_MS) {
    loadThresholds();
  }
}

/**
 * Get a threshold value by name, falling back to the provided default.
 * Calibrated values take precedence if available.
 * @param {string} name
 * @param {number} defaultValue
 * @returns {number}
 */
export function getThreshold(name, defaultValue) {
  maybeReload();
  const val = _thresholds[name];
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  return defaultValue;
}

/**
 * Write calibrated thresholds to disk.
 * @param {Record<string, number>} thresholds
 */
export function saveThresholds(thresholds) {
  try {
    const dir = path.dirname(CALIBRATED_THRESHOLDS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CALIBRATED_THRESHOLDS_FILE, JSON.stringify(thresholds, null, 2), 'utf8');
    _thresholds = { ...thresholds };
    _loadedAt = Date.now();
  } catch (e) {
    console.warn('[thresholdStore] Failed to save calibrated thresholds:', e?.message || e);
  }
}

/** Get all current thresholds (for health/debug endpoints). */
export function getAllThresholds() {
  maybeReload();
  return { ..._thresholds };
}
