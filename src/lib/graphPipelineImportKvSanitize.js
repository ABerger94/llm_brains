/**
 * Normalize graph / stream KV restored from a mind archive so Dashboard and cooperative pause
 * do not treat exported mid-run flags as live work. Import replaces the whole IDB — safe to run once per import.
 */

/** @see graphPipelineSessionRegistry.js */
export const GRAPH_PIPELINE_SESSIONS_REGISTRY_KEY = 'mybrain_graph_pipeline_sessions_v1';

const PREFIX_GRAPH_UI_V2 = 'mybrain_graph_pipeline_ui_v2';
const PREFIX_GRAPH_UI_V1 = 'mybrain_graph_pipeline_ui_v1';
const PREFIX_STREAM_DRAFT = 'mybrain_consciousness_stream_draft_v1';

function isGraphPipelineUiV2Key(key) {
  return key === PREFIX_GRAPH_UI_V2 || key.startsWith(`${PREFIX_GRAPH_UI_V2}__`);
}

function isGraphPipelineUiV1Key(key) {
  return key === PREFIX_GRAPH_UI_V1 || key.startsWith(`${PREFIX_GRAPH_UI_V1}__`);
}

function isConsciousnessStreamDraftKey(key) {
  return key === PREFIX_STREAM_DRAFT || key.startsWith(`${PREFIX_STREAM_DRAFT}__`);
}

function sanitizeRegistryJson(jsonString) {
  const arr = JSON.parse(jsonString);
  if (!Array.isArray(arr)) return jsonString;
  const next = arr.map((row) => {
    if (!row || typeof row !== 'object') return row;
    return { ...row, isProcessing: false };
  });
  return JSON.stringify(next);
}

function sanitizeGraphUiBlobJson(jsonString) {
  const parsed = JSON.parse(jsonString);
  if (!parsed || typeof parsed !== 'object') return jsonString;
  parsed.isRunning = false;
  parsed.uploading = false;
  parsed.cooperativePauseToken = '';
  const ms = parsed.moduleStatuses && typeof parsed.moduleStatuses === 'object' ? { ...parsed.moduleStatuses } : {};
  for (const mk of Object.keys(ms)) {
    if (ms[mk] === 'processing') delete ms[mk];
  }
  parsed.moduleStatuses = ms;
  return JSON.stringify(parsed);
}

function sanitizeStreamDraftJson(jsonString) {
  const p = JSON.parse(jsonString);
  if (!p || typeof p !== 'object') return jsonString;
  return JSON.stringify({ ...p, inFlight: false });
}

/**
 * @param {Record<string, string>} kvEntries
 * @returns {Record<string, string>}
 */
export function sanitizeGraphPipelineRelatedKvEntries(kvEntries) {
  if (!kvEntries || typeof kvEntries !== 'object') return kvEntries || {};
  const out = { ...kvEntries };
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (typeof v !== 'string') continue;
    try {
      if (key === GRAPH_PIPELINE_SESSIONS_REGISTRY_KEY) {
        out[key] = sanitizeRegistryJson(v);
        continue;
      }
      if (isGraphPipelineUiV2Key(key) || isGraphPipelineUiV1Key(key)) {
        out[key] = sanitizeGraphUiBlobJson(v);
        continue;
      }
      if (isConsciousnessStreamDraftKey(key)) {
        out[key] = sanitizeStreamDraftJson(v);
      }
    } catch {
      /* leave original string */
    }
  }
  return out;
}
