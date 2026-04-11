/**
 * Export / import mind state (IndexedDB KV + entity records; cross-device backup).
 */

import { notifyMindStorageChanged } from './mindStorageEvents';
import {
  ENTITY_TYPE_NAMES,
  flushKvWrites,
  idbBulkPutRecords,
  idbClearAllKv,
  idbClearAllRecords,
  idbGetAllRecordRows,
  replaceKvCache,
  snapshotKvCache,
} from './browserStorage';
import { wipeMybrainOpfsSubtree } from './opfsStorage';
import { afterMindArchiveImport } from './mindArchiveImportSideEffects';
import { sanitizeImportedEntityRecords } from './mindArchiveImportSanitize';
import { sanitizeGraphPipelineRelatedKvEntries } from './graphPipelineImportKvSanitize';

export const MIND_ARCHIVE_FORMAT = 'mybrain-mind-archive';
export const MIND_ARCHIVE_VERSION = 2;
/** Legacy flat `keys` object (v1). */
export const MIND_ARCHIVE_VERSION_LEGACY = 1;

function isSensitiveStorageKey(key) {
  if (!key || typeof key !== 'string') return true;
  const k = key.toLowerCase();
  if (k.includes('access_token')) return true;
  if (k === 'token') return true;
  return false;
}

function isWritableArchiveKey(key) {
  if (!key || typeof key !== 'string' || isSensitiveStorageKey(key)) return false;
  if (key.startsWith('mybrain_')) return true;
  if (key.startsWith('my_brain_')) return true;
  if (key === 'your_brain_user') return true;
  return false;
}

const ENTITY_SET = new Set(ENTITY_TYPE_NAMES);
const MYBRAIN_PREFIX = 'mybrain_';

function entityTypeFromMybrainKey(key) {
  if (!key.startsWith(MYBRAIN_PREFIX)) return null;
  const t = key.slice(MYBRAIN_PREFIX.length);
  return ENTITY_SET.has(t) ? t : null;
}

function isEntityMybrainKey(key) {
  return entityTypeFromMybrainKey(key) !== null;
}

/**
 * @param {{ includeAppPrefs?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function buildMindArchiveObject(options = {}) {
  const { includeAppPrefs = false } = options;
  const kv = snapshotKvCache();
  const keys = {};
  for (const [k, v] of Object.entries(kv)) {
    if (typeof v !== 'string') continue;
    if (k.startsWith('mybrain_')) {
      if (isEntityMybrainKey(k)) continue;
      keys[k] = v;
    } else if (
      includeAppPrefs &&
      (k.startsWith('my_brain_') || k === 'your_brain_user') &&
      !isSensitiveStorageKey(k)
    ) {
      keys[k] = v;
    }
  }
  const records = await idbGetAllRecordRows();
  return {
    format: MIND_ARCHIVE_FORMAT,
    version: MIND_ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    origin: typeof window !== 'undefined' ? window.location.origin : undefined,
    keys,
    records,
  };
}

export async function exportMindArchive(options = {}) {
  return JSON.stringify(await buildMindArchiveObject(options), null, 2);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function suggestedMindArchiveFilename() {
  const d = new Date();
  return `mybrain-mind-backup-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}.json`;
}

export async function buildMindArchiveBlob(options = {}) {
  const json = await exportMindArchive(options);
  const blob = new Blob([json], { type: 'application/json' });
  return { blob, filename: suggestedMindArchiveFilename() };
}

/**
 * @param {Record<string, string>} rawKeys
 * @returns {Promise<{ recordRows: Array<{ id: string, entityType: string, value: object }>, kvEntries: Record<string, string> }>}
 */
async function partitionLegacyFlatKeys(rawKeys) {
  const recordRows = [];
  const kvEntries = {};
  for (const [k, v] of Object.entries(rawKeys)) {
    if (typeof v !== 'string') continue;
    const et = entityTypeFromMybrainKey(k);
    if (et) {
      try {
        const arr = JSON.parse(v);
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (item && typeof item === 'object' && item.id) {
              recordRows.push({ id: String(item.id), entityType: et, value: item });
            }
          }
          continue;
        }
      } catch {
        /* fall through to kv */
      }
    }
    kvEntries[k] = v;
  }
  return { recordRows, kvEntries };
}

/**
 * @param {string} jsonString
 * @returns {Promise<{ ok: true, keyCount: number } | { ok: false, error: string }>}
 */
export async function importMindArchive(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Invalid archive: not an object' };
  }
  if (parsed.format !== MIND_ARCHIVE_FORMAT) {
    return { ok: false, error: 'Not a MyBrain mind archive (wrong format)' };
  }
  const ver = Number(parsed.version);
  if (!Number.isFinite(ver) || (ver !== MIND_ARCHIVE_VERSION && ver !== MIND_ARCHIVE_VERSION_LEGACY)) {
    return { ok: false, error: `Unsupported archive version: ${parsed.version}` };
  }

  try {
    if (ver === MIND_ARCHIVE_VERSION) {
      const rawKeys = parsed.keys;
      const records = Array.isArray(parsed.records) ? parsed.records : [];
      if (!rawKeys || typeof rawKeys !== 'object' || Array.isArray(rawKeys)) {
        return { ok: false, error: 'Invalid archive: missing or invalid keys' };
      }
      const kvEntries = Object.fromEntries(
        Object.entries(rawKeys).filter(([k, v]) => isWritableArchiveKey(k) && typeof v === 'string')
      );
      const rows = records.filter(
        (r) =>
          r &&
          typeof r === 'object' &&
          typeof r.id === 'string' &&
          typeof r.entityType === 'string' &&
          r.value &&
          typeof r.value === 'object'
      );
      if (Object.keys(kvEntries).length === 0 && rows.length === 0) {
        return { ok: false, error: 'No valid data to import' };
      }
      await flushKvWrites();
      await idbClearAllRecords();
      await idbClearAllKv();
      replaceKvCache(sanitizeGraphPipelineRelatedKvEntries(kvEntries));
      const sanitizedRows = sanitizeImportedEntityRecords(rows);
      if (sanitizedRows.length) await idbBulkPutRecords(sanitizedRows);
    } else {
      const rawKeys = parsed.keys;
      if (!rawKeys || typeof rawKeys !== 'object' || Array.isArray(rawKeys)) {
        return { ok: false, error: 'Invalid archive: missing or invalid keys' };
      }
      const entries = Object.entries(rawKeys).filter(([k, v]) => isWritableArchiveKey(k) && typeof v === 'string');
      if (entries.length === 0) {
        return { ok: false, error: 'No valid keys to import' };
      }
      const flat = Object.fromEntries(entries);
      const { recordRows, kvEntries } = await partitionLegacyFlatKeys(flat);
      await flushKvWrites();
      await idbClearAllRecords();
      await idbClearAllKv();
      replaceKvCache(sanitizeGraphPipelineRelatedKvEntries(kvEntries));
      const sanitizedLegacyRows = sanitizeImportedEntityRecords(recordRows);
      if (sanitizedLegacyRows.length) await idbBulkPutRecords(sanitizedLegacyRows);
    }

    await flushKvWrites();
    afterMindArchiveImport();
    notifyMindStorageChanged({ source: 'mind-archive-import' });
    const keyCount =
      ver === MIND_ARCHIVE_VERSION
        ? Object.keys(parsed.keys || {}).length + (Array.isArray(parsed.records) ? parsed.records.length : 0)
        : Object.keys(parsed.keys || {}).length;
    return { ok: true, keyCount };
  } catch (e) {
    const msg =
      e?.name === 'QuotaExceededError' || e?.code === 22
        ? 'Storage quota exceeded'
        : e?.message || 'Failed to write IndexedDB';
    return { ok: false, error: msg };
  }
}

/** Prefixes for legacy keys that may still exist in localStorage after older builds. */
const WIPE_PREFIXES = ['mybrain_', 'yourbrain_', 'my_brain_', 'your_brain_'];

/**
 * Remove all app data: IndexedDB KV + records, OPFS `mybrain/opfs`, and any remaining legacy localStorage keys.
 * @returns {Promise<{ removedKeys: string[] }>}
 */
export async function wipeAllLocalMindData() {
  if (typeof window === 'undefined') {
    return { removedKeys: [] };
  }
  await flushKvWrites();
  await idbClearAllRecords();
  await idbClearAllKv();
  await wipeMybrainOpfsSubtree();
  await flushKvWrites();

  const toRemove = [];
  if (window.localStorage) {
    const snap = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k) snap.push(k);
    }
    for (const k of snap) {
      if (WIPE_PREFIXES.some((p) => k.startsWith(p))) {
        toRemove.push(k);
      }
    }
    for (const k of toRemove) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
    }
  }
  notifyMindStorageChanged({ source: 'full-local-wipe' });
  return { removedKeys: toRemove };
}
