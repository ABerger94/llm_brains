/**
 * IndexedDB persistence for MyBrain: KV strings + per-entity records.
 * In-memory KV cache enables sync reads after bootstrap (see main.jsx).
 */

import { openDB } from 'idb';

export const DB_NAME = 'mybrain_db';
export const DB_VERSION = 1;

const STORAGE_KEY_PREFIX = 'mybrain_';
const LEGACY_ENTITY_PREFIX = 'yourbrain_';
const LEGACY_ENTITY_PREFIX_LEN = LEGACY_ENTITY_PREFIX.length;

/** Entity types stored as JSON arrays under mybrain_<Name> in legacy localStorage. */
export const ENTITY_TYPE_NAMES = [
  'LongTermMemory',
  'BeliefStore',
  'PipelineRun',
  'MindBiography',
  'WorldModel',
  'CuriosityItem',
  'GoalItem',
  'TemporalEvent',
  'ScheduledTask',
  'Dataset',
  'ExecutionLog',
  'ConversationMessage',
  'FeedbackItem',
  'TrainingRun',
  'DreamRun',
  'EmergenceEvent',
  'SelfLedgerRevision',
  'BeliefTension',
  'UserModelSnapshot',
  'ConsolidationDigest',
];

const ENTITY_TYPES = new Set(ENTITY_TYPE_NAMES);

const KV_PREFIXES = [STORAGE_KEY_PREFIX, LEGACY_ENTITY_PREFIX, 'my_brain_', 'your_brain_'];

/** @type {import('idb').IDBPDatabase | null} */
let dbInstance = null;

/** @type {Map<string, string>} */
const kvCache = new Map();

/** @type {Set<string>} */
const kvDirtyPuts = new Set();

/** @type {Set<string>} */
const kvDirtyDeletes = new Set();

let kvFlushTimer = null;
let kvFlushChain = Promise.resolve();

function isEntityStorageKey(key) {
  if (!key || typeof key !== 'string') return false;
  if (key.startsWith(STORAGE_KEY_PREFIX)) {
    return ENTITY_TYPES.has(key.slice(STORAGE_KEY_PREFIX.length));
  }
  if (key.startsWith(LEGACY_ENTITY_PREFIX)) {
    return ENTITY_TYPES.has(key.slice(LEGACY_ENTITY_PREFIX_LEN));
  }
  return false;
}

function entityTypeFromStorageKey(key) {
  if (key.startsWith(STORAGE_KEY_PREFIX)) return key.slice(STORAGE_KEY_PREFIX.length);
  return key.slice(LEGACY_ENTITY_PREFIX_LEN);
}

function shouldMigrateLocalStorageKey(key) {
  if (!key) return false;
  return KV_PREFIXES.some((p) => key.startsWith(p));
}

function scheduleKvFlush() {
  if (kvFlushTimer != null) return;
  kvFlushTimer = setTimeout(() => {
    kvFlushTimer = null;
    kvFlushChain = kvFlushChain.then(() => flushKvWritesInternal()).catch((e) => {
      console.warn('[browserStorage] KV flush failed:', e);
    });
  }, 50);
}

async function flushKvWritesInternal() {
  if (!dbInstance) return;
  if (kvDirtyPuts.size === 0 && kvDirtyDeletes.size === 0) return;
  const puts = [...kvDirtyPuts];
  const dels = [...kvDirtyDeletes];
  kvDirtyPuts.clear();
  kvDirtyDeletes.clear();

  const tx = dbInstance.transaction('kv', 'readwrite');
  const store = tx.objectStore('kv');
  for (const k of dels) {
    if (typeof k !== 'string' || !k) continue;
    store.delete(k);
  }
  for (const k of puts) {
    const v = kvCache.get(k);
    if (v === undefined) store.delete(k);
    else store.put({ key: k, value: v });
  }
  await tx.done;
}

/**
 * Wait until all debounced KV writes finish. Always serializes through `kvFlushChain` so we never run
 * {@link flushKvWritesInternal} in parallel with an in-flight flush from {@link scheduleKvFlush} — overlapping
 * `readwrite` transactions on `kv` can make `clear()` fail (e.g. "unable to clear object store") during import.
 * @returns {Promise<void>}
 */
export async function flushKvWrites() {
  if (kvFlushTimer != null) {
    clearTimeout(kvFlushTimer);
    kvFlushTimer = null;
  }
  const run = kvFlushChain.catch(() => {}).then(() => flushKvWritesInternal());
  kvFlushChain = run.catch((e) => {
    console.warn('[browserStorage] KV flush failed:', e);
  });
  await run;
}

/**
 * @param {string} key
 * @returns {string | null}
 */
export function getKvSync(key) {
  if (kvCache.has(key)) return kvCache.get(key);
  return null;
}

/**
 * @param {string} key
 * @param {string} value
 */
export function setKvSync(key, value) {
  kvCache.set(key, value);
  kvDirtyDeletes.delete(key);
  kvDirtyPuts.add(key);
  scheduleKvFlush();
}

/**
 * @param {string} key
 */
export function removeKvSync(key) {
  kvCache.delete(key);
  kvDirtyPuts.delete(key);
  kvDirtyDeletes.add(key);
  scheduleKvFlush();
}

/**
 * Replace entire KV cache from DB (after import).
 * @param {Record<string, string>} entries
 */
export function replaceKvCache(entries) {
  kvCache.clear();
  kvDirtyPuts.clear();
  kvDirtyDeletes.clear();
  for (const [k, v] of Object.entries(entries)) {
    if (typeof k === 'string' && typeof v === 'string') kvCache.set(k, v);
  }
  for (const k of kvCache.keys()) kvDirtyPuts.add(k);
  scheduleKvFlush();
}

/**
 * @returns {Record<string, string>}
 */
export function snapshotKvCache() {
  return Object.fromEntries(kvCache);
}

/**
 * @returns {import('idb').IDBPDatabase}
 */
export function getDb() {
  if (!dbInstance) throw new Error('browserStorage not initialized');
  return dbInstance;
}

/**
 * Pull specific KV rows from IndexedDB into the in-memory cache (e.g. after another tab updated the DB).
 * @param {string[]} keys
 * @returns {Promise<void>}
 */
export async function kvRefreshKeysFromDb(keys) {
  if (typeof window === 'undefined' || !Array.isArray(keys) || keys.length === 0) return;
  try {
    const db = getDb();
    for (const key of keys) {
      if (typeof key !== 'string' || !key) continue;
      const row = await db.get('kv', key);
      if (row && typeof row.value === 'string') kvCache.set(key, row.value);
      else kvCache.delete(key);
    }
  } catch {
    /* ignore */
  }
}

/**
 * @param {import('idb').IDBPDatabase} db
 */
async function loadKvIntoCache(db) {
  kvCache.clear();
  const all = await db.getAll('kv');
  for (const row of all) {
    if (row && typeof row.key === 'string' && typeof row.value === 'string') {
      kvCache.set(row.key, row.value);
    }
  }
}

/**
 * @param {import('idb').IDBPDatabase} db
 */
async function migrateLocalStorageToIdb(db) {
  if (typeof window === 'undefined' || !window.localStorage) return;

  const keysSnapshot = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (k) keysSnapshot.push(k);
  }

  const keysToRemove = [];
  const entityPuts = [];

  for (const key of keysSnapshot) {
    if (!shouldMigrateLocalStorageKey(key)) continue;

    if (key === 'mybrain_storage_migrated_v1') {
      keysToRemove.push(key);
      continue;
    }

    if (isEntityStorageKey(key)) {
      const raw = localStorage.getItem(key);
      if (raw == null) continue;
      let arr;
      try {
        arr = JSON.parse(raw);
      } catch {
        keysToRemove.push(key);
        continue;
      }
      if (!Array.isArray(arr)) {
        keysToRemove.push(key);
        continue;
      }
      const entityType = entityTypeFromStorageKey(key);
      for (const item of arr) {
        if (item && typeof item === 'object' && item.id) {
          entityPuts.push({ id: String(item.id), entityType, value: item });
        }
      }
      keysToRemove.push(key);
      continue;
    }

    const raw = localStorage.getItem(key);
    if (raw === null) {
      keysToRemove.push(key);
      continue;
    }

    if (key === 'yourbrain_runtime_settings') {
      const cur = await db.get('kv', 'mybrain_runtime_settings');
      if (!cur) {
        await db.put('kv', { key: 'mybrain_runtime_settings', value: raw });
      }
      keysToRemove.push(key);
      continue;
    }

    await db.put('kv', { key, value: raw });
    keysToRemove.push(key);
  }

  if (entityPuts.length) {
    const tx = db.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    for (const row of entityPuts) {
      store.put(row);
    }
    await tx.done;
  }

  for (const k of keysToRemove) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}

export async function idbPutRecord(row) {
  const db = getDb();
  await db.put('records', row);
}

/**
 * IndexedDB rejects invalid keys (e.g. undefined); Firefox reports "Failed to delete record from object store".
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidIndexedDbRecordKey(id) {
  if (id === undefined || id === null) return false;
  return typeof id === 'string' && id.trim().length > 0;
}

/**
 * @param {unknown} id
 * @returns {Promise<boolean>} true if a delete was attempted (caller may use this for metrics)
 */
export async function idbDeleteRecord(id) {
  if (!isValidIndexedDbRecordKey(id)) {
    console.warn('[browserStorage] idbDeleteRecord skipped: invalid id', id);
    return false;
  }
  const key = String(id).trim();
  try {
    await getDb().delete('records', key);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[browserStorage] idbDeleteRecord failed', key, msg);
    throw new Error(
      `Could not delete stored record (${typeof key === 'string' ? `${key.slice(0, 36)}${key.length > 36 ? '…' : ''}` : String(key)}): ${msg}`
    );
  }
}

/**
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function idbGetRecordValue(id) {
  const row = await getDb().get('records', id);
  return row?.value ?? null;
}

/**
 * @param {string} entityType
 * @returns {Promise<object[]>}
 */
export async function idbGetAllForEntityType(entityType) {
  const db = getDb();
  const tx = db.transaction('records', 'readonly');
  const idx = tx.store.index('byEntityType');
  const rows = await idx.getAll(entityType);
  await tx.done;
  return rows.map((r) => r.value).filter(Boolean);
}

/**
 * @param {string} entityType
 */
export async function idbDeleteAllForEntityType(entityType) {
  const db = getDb();
  const tx = db.transaction('records', 'readwrite');
  const idx = tx.store.index('byEntityType');
  let cursor = await idx.openCursor(entityType);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

/**
 * @returns {Promise<void>}
 */
export async function idbClearAllRecords() {
  const db = getDb();
  const tx = db.transaction('records', 'readwrite');
  await tx.store.clear();
  await tx.done;
}

/**
 * @returns {Promise<void>}
 */
export async function idbClearAllKv() {
  const db = getDb();
  const tx = db.transaction('kv', 'readwrite');
  await tx.store.clear();
  await tx.done;
  kvCache.clear();
  kvDirtyPuts.clear();
  kvDirtyDeletes.clear();
}

/**
 * Bulk put KV (e.g. import). Caller should replace cache after.
 * @param {Record<string, string>} keys
 */
export async function idbBulkPutKv(keys) {
  const db = getDb();
  const tx = db.transaction('kv', 'readwrite');
  for (const [k, v] of Object.entries(keys)) {
    if (typeof k === 'string' && typeof v === 'string') {
      await tx.store.put({ key: k, value: v });
    }
  }
  await tx.done;
}

/**
 * Bulk put records (e.g. import).
 * @param {Array<{ id: string, entityType: string, value: object }>} rows
 */
export async function idbBulkPutRecords(rows) {
  if (!rows.length) return;
  const db = getDb();
  const tx = db.transaction('records', 'readwrite');
  for (const row of rows) {
    await tx.store.put(row);
  }
  await tx.done;
}

/**
 * @returns {Promise<Array<{ id: string, entityType: string, value: object }>>}
 */
export async function idbGetAllRecordRows() {
  const db = getDb();
  return db.getAll('records');
}

/**
 * Open DB, migrate legacy localStorage, load KV cache. Call once before importing app modules that read storage.
 * @returns {Promise<void>}
 */
export async function openAndMigrateBrowserStorage() {
  if (typeof window === 'undefined') {
    return;
  }

  dbInstance = await openDB(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        database.createObjectStore('kv', { keyPath: 'key' });
        const rec = database.createObjectStore('records', { keyPath: 'id' });
        rec.createIndex('byEntityType', 'entityType');
      }
    },
  });

  await migrateLocalStorageToIdb(dbInstance);
  await loadKvIntoCache(dbInstance);
  console.log('✅ IndexedDB browser storage ready');
}
