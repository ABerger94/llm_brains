/**
 * Optional SQLite persistence for global-workspace snapshots.
 * Enable by setting WORKSPACE_DB_PATH to a file path (e.g. .data/workspace.sqlite).
 * Uses Node built-in `node:sqlite` (Node 22.13+ / 24+).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

let dbInstance = null;
let dbPathResolved = null;
let initError = null;

function resolveDbPath() {
  const raw = String(process.env.WORKSPACE_DB_PATH || '').trim();
  if (!raw) return null;
  if (/^\.[/\\]/.test(raw) || (raw.length >= 2 && raw[1] !== ':' && !raw.startsWith('/'))) {
    return path.resolve(process.cwd(), raw);
  }
  return raw;
}

export function getWorkspaceDbStatus() {
  return {
    enabled: Boolean(dbInstance),
    path: dbPathResolved ? path.basename(dbPathResolved) : null,
    error: initError?.message || null,
  };
}

export function initWorkspaceDb() {
  const p = resolveDbPath();
  if (!p) {
    dbInstance = null;
    dbPathResolved = null;
    initError = null;
    return;
  }
  dbPathResolved = p;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    dbInstance = new DatabaseSync(p);
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS workspace_snapshots (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        session_id TEXT NOT NULL,
        global_workspace_json TEXT NOT NULL,
        phenomenal_unity TEXT,
        integration_confidence REAL,
        provisional_stance TEXT,
        reruns_used INTEGER,
        voice_output_excerpt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_session_created
        ON workspace_snapshots (session_id, created_at DESC);
    `);
    try {
      dbInstance.exec('ALTER TABLE workspace_snapshots ADD COLUMN pipeline_progress_json TEXT');
    } catch (e) {
      if (!/duplicate column name/i.test(String(e?.message || e))) throw e;
    }
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        scheduled_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        input_text TEXT,
        reason TEXT,
        mind_storage_profile TEXT,
        scheduled_by TEXT,
        result_excerpt TEXT,
        recurrence TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        recurrence_end_date TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status_scheduled
        ON scheduled_tasks (status, scheduled_at ASC);
    `);
    initError = null;
  } catch (e) {
    dbInstance = null;
    initError = e;
    console.warn('[workspaceDb] disabled:', e?.message || e);
  }
}

function clip(s, n) {
  const t = String(s || '');
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

/**
 * Persisted with each snapshot so reconnect / resume can restore leg cursor and rerun counts (e.g. 1/3 vs 3/3).
 * @param {object} opts
 * @param {object|null|undefined} opts.sharedMemory
 * @param {number} opts.rerunsUsed
 * @param {object|null|undefined} [opts.executionCursor]
 * @param {unknown} [opts.maxMetacognitionReruns]
 * @param {boolean} [opts.pipelinePaused]
 * @param {boolean} [opts.continuationRequired]
 */
import { PIPELINE_SCHEMA_VERSION } from '../shared/pipelineModules.mjs';

export function buildPipelineProgressRecord({
  sharedMemory,
  rerunsUsed,
  executionCursor,
  maxMetacognitionReruns,
  pipelinePaused,
  continuationRequired,
}) {
  const rawMax = maxMetacognitionReruns != null ? Number(maxMetacognitionReruns) : NaN;
  return {
    v: PIPELINE_SCHEMA_VERSION,
    executionCursor: executionCursor && typeof executionCursor === 'object' ? executionCursor : null,
    metacognitionRerunsUsed: Number.isFinite(Number(rerunsUsed)) ? Math.floor(Number(rerunsUsed)) : 0,
    maxMetacognitionReruns: Number.isFinite(rawMax) ? Math.floor(rawMax) : null,
    iterationCount: Number.isFinite(Number(sharedMemory?.iterationCount))
      ? Math.floor(Number(sharedMemory.iterationCount))
      : 0,
    pipelinePaused: Boolean(pipelinePaused),
    continuationRequired: Boolean(continuationRequired),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {object|null} opts.globalWorkspace
 * @param {number} opts.rerunsUsed
 * @param {string} [opts.voiceOutput]
 * @param {object|null} [opts.pipelineProgress] — from {@link buildPipelineProgressRecord}
 */
export function insertWorkspaceSnapshot({
  sessionId,
  globalWorkspace,
  rerunsUsed,
  voiceOutput = '',
  pipelineProgress = null,
}) {
  if (!dbInstance || !sessionId) return null;
  const gw = globalWorkspace && typeof globalWorkspace === 'object' ? globalWorkspace : null;
  if (!gw) return null;
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const progressJson =
    pipelineProgress && typeof pipelineProgress === 'object' ? JSON.stringify(pipelineProgress) : null;
  const stmt = dbInstance.prepare(
    `INSERT INTO workspace_snapshots (
        id, created_at, session_id, global_workspace_json, phenomenal_unity,
        integration_confidence, provisional_stance, reruns_used, voice_output_excerpt,
        pipeline_progress_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    id,
    createdAt,
    String(sessionId).slice(0, 200),
    JSON.stringify(gw),
    clip(gw.phenomenalUnity, 32) || null,
    typeof gw.integrationConfidence === 'number' && Number.isFinite(gw.integrationConfidence)
      ? gw.integrationConfidence
      : null,
    clip(gw.provisionalStance, 500) || null,
    Number.isFinite(Number(rerunsUsed)) ? Math.floor(Number(rerunsUsed)) : 0,
    voiceOutput ? clip(voiceOutput, 2000) : null,
    progressJson
  );
  return id;
}

// ─── Scheduled Tasks (server-side) ────────────────────────────────────
export function insertScheduledTask({
  id,
  taskType,
  scheduledAt,
  inputText,
  reason,
  mindStorageProfile,
  scheduledBy,
  recurrence,
  recurrenceInterval,
  recurrenceUnit,
  recurrenceEndDate,
}) {
  if (!dbInstance) return null;
  const taskId = id || crypto.randomUUID();
  const now = new Date().toISOString();
  const stmt = dbInstance.prepare(
    `INSERT INTO scheduled_tasks (
      id, task_type, status, scheduled_at, created_at, input_text, reason,
      mind_storage_profile, scheduled_by, recurrence, recurrence_interval,
      recurrence_unit, recurrence_end_date
    ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    taskId,
    String(taskType || '').slice(0, 100),
    String(scheduledAt || now),
    now,
    inputText ? String(inputText).slice(0, 8000) : null,
    reason ? String(reason).slice(0, 500) : null,
    mindStorageProfile ? String(mindStorageProfile).slice(0, 200) : null,
    scheduledBy ? String(scheduledBy).slice(0, 200) : null,
    recurrence ? String(recurrence).slice(0, 50) : null,
    recurrenceInterval != null ? Math.floor(Number(recurrenceInterval) || 0) : null,
    recurrenceUnit ? String(recurrenceUnit).slice(0, 20) : null,
    recurrenceEndDate ? String(recurrenceEndDate).slice(0, 30) : null
  );
  return taskId;
}

export function listScheduledTasks({ status, limit = 100 } = {}) {
  if (!dbInstance) return [];
  if (status) {
    const stmt = dbInstance.prepare(
      `SELECT * FROM scheduled_tasks WHERE status = ? ORDER BY scheduled_at ASC LIMIT ?`
    );
    return stmt.all(String(status), limit);
  }
  const stmt = dbInstance.prepare(
    `SELECT * FROM scheduled_tasks ORDER BY scheduled_at DESC LIMIT ?`
  );
  return stmt.all(limit);
}

export function getScheduledTask(id) {
  if (!dbInstance || !id) return null;
  const stmt = dbInstance.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`);
  return stmt.get(String(id)) || null;
}

export function updateScheduledTask(id, fields) {
  if (!dbInstance || !id) return false;
  const allowed = ['status', 'completed_at', 'result_excerpt', 'scheduled_at'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(fields[k] == null ? null : String(fields[k]).slice(0, k === 'result_excerpt' ? 2000 : 500));
    }
  }
  if (sets.length === 0) return false;
  vals.push(String(id));
  const stmt = dbInstance.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`);
  stmt.run(...vals);
  return true;
}

export function deleteScheduledTask(id) {
  if (!dbInstance || !id) return false;
  const stmt = dbInstance.prepare(`DELETE FROM scheduled_tasks WHERE id = ? AND status IN ('pending', 'cancelled')`);
  stmt.run(String(id));
  return true;
}

export function getDuePendingScheduledTasks(limit = 5) {
  if (!dbInstance) return [];
  const now = new Date().toISOString();
  const stmt = dbInstance.prepare(
    `SELECT * FROM scheduled_tasks WHERE status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at ASC LIMIT ?`
  );
  return stmt.all(now, limit);
}

export function isSchedulerPaused() {
  if (!dbInstance) return false;
  try {
    const stmt = dbInstance.prepare(
      `SELECT id FROM scheduled_tasks WHERE task_type = '__scheduler_pause_flag' AND status = 'paused' LIMIT 1`
    );
    return !!stmt.get();
  } catch {
    return false;
  }
}

export function setSchedulerPaused(paused) {
  if (!dbInstance) return;
  const flagId = '__scheduler_pause_flag';
  if (paused) {
    try {
      dbInstance.prepare(
        `INSERT OR REPLACE INTO scheduled_tasks (id, task_type, status, scheduled_at, created_at)
         VALUES (?, '__scheduler_pause_flag', 'paused', datetime('now'), datetime('now'))`
      ).run(flagId);
    } catch { /* ignore */ }
  } else {
    try {
      dbInstance.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(flagId);
    } catch { /* ignore */ }
  }
}

export function getLatestWorkspaceSnapshot(sessionId) {
  if (!dbInstance || !sessionId) return null;
  const stmt = dbInstance.prepare(
    `SELECT * FROM workspace_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`
  );
  const row = stmt.get(String(sessionId).slice(0, 200));
  if (!row) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(row.global_workspace_json);
  } catch {
    parsed = null;
  }
  let pipelineProgress = null;
  if (row.pipeline_progress_json) {
    try {
      pipelineProgress = JSON.parse(row.pipeline_progress_json);
    } catch {
      pipelineProgress = null;
    }
  }
  return { ...row, globalWorkspace: parsed, pipelineProgress };
}
