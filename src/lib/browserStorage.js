/**
 * IndexedDB persistence for MetaSelf-CognitiveStack: KV strings + per-entity records.
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

  const runTx = async () => {
    const db = getDb();
    const tx = db.transaction('kv', 'readwrite');
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
  };

  try {
    await runTx();
  } catch (e) {
    if (!isRecoverableIdbConnectionError(e)) {
      for (const k of puts) kvDirtyPuts.add(k);
      for (const k of dels) kvDirtyDeletes.add(k);
      throw e;
    }
    console.warn('[browserStorage] KV flush: reconnecting after IDB error:', e);
    await reconnectIndexedDbPreservingMemoryState();
    try {
      await runTx();
    } catch (e2) {
      for (const k of puts) kvDirtyPuts.add(k);
      for (const k of dels) kvDirtyDeletes.add(k);
      throw e2;
    }
  }
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
 * Sync in-memory KV after `idbBulkPutKv` during mind import. Do **not** use `replaceKvCache` here — it
 * schedules a debounced flush that can overlap the next `records` readwrite transaction and abort it
 * (Chrome: "The transaction was aborted, so the request cannot be fulfilled").
 * @param {Record<string, string>} entries
 */
export function hydrateKvCacheFromImport(entries) {
  kvCache.clear();
  kvDirtyPuts.clear();
  kvDirtyDeletes.clear();
  for (const [k, v] of Object.entries(entries)) {
    if (typeof k === 'string' && typeof v === 'string') kvCache.set(k, v);
  }
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

/**
 * @param {unknown} e
 * @returns {boolean}
 */
function isRecoverableIdbConnectionError(e) {
  if (!e || typeof e !== 'object') return false;
  const name = /** @type {{ name?: string }} */ (e).name || '';
  const msg = String(/** @type {{ message?: unknown }} */ (e).message || '');
  return name === 'InvalidStateError' || msg.includes('connection is closing');
}

/**
 * Close a stale IDB handle and open a new one while preserving in-memory KV cache and dirty flags
 * (so debounced graph UI / runtime settings writes are not lost).
 * @returns {Promise<void>}
 */
async function reconnectIndexedDbPreservingMemoryState() {
  if (typeof window === 'undefined') return;
  const snap = snapshotKvCache();
  const dirtyPuts = [...kvDirtyPuts];
  const dirtyDels = [...kvDirtyDeletes];
  try {
    if (dbInstance) dbInstance.close();
  } catch {
    /* ignore */
  }
  dbInstance = null;
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
  kvCache.clear();
  kvDirtyPuts.clear();
  kvDirtyDeletes.clear();
  for (const [k, v] of Object.entries(snap)) {
    if (typeof k === 'string' && typeof v === 'string') kvCache.set(k, v);
  }
  for (const k of dirtyPuts) kvDirtyPuts.add(k);
  for (const k of dirtyDels) kvDirtyDeletes.add(k);
}

export async function idbPutRecord(row) {
  try {
    const db = getDb();
    await db.put('records', row);
  } catch (e) {
    if (!isRecoverableIdbConnectionError(e)) throw e;
    console.warn('[browserStorage] idbPutRecord: reconnecting after IDB error:', e);
    await reconnectIndexedDbPreservingMemoryState();
    const db = getDb();
    await db.put('records', row);
  }
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
    if (isRecoverableIdbConnectionError(e)) {
      console.warn('[browserStorage] idbDeleteRecord: reconnecting after IDB error:', e);
      try {
        await reconnectIndexedDbPreservingMemoryState();
        await getDb().delete('records', key);
        return true;
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        console.warn('[browserStorage] idbDeleteRecord failed after reconnect', key, msg);
        throw new Error(
          `Could not delete stored record (${typeof key === 'string' ? `${key.slice(0, 36)}${key.length > 36 ? '…' : ''}` : String(key)}): ${msg}`
        );
      }
    }
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

/** Smaller transactions avoid Chrome `DataError: Failed to write blobs` on huge single writes (mobile / quota pressure). */
const IDB_BULK_PUT_RECORDS_CHUNK = 120;

/**
 * Ensure entity rows only contain structured-clone-safe JSON trees (import archives may carry odd types).
 * @param {{ id: string, entityType: string, value: object }} row
 */
function prepareRecordRowForIndexedDbPut(row) {
  const id = typeof row.id === 'string' ? row.id : String(row.id);
  const entityType = typeof row.entityType === 'string' ? row.entityType : String(row.entityType);
  let value = row.value;
  if (value != null && typeof value === 'object') {
    try {
      value = JSON.parse(JSON.stringify(value));
    } catch {
      value = Array.isArray(value) ? [] : {};
    }
  } else {
    value = {};
  }
  return { id, entityType, value };
}

/**
 * Bulk put records (e.g. import). Chunked + reconnect retry — large single transactions often fail on mobile Chrome.
 * @param {Array<{ id: string, entityType: string, value: object }>} rows
 */
export async function idbBulkPutRecords(rows) {
  if (!rows.length) return;

  const runChunks = async () => {
    for (let offset = 0; offset < rows.length; offset += IDB_BULK_PUT_RECORDS_CHUNK) {
      const slice = rows.slice(offset, offset + IDB_BULK_PUT_RECORDS_CHUNK);
      const db = getDb();
      const tx = db.transaction('records', 'readwrite');
      for (const row of slice) {
        await tx.store.put(prepareRecordRowForIndexedDbPut(row));
      }
      await tx.done;
    }
  };

  try {
    await runChunks();
  } catch (e) {
    if (!isRecoverableIdbConnectionError(e)) throw e;
    console.warn('[browserStorage] idbBulkPutRecords: reconnecting after IDB error:', e);
    await reconnectIndexedDbPreservingMemoryState();
    await runChunks();
  }
}

/**
 * O(1) count for an entity type via the `byEntityType` index (no full table load).
 * @param {string} entityType
 * @returns {Promise<number>}
 */
export async function idbCountByEntityType(entityType) {
  const db = getDb();
  const tx = db.transaction('records', 'readonly');
  const idx = tx.store.index('byEntityType');
  const n = await idx.count(IDBKeyRange.only(String(entityType)));
  await tx.done;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * @returns {Promise<Array<{ id: string, entityType: string, value: object }>>}
 */
export async function idbGetAllRecordRows() {
  const db = getDb();
  const tx = db.transaction('records', 'readonly');
  const rows = await tx.store.getAll();
  await tx.done;
  return rows;
}

/**
 * Walk every entity row without allocating a giant array (critical for mind export on iOS WebKit).
 * Callback must be synchronous: awaiting inside the loop closes the IDB transaction before
 * cursor.continue() runs ("transaction is inactive or finished").
 * @param {(row: { id: string, entityType: string, value: object }) => void} fn
 */
export async function idbForEachRecordRow(fn) {
  const db = getDb();
  const tx = db.transaction('records', 'readonly');
  let cursor = await tx.store.openCursor();
  while (cursor) {
    const row = cursor.value;
    if (row && typeof row === 'object') {
      fn(row);
    }
    cursor = await cursor.continue();
  }
  await tx.done;
}

/**
 * Same as {@link idbForEachRecordRow} but uses multiple readonly transactions so the event loop can run
 * between batches. A single huge synchronous pass (stringify per row) often crashes iOS WebKit.
 * `fn` must stay synchronous. Order follows IndexedDB key order on `id`.
 *
 * @param {(row: { id: string, entityType: string, value: object }) => void} fn
 * @param {{ batchSize?: number, onAfterBatch?: () => void | Promise<void> }} [opts]
 */
/**
 * Read up to `limit` entity rows after `afterIdExclusive` (key order). `afterIdExclusive === null` starts at the first row.
 * @param {string | null} afterIdExclusive
 * @param {number} limit
 * @returns {Promise<{ rows: Array<{ id: string, entityType: string, value: object }>, hasMore: boolean }>}
 */
export async function idbFetchRecordRowBatch(afterIdExclusive, limit) {
  const batchSize = Math.max(1, Number(limit) || 1);
  const db = getDb();
  const tx = db.transaction('records', 'readonly');
  const store = tx.store;
  const range = afterIdExclusive != null ? IDBKeyRange.lowerBound(afterIdExclusive, true) : null;
  let cursor = range ? await store.openCursor(range) : await store.openCursor();
  const rows = [];
  while (cursor && rows.length < batchSize) {
    const row = cursor.value;
    if (row && typeof row === 'object') {
      rows.push(row);
    }
    cursor = await cursor.continue();
  }
  const hasMore = cursor != null;
  await tx.done;
  return { rows, hasMore };
}

export async function idbForEachRecordRowBatched(fn, opts = {}) {
  const batchSize = Math.max(1, Number(opts.batchSize) || 100);
  const onAfterBatch = opts.onAfterBatch;
  let lastId = /** @type {string | null} */ (null);

  // Loop until a batch reads zero rows or we reach the end of the store.
  // eslint-disable-next-line no-constant-condition -- intentional pagination loop
  while (true) {
    const db = getDb();
    const tx = db.transaction('records', 'readonly');
    const store = tx.store;
    const range = lastId != null ? IDBKeyRange.lowerBound(lastId, true) : null;
    let cursor = range ? await store.openCursor(range) : await store.openCursor();
    let count = 0;
    let lastProcessedId = lastId;
    let hasMoreAfterBatch = false;

    while (cursor && count < batchSize) {
      const row = cursor.value;
      if (row && typeof row === 'object') {
        fn(row);
      }
      if (cursor.key != null && cursor.key !== '') {
        lastProcessedId = String(cursor.key);
      }
      count += 1;
      cursor = await cursor.continue();
    }
    hasMoreAfterBatch = cursor != null;
    await tx.done;

    if (count === 0) {
      break;
    }
    if (lastProcessedId == null && hasMoreAfterBatch) {
      console.warn('[browserStorage] idbForEachRecordRowBatched: missing cursor keys, stopping early');
      break;
    }
    lastId = lastProcessedId;
    if (!hasMoreAfterBatch || count < batchSize) {
      break;
    }
    if (typeof onAfterBatch === 'function') {
      await onAfterBatch();
    }
  }
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
