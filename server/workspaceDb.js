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
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {object|null} opts.globalWorkspace
 * @param {number} opts.rerunsUsed
 * @param {string} [opts.voiceOutput]
 */
export function insertWorkspaceSnapshot({ sessionId, globalWorkspace, rerunsUsed, voiceOutput = '' }) {
  if (!dbInstance || !sessionId) return null;
  const gw = globalWorkspace && typeof globalWorkspace === 'object' ? globalWorkspace : null;
  if (!gw) return null;
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const stmt = dbInstance.prepare(
    `INSERT INTO workspace_snapshots (
        id, created_at, session_id, global_workspace_json, phenomenal_unity,
        integration_confidence, provisional_stance, reruns_used, voice_output_excerpt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    voiceOutput ? clip(voiceOutput, 2000) : null
  );
  return id;
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
  return { ...row, globalWorkspace: parsed };
}
