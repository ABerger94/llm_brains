/**
 * Mind archive export/import: IndexedDB KV + entity records.
 *
 * **v3 (current):** UTF-8 NDJSON — one JSON value per line. No giant nested array to truncate mid-file.
 * **v2 (import):** legacy single JSON object with `keys` + `records` array.
 * **v1 (import):** legacy flat `keys` only.
 */

import { notifyMindStorageChanged } from './mindStorageEvents';
import {
  ENTITY_TYPE_NAMES,
  flushKvWrites,
  idbBulkPutKv,
  idbBulkPutRecords,
  idbClearAllKv,
  idbClearAllRecords,
  idbFetchRecordRowBatch,
  idbForEachRecordRow,
  idbForEachRecordRowBatched,
  idbGetAllRecordRows,
  hydrateKvCacheFromImport,
  snapshotKvCache,
} from './browserStorage';
import { wipeMybrainOpfsSubtree } from './opfsStorage';
import { afterMindArchiveImport } from './mindArchiveImportSideEffects';
import { sanitizeImportedEntityRecords } from './mindArchiveImportSanitize';
import { sanitizeGraphPipelineRelatedKvEntries } from './graphPipelineImportKvSanitize';
import { pipelineJsonReplacer } from './safeJsonStringify';
import { isIOSDevice } from './mobilePlatform';

const MIND_ARCHIVE_JSON_MAX_DEPTH = 64;

/** Yield while parsing NDJSON so mobile WebKit can paint and progress UI can update. */
const NDJSON_PARSE_YIELD_EVERY = 300;

/**
 * @typedef {'decoding' | 'parsing' | 'saving'} MindArchiveImportPhase
 * @typedef {(phase: MindArchiveImportPhase, detail?: { lines?: number }) => void} MindArchiveImportOnProgress
 */

function notifyImportProgress(onProgress, phase, detail) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(phase, detail);
  } catch {
    /* ignore */
  }
}

function yieldToMain() {
  return new Promise((r) => {
    setTimeout(r, 0);
  });
}

async function yieldBurst(n = 2) {
  for (let i = 0; i < n; i += 1) {
    await yieldToMain();
  }
}

function sanitizeForMindArchiveJson(value, depth = 0, seen = new WeakMap()) {
  if (depth > MIND_ARCHIVE_JSON_MAX_DEPTH) return '[Max depth]';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'symbol') return String(value);
    return value;
  }
  if (seen.has(value)) return '[Circular]';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (let i = 0; i < value.length; i += 1) {
      out[i] = sanitizeForMindArchiveJson(value[i], depth + 1, seen);
    }
    return out;
  }
  const out = {};
  seen.set(value, out);
  for (const k of Object.keys(value)) {
    try {
      out[k] = sanitizeForMindArchiveJson(value[k], depth + 1, seen);
    } catch {
      out[k] = '[Error]';
    }
  }
  return out;
}

export const MIND_ARCHIVE_FORMAT = 'mybrain-mind-archive';
/** Current on-disk format (NDJSON lines). */
export const MIND_ARCHIVE_VERSION = 3;
/** Legacy single-JSON archive with `keys` + `records`. */
export const MIND_ARCHIVE_VERSION_V2 = 2;
export const MIND_ARCHIVE_VERSION_LEGACY = 1;

const NDJSON_KIND = 'ndjson';

function isSensitiveStorageKey(key) {
  if (!key || typeof key !== 'string') return true;
  const k = key.toLowerCase();
  if (k.includes('access_token')) return true;
  if (k === 'token') return true;
  return false;
}

function isWritableArchiveKey(key) {
  if (!key || typeof key !== 'string' || isSensitiveStorageKey(key)) return false;
  if (key.startsWith('mybrain_')) return !isEntityMybrainKey(key);
  if (key.startsWith('yourbrain_')) return !isEntityYourbrainKey(key);
  if (key.startsWith('my_brain_')) return true;
  if (key === 'your_brain_user') return true;
  return false;
}

const ENTITY_SET = new Set(ENTITY_TYPE_NAMES);
const MYBRAIN_PREFIX = 'mybrain_';
const YOURBRAIN_PREFIX = 'yourbrain_';

function entityTypeFromMybrainKey(key) {
  if (!key.startsWith(MYBRAIN_PREFIX)) return null;
  const t = key.slice(MYBRAIN_PREFIX.length);
  return ENTITY_SET.has(t) ? t : null;
}

function entityTypeFromYourbrainKey(key) {
  if (!key.startsWith(YOURBRAIN_PREFIX)) return null;
  const t = key.slice(YOURBRAIN_PREFIX.length);
  return ENTITY_SET.has(t) ? t : null;
}

function isEntityMybrainKey(key) {
  return entityTypeFromMybrainKey(key) !== null;
}

function isEntityYourbrainKey(key) {
  return entityTypeFromYourbrainKey(key) !== null;
}

function entityTypeFromLegacyFlatKey(key) {
  return entityTypeFromMybrainKey(key) ?? entityTypeFromYourbrainKey(key);
}

function collectMindArchiveKeys(includeAppPrefs) {
  const kv = snapshotKvCache();
  const keys = {};
  for (const [k, v] of Object.entries(kv)) {
    if (typeof v !== 'string') continue;
    if (k.startsWith('mybrain_')) {
      if (isEntityMybrainKey(k)) continue;
      keys[k] = v;
    } else if (k.startsWith('yourbrain_')) {
      if (isEntityYourbrainKey(k)) continue;
      keys[k] = v;
    } else if (
      includeAppPrefs &&
      (k.startsWith('my_brain_') || k === 'your_brain_user') &&
      !isSensitiveStorageKey(k)
    ) {
      keys[k] = v;
    }
  }
  return keys;
}

function stringifyRecordRow(row) {
  try {
    return JSON.stringify(row, pipelineJsonReplacer);
  } catch {
    return JSON.stringify(sanitizeForMindArchiveJson(row), pipelineJsonReplacer);
  }
}

function lineKv(k, v) {
  return `${JSON.stringify({ t: 'kv', k, v })}\n`;
}

function lineRec(row) {
  return `${JSON.stringify(
    { t: 'rec', id: row.id, entityType: row.entityType, value: row.value },
    pipelineJsonReplacer
  )}\n`;
}

function buildNdjsonHeaderLine() {
  return `${JSON.stringify({
    format: MIND_ARCHIVE_FORMAT,
    version: MIND_ARCHIVE_VERSION,
    kind: NDJSON_KIND,
    exportedAt: new Date().toISOString(),
    origin: typeof window !== 'undefined' ? window.location.origin : undefined,
  })}\n`;
}

/**
 * @param {Record<string, string>} keys
 * @param {{ lowMemory?: boolean }} opts
 */
async function buildMindArchiveNdjsonBlob(keys, opts = {}) {
  const { lowMemory = false } = opts;
  const flushAt = lowMemory ? 48_000 : 1_500_000;
  const parts = [];
  let buf = buildNdjsonHeaderLine();
  for (const [k, v] of Object.entries(keys)) {
    buf += lineKv(k, v);
    if (buf.length >= flushAt) {
      parts.push(buf);
      buf = '';
    }
  }
  const appendRow = (row) => {
    buf += lineRec(row);
    if (buf.length >= flushAt) {
      parts.push(buf);
      buf = '';
    }
  };
  if (lowMemory) {
    await idbForEachRecordRowBatched(appendRow, {
      batchSize: 15,
      onAfterBatch: yieldToMain,
    });
  } else {
    await idbForEachRecordRow(appendRow);
  }
  if (buf) parts.push(buf);
  await yieldBurst(lowMemory ? 2 : 1);
  return new Blob(parts, { type: 'application/json' });
}

/**
 * @returns {Promise<boolean>}
 */
async function tryWriteMindArchiveNdjsonFilePicker(keys, filename) {
  if (typeof window === 'undefined' || typeof window.showSaveFilePicker !== 'function') {
    return false;
  }
  let writable;
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: 'Mind backup (JSON lines)', accept: { 'application/json': ['.json'] } }],
    });
    writable = await handle.createWritable();
  } catch (e) {
    if (e && typeof e === 'object' && e.name === 'AbortError') throw e;
    console.warn('[mindBackup] showSaveFilePicker failed', e);
    return false;
  }

  await writable.write(buildNdjsonHeaderLine());
  for (const [k, v] of Object.entries(keys)) {
    await writable.write(lineKv(k, v));
  }
  const pending = [];
  await idbForEachRecordRow((row) => {
    pending.push(lineRec(row));
  });
  const chunkSize = 64;
  for (let i = 0; i < pending.length; i += chunkSize) {
    await writable.write(pending.slice(i, i + chunkSize).join(''));
  }
  await writable.close();
  return true;
}

async function* genNdjsonUtf8Chunks(keys, batchSize) {
  const enc = new TextEncoder();
  yield enc.encode(buildNdjsonHeaderLine());
  for (const [k, v] of Object.entries(keys)) {
    yield enc.encode(lineKv(k, v));
  }
  let after = null;
  while (true) {
    const { rows, hasMore } = await idbFetchRecordRowBatch(after, batchSize);
    if (rows.length === 0) return;
    for (const row of rows) {
      yield enc.encode(lineRec(row));
    }
    const last = rows[rows.length - 1];
    after = typeof last.id === 'string' ? last.id : String(last.id);
    await yieldToMain();
    if (!hasMore) return;
  }
}

function utf8AsyncGeneratorToReadableStream(generator) {
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await generator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
}

async function tryBuildNdjsonStreamBlob(keys, { gzip, batchSize }) {
  const iter = genNdjsonUtf8Chunks(keys, batchSize);
  const stream = utf8AsyncGeneratorToReadableStream(iter);
  if (gzip) {
    if (typeof CompressionStream === 'undefined') return null;
    const compressed = stream.pipeThrough(new CompressionStream('gzip'));
    const blob = await new Response(compressed).blob();
    return { blob, filename: suggestedMindArchiveFilenameGzip() };
  }
  const blob = await new Response(stream).blob();
  return { blob, filename: suggestedMindArchiveFilename() };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function suggestedMindArchiveFilename() {
  const d = new Date();
  return `mybrain-mind-backup-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}.json`;
}

export function suggestedMindArchiveFilenameGzip() {
  const d = new Date();
  return `mybrain-mind-backup-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}.json.gz`;
}

/**
 * @param {{ includeAppPrefs?: boolean }} [options]
 */
export async function buildMindArchiveObject(options = {}) {
  const { includeAppPrefs = false } = options;
  const keys = collectMindArchiveKeys(includeAppPrefs);
  const records = await idbGetAllRecordRows();
  return {
    format: MIND_ARCHIVE_FORMAT,
    version: MIND_ARCHIVE_VERSION,
    kind: NDJSON_KIND,
    exportedAt: new Date().toISOString(),
    origin: typeof window !== 'undefined' ? window.location.origin : undefined,
    keys,
    records,
  };
}

/**
 * @returns {Promise<
 *   | { kind: 'file'; filename: string }
 *   | { kind: 'blob'; blob: Blob; filename: string }
 * >}
 */
export async function buildMindArchiveBlob(options = {}) {
  if (typeof window === 'undefined') {
    throw new Error('Mind export requires a browser environment');
  }
  const { includeAppPrefs = false, skipFilePicker = false } = options;
  const lowMemory = isIOSDevice();
  await yieldBurst(lowMemory ? 1 : 2);
  const keys = collectMindArchiveKeys(includeAppPrefs);
  await yieldToMain();

  const filename = suggestedMindArchiveFilename();

  try {
    if (!lowMemory && !skipFilePicker) {
      const saved = await tryWriteMindArchiveNdjsonFilePicker(keys, filename);
      if (saved) return { kind: 'file', filename };
    }
  } catch (e) {
    if (e && typeof e === 'object' && e.name === 'AbortError') throw e;
    console.warn('[mindBackup] file picker export failed, using blob', e);
  }

  if (lowMemory) {
    try {
      let streamed = await tryBuildNdjsonStreamBlob(keys, { gzip: true, batchSize: 15 });
      if (!streamed) streamed = await tryBuildNdjsonStreamBlob(keys, { gzip: false, batchSize: 15 });
      if (streamed) {
        await yieldBurst(2);
        return { kind: 'blob', blob: streamed.blob, filename: streamed.filename };
      }
    } catch (e) {
      console.warn('[mindBackup] streaming NDJSON failed, using segmented blob', e);
    }
    const blob = await buildMindArchiveNdjsonBlob(keys, { lowMemory: true });
    return { kind: 'blob', blob, filename: suggestedMindArchiveFilename() };
  }

  const blob = await buildMindArchiveNdjsonBlob(keys, { lowMemory: false });
  return { kind: 'blob', blob, filename };
}

// --- import ---

function isGzipBytes(u8) {
  return u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
}

function decodeBinaryToUtf8String(u8) {
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: false }).decode(u8);
  }
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) {
    return new TextDecoder('utf-16be', { fatal: false }).decode(u8);
  }
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    return new TextDecoder('utf-8', { fatal: false }).decode(u8.subarray(3));
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(u8);
}

function normalizeDecodedText(text) {
  let t = String(text ?? '');
  t = t.replace(/^\uFEFF+/, '');
  t = t.replace(/\0+$/, '');
  return t;
}

/**
 * @param {string | ArrayBuffer | Uint8Array} input
 * @param {MindArchiveImportOnProgress} [onProgress]
 * @returns {Promise<string>}
 */
async function decodeArchiveInputToText(input, onProgress) {
  notifyImportProgress(onProgress, 'decoding');
  if (typeof input === 'string') {
    return normalizeDecodedText(input);
  }
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.length === 0) {
    throw new Error('Backup file is empty (0 bytes).');
  }
  if (isGzipBytes(u8)) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error(
        'Gzip backups need DecompressionStream (Safari 16.4+). Use a plain .json export or decompress first.'
      );
    }
    const out = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    return normalizeDecodedText(await new Response(out).text());
  }
  return normalizeDecodedText(decodeBinaryToUtf8String(u8));
}

function splitNonEmptyLines(text) {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

async function partitionLegacyFlatKeys(rawKeys) {
  const recordRows = [];
  const kvEntries = {};
  for (const [k, v] of Object.entries(rawKeys)) {
    if (typeof v !== 'string') continue;
    const et = entityTypeFromLegacyFlatKey(k);
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
        /* kv */
      }
    }
    kvEntries[k] = v;
  }
  return { recordRows, kvEntries };
}

async function applyArchivePayloadToIndexedDb({ kvEntries, recordRows, ver }) {
  await flushKvWrites();
  await idbClearAllRecords();
  await idbClearAllKv();
  const sanitizedKv = sanitizeGraphPipelineRelatedKvEntries(kvEntries);
  await idbBulkPutKv(sanitizedKv);
  hydrateKvCacheFromImport(sanitizedKv);
  const sanitized = sanitizeImportedEntityRecords(recordRows);
  if (sanitized.length) await idbBulkPutRecords(sanitized);
  afterMindArchiveImport();
  notifyMindStorageChanged({ source: 'mind-archive-import' });
  const keyCount =
    ver === MIND_ARCHIVE_VERSION || ver === MIND_ARCHIVE_VERSION_V2
      ? Object.keys(kvEntries).length + recordRows.length
      : Object.keys(kvEntries).length;
  return { ok: true, keyCount };
}

/**
 * @param {string[]} lines
 * @param {MindArchiveImportOnProgress} [onProgress]
 */
async function importNdjsonLines(lines, onProgress) {
  notifyImportProgress(onProgress, 'parsing', { lines: 0 });
  if (lines.length < 2) {
    return { ok: false, error: 'NDJSON backup is incomplete (expected a header line plus KV/record lines).' };
  }
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch (e) {
    return { ok: false, error: `Invalid header line: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!header || header.format !== MIND_ARCHIVE_FORMAT || header.kind !== NDJSON_KIND) {
    return { ok: false, error: 'Not a valid NDJSON mind archive header.' };
  }
  if (Number(header.version) !== MIND_ARCHIVE_VERSION) {
    return { ok: false, error: `Unsupported NDJSON archive version: ${header.version}` };
  }

  /** @type {Record<string, string>} */
  const kvEntries = {};
  /** @type {Array<{ id: string, entityType: string, value: object }>} */
  const recordRows = [];

  const totalLines = lines.length - 1;
  for (let i = 1; i < lines.length; i += 1) {
    if (i > 1 && (i - 1) % NDJSON_PARSE_YIELD_EVERY === 0) {
      notifyImportProgress(onProgress, 'parsing', { lines: i });
      await yieldToMain();
    }
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch (e) {
      return {
        ok: false,
        error: `Invalid JSON on line ${i + 1}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (!row || typeof row !== 'object') continue;
    if (row.t === 'kv' && typeof row.k === 'string' && typeof row.v === 'string') {
      if (isWritableArchiveKey(row.k)) kvEntries[row.k] = row.v;
    } else if (
      row.t === 'rec' &&
      typeof row.id === 'string' &&
      typeof row.entityType === 'string' &&
      row.value &&
      typeof row.value === 'object'
    ) {
      recordRows.push({ id: row.id, entityType: row.entityType, value: row.value });
    }
  }
  notifyImportProgress(onProgress, 'parsing', { lines: totalLines });

  if (Object.keys(kvEntries).length === 0 && recordRows.length === 0) {
    return { ok: false, error: 'No importable KV or record rows in this file.' };
  }

  try {
    return await applyArchivePayloadToIndexedDb({
      kvEntries,
      recordRows,
      ver: MIND_ARCHIVE_VERSION,
      onProgress,
    });
  } catch (e) {
    return { ok: false, error: formatMindImportIndexedDbError(e) };
  }
}

/**
 * @param {object} parsed
 * @param {MindArchiveImportOnProgress} [onProgress]
 */
async function importLegacyV2Object(parsed, onProgress) {
  notifyImportProgress(onProgress, 'parsing');
  const ver = Number(parsed.version);
  if (ver === MIND_ARCHIVE_VERSION_V2) {
    const rawKeys = parsed.keys;
    const records = Array.isArray(parsed.records) ? parsed.records : [];
    if (!rawKeys || typeof rawKeys !== 'object' || Array.isArray(rawKeys)) {
      return { ok: false, error: 'Invalid archive: missing or invalid keys' };
    }
    const kvEntries = Object.fromEntries(
      Object.entries(rawKeys).filter(([k, v]) => isWritableArchiveKey(k) && typeof v === 'string')
    );
    const recordRows = records.filter(
      (r) =>
        r &&
        typeof r === 'object' &&
        typeof r.id === 'string' &&
        typeof r.entityType === 'string' &&
        r.value &&
        typeof r.value === 'object'
    );
    if (Object.keys(kvEntries).length === 0 && recordRows.length === 0) {
      return { ok: false, error: 'No valid data to import' };
    }
    try {
      return await applyArchivePayloadToIndexedDb({
        kvEntries,
        recordRows,
        ver: MIND_ARCHIVE_VERSION_V2,
        onProgress,
      });
    } catch (e) {
      return { ok: false, error: formatMindImportIndexedDbError(e) };
    }
  }

  if (ver === MIND_ARCHIVE_VERSION_LEGACY) {
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
    try {
      return await applyArchivePayloadToIndexedDb({
        kvEntries,
        recordRows,
        ver: MIND_ARCHIVE_VERSION_LEGACY,
        onProgress,
      });
    } catch (e) {
      return { ok: false, error: formatMindImportIndexedDbError(e) };
    }
  }

  return { ok: false, error: `Unsupported archive version: ${parsed.version}` };
}

function looksLikeUtf16LeMisdecodedAsUtf8(t) {
  const head = t.slice(0, 200);
  const nulls = (head.match(/\0/g) || []).length;
  if (nulls < 4) return false;
  return /^\s*\{/.test(t);
}

/**
 * @param {string} text
 * @param {Uint8Array | null} u8
 */
function tryParseLegacyFullJson(text, u8) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && parsed.format === MIND_ARCHIVE_FORMAT) {
      return { ok: true, parsed };
    }
    return { ok: false, error: 'Not a MetaSelf-CognitiveStack mind archive (wrong format)' };
  } catch (e1) {
    if (u8 && !isGzipBytes(u8) && looksLikeUtf16LeMisdecodedAsUtf8(text)) {
      try {
        const alt = normalizeDecodedText(new TextDecoder('utf-16le', { fatal: false }).decode(u8));
        const parsed = JSON.parse(alt);
        if (parsed && typeof parsed === 'object' && parsed.format === MIND_ARCHIVE_FORMAT) {
          return { ok: true, parsed };
        }
      } catch {
        /* fall through */
      }
    }
    const msg = e1 instanceof SyntaxError ? e1.message : String(e1);
    const preview = text.trim().slice(0, 200).replace(/\s+/g, ' ');
    return {
      ok: false,
      error: `Could not read legacy JSON backup (${msg}). Preview: ${preview}${text.length > 200 ? '…' : ''}`,
    };
  }
}

/**
 * @param {string | ArrayBuffer | Uint8Array} input
 * @param {{ onProgress?: MindArchiveImportOnProgress }} [options]
 * @returns {Promise<{ ok: true, keyCount: number } | { ok: false, error: string }>}
 */
export async function importMindArchive(input, options = {}) {
  const { onProgress } = options;
  let u8 = null;
  if (typeof input !== 'string') {
    u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  }

  let text;
  try {
    text = await decodeArchiveInputToText(input, onProgress);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const trimmed = text.trim();
  if (!trimmed.length) {
    return {
      ok: false,
      error:
        'Backup file has no readable content. Pick a non-empty .json (or .json.gz) mind backup, or export again from Dashboard.',
    };
  }

  if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
    try {
      await navigator.storage.persist();
    } catch {
      /* ignore */
    }
  }

  const lines = splitNonEmptyLines(text);

  /** NDJSON v3: first line is header with version 3 + kind ndjson */
  if (lines.length >= 1) {
    try {
      const head = JSON.parse(lines[0]);
      if (
        head &&
        head.format === MIND_ARCHIVE_FORMAT &&
        Number(head.version) === MIND_ARCHIVE_VERSION &&
        head.kind === NDJSON_KIND
      ) {
        return await importNdjsonLines(lines, onProgress);
      }
    } catch {
      /* try legacy */
    }
  }

  /** Single-line v2 / minified */
  if (lines.length === 1) {
    try {
      const parsed = JSON.parse(lines[0]);
      if (parsed && parsed.format === MIND_ARCHIVE_FORMAT) {
        const r = await importLegacyV2Object(parsed, onProgress);
        return r;
      }
    } catch {
      /* fall through to full-text legacy */
    }
  }

  /** Multi-line legacy (pretty-printed single JSON) */
  const legacy = tryParseLegacyFullJson(text, u8);
  if (!legacy.ok) {
    return { ok: false, error: legacy.error || 'Import failed' };
  }
  const r = await importLegacyV2Object(legacy.parsed, onProgress);
  return r;
}

function formatMindImportIndexedDbError(e) {
  if (e?.name === 'QuotaExceededError' || e?.code === 22) {
    return 'Storage quota exceeded. Free disk space or clear site data for this origin, then try again.';
  }
  const raw = e instanceof Error ? e.message : String(e);
  const name = e && typeof e === 'object' && 'name' in e ? String(/** @type {{ name?: string }} */ (e).name) : '';
  if (
    name === 'InvalidStateError' ||
    /transaction was aborted|cannot be fulfilled/i.test(raw)
  ) {
    return `${raw} IndexedDB was interrupted (often overlapping writes). Close other tabs with this app, wait a second, then try Pull / Import again.`;
  }
  if (
    name === 'DataError' ||
    /failed to write blobs/i.test(raw) ||
    /quota|storage|disk|space/i.test(raw)
  ) {
    return `${raw || 'IndexedDB write failed'} — often browser storage or disk quota. Try freeing space or clearing site data, then import again.`;
  }
  return raw || 'Failed to write IndexedDB';
}

const WIPE_PREFIXES = ['mybrain_', 'yourbrain_', 'my_brain_', 'your_brain_'];

/**
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
