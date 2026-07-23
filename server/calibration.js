/**
 * Pipeline telemetry logging and threshold calibration.
 * Logs per-run metrics and periodically nudges thresholds via exponential moving averages.
 */

import fs from 'node:fs';
import path from 'node:path';
import { saveThresholds, getAllThresholds } from './thresholdStore.js';

const TELEMETRY_FILE = path.resolve(
  process.cwd(),
  String(process.env.PIPELINE_TELEMETRY_PATH || '.data/pipeline-telemetry.jsonl').trim()
);

const MAX_TELEMETRY_ROWS = 500;

/**
 * Log telemetry for a completed pipeline run.
 * @param {object} sharedMemory
 */
export function logPipelineTelemetry(sharedMemory) {
  try {
    const sm = sharedMemory;
    if (!sm || typeof sm !== 'object') return;

    const ef = sm.epistemicFusion;
    const gw = sm.globalWorkspace;
    const intr = sm.interoception || {};

    const row = {
      timestamp: new Date().toISOString(),
      sessionId: sm.sessionId || null,
      epistemicEntropy: ef?.entropy ?? null,
      maxPosterior: ef?.maxPosterior ?? null,
      metacognitionRerunsUsed: sm.metacognitionRerunsUsed ?? 0,
      integrationConfidence: gw?.integrationConfidence ?? null,
      phenomenalUnity: gw?.phenomenalUnity ?? null,
      uncertaintyPressure: intr.uncertaintyPressure ?? null,
      curiosityPressure: intr.curiosityPressure ?? null,
      tensionPressure: intr.tensionPressure ?? null,
      arousal: sm.arousal ?? null,
      phase: sm.phaseEffective || sm.phase || null,
      adaptiveTemperatureUsed: sm._adaptiveTemperature ?? null,
      retrievalSemanticWeight: sm._retrievalSemanticWeight ?? null,
      retrievalScoreFloor: sm._retrievalScoreFloor ?? null,
      retrievalScoreMargin: sm._retrievalScoreMargin ?? null,
      retrievalMinScoreEnabled: sm._retrievalMinScoreEnabled ?? null,
      conflictCount: Array.isArray(gw?.conflicts) ? gw.conflicts.length : 0,
      tensionCount: Array.isArray(sm.contradictions) ? sm.contradictions.length : 0,
      voiceWordCount: String(sm.moduleOutputs?.Voice || '').split(/\s+/).filter(Boolean).length,
      policySampledFrom: sm.cognitivePolicy?.sampledFrom ? true : false,
    };

    const dir = path.dirname(TELEMETRY_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(TELEMETRY_FILE, JSON.stringify(row) + '\n', 'utf8');
  } catch (e) {
    console.warn('[calibration] telemetry log failed:', e?.message || e);
  }
}

function readTelemetryRows(maxRows = MAX_TELEMETRY_ROWS) {
  try {
    if (!fs.existsSync(TELEMETRY_FILE)) return [];
    const lines = fs.readFileSync(TELEMETRY_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const rows = [];
    const start = Math.max(0, lines.length - maxRows);
    for (let i = start; i < lines.length; i++) {
      try { rows.push(JSON.parse(lines[i])); } catch { /* skip malformed */ }
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * Recalibrate thresholds based on telemetry history.
 * Uses simple exponential moving averages to nudge threshold values.
 */
export function recalibrateThresholds() {
  const rows = readTelemetryRows();
  if (rows.length < 10) {
    console.log('[calibration] Not enough telemetry rows for calibration (need >= 10, have', rows.length, ')');
    return null;
  }

  const current = getAllThresholds();
  const alpha = 0.1;

  const ents = rows.map((r) => r.epistemicEntropy).filter((v) => typeof v === 'number');
  if (ents.length >= 5) {
    const avgEntropy = ents.reduce((a, b) => a + b, 0) / ents.length;
    const currentEntropyHigh = current.epistemic_entropy_high ?? 0.9;
    current.epistemic_entropy_high = Math.round((currentEntropyHigh * (1 - alpha) + (avgEntropy + 0.3) * alpha) * 1000) / 1000;
  }

  const ics = rows.map((r) => r.integrationConfidence).filter((v) => typeof v === 'number');
  if (ics.length >= 5) {
    const avgIC = ics.reduce((a, b) => a + b, 0) / ics.length;
    const currentICLow = current.integration_confidence_low ?? 0.35;
    current.integration_confidence_low = Math.round((currentICLow * (1 - alpha) + Math.max(0.15, avgIC - 0.2) * alpha) * 1000) / 1000;
  }

  const ups = rows.map((r) => r.uncertaintyPressure).filter((v) => typeof v === 'number');
  if (ups.length >= 5) {
    const avgUP = ups.reduce((a, b) => a + b, 0) / ups.length;
    const currentUPHigh = current.uncertainty_pressure_high ?? 0.72;
    current.uncertainty_pressure_high = Math.round((currentUPHigh * (1 - alpha) + (avgUP + 0.25) * alpha) * 1000) / 1000;
  }

  const cps = rows.map((r) => r.curiosityPressure).filter((v) => typeof v === 'number');
  if (cps.length >= 5) {
    const avgCP = cps.reduce((a, b) => a + b, 0) / cps.length;
    const currentCPHigh = current.curiosity_pressure_high ?? 0.55;
    current.curiosity_pressure_high = Math.round((currentCPHigh * (1 - alpha) + (avgCP + 0.15) * alpha) * 1000) / 1000;
  }

  const tps = rows.map((r) => r.tensionPressure).filter((v) => typeof v === 'number');
  if (tps.length >= 5) {
    const avgTP = tps.reduce((a, b) => a + b, 0) / tps.length;
    const currentTPHigh = current.tension_pressure_high ?? 0.52;
    current.tension_pressure_high = Math.round((currentTPHigh * (1 - alpha) + (avgTP + 0.15) * alpha) * 1000) / 1000;
  }

  current.calibrated_at = new Date().toISOString();
  current.sample_size = rows.length;

  saveThresholds(current);
  console.log('[calibration] Thresholds recalibrated from', rows.length, 'telemetry rows');
  return current;
}
