/**
 * Maps graph workspace session ids to primary vs mirror mind storage.
 * Registry rows may pin `mindStorageProfile` for UUID workspaces; `playground-dual-b` is always mirror.
 */
import { findGraphSessionRegistryRowRaw } from './graphPipelineSessionRegistry';
import {
  normalizeScheduledTaskMindStorageProfile,
  MIND_STORAGE_PROFILE_PRIMARY,
  MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR,
} from './mindEntityContext';

export const PLAYGROUND_GRAPH_SESSION_A = 'playground-dual-a';
export const PLAYGROUND_GRAPH_SESSION_B = 'playground-dual-b';

const GRAPH_WS_MIND_SESSIONSTORAGE_KEY = 'mybrain_graph_ws_mind_v1_';

/**
 * Sticky per-tab mind choice for a workspace (survives KV/registry lag; cleared when user switches Primary/System B URL).
 * @param {string | null | undefined} sessionId
 * @param {unknown} profile
 */
export function setGraphWorkspaceMindSessionStorage(sessionId, profile) {
  const sid = String(sessionId || '').trim();
  if (!sid || typeof sessionStorage === 'undefined') return;
  try {
    const v = normalizeScheduledTaskMindStorageProfile(profile);
    sessionStorage.setItem(GRAPH_WS_MIND_SESSIONSTORAGE_KEY + sid, v);
  } catch {
    /* private mode / quota */
  }
}

/**
 * @param {string | null | undefined} sessionId
 * @returns {typeof MIND_STORAGE_PROFILE_PRIMARY | typeof MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR | null}
 */
export function getGraphWorkspaceMindSessionStorage(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid || typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(GRAPH_WS_MIND_SESSIONSTORAGE_KEY + sid);
    if (raw == null || String(raw).trim() === '') return null;
    return normalizeScheduledTaskMindStorageProfile(raw);
  } catch {
    return null;
  }
}

/**
 * Session id in a `/graph-pipeline/mirror/:id` URL (any path prefix before `graph-pipeline` is ignored).
 * @param {string | null | undefined} pathname
 * @returns {string | null}
 */
export function graphPathMirrorSessionIdFromPathname(pathname) {
  const segments = String(pathname || '').split('/').filter(Boolean);
  const i = segments.indexOf('graph-pipeline');
  if (i < 0) return null;
  if (segments[i + 1] !== 'mirror') return null;
  const raw = segments[i + 2];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Session id for `/graph-pipeline/:sessionId` when that segment is not a reserved sub-route.
 * @param {string | null | undefined} pathname
 * @returns {string | null}
 */
export function graphPathPrimaryWorkspaceSessionIdFromPathname(pathname) {
  const segments = String(pathname || '').split('/').filter(Boolean);
  const i = segments.indexOf('graph-pipeline');
  if (i < 0) return null;
  const seg = segments[i + 1];
  if (!seg || seg === 'mirror' || seg === 'scheduled' || seg === 'run') return null;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * @param {string | null | undefined} sessionId
 * @returns {typeof MIND_STORAGE_PROFILE_PRIMARY | typeof MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR}
 */
export function inferMindStorageProfileFromGraphSessionId(sessionId) {
  const s = String(sessionId || '').trim();
  if (s === PLAYGROUND_GRAPH_SESSION_B) return MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR;
  return MIND_STORAGE_PROFILE_PRIMARY;
}

/**
 * Registry-backed profile for arbitrary session ids; `playground-dual-b` always uses mirror.
 * @param {string | null | undefined} sessionId
 * @returns {typeof MIND_STORAGE_PROFILE_PRIMARY | typeof MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR}
 */
export function resolveGraphSessionMindStorageProfile(sessionId) {
  const sid = String(sessionId || '').trim();
  if (sid === PLAYGROUND_GRAPH_SESSION_B) return MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR;
  const row = findGraphSessionRegistryRowRaw(sid);
  if (row && row.mindStorageProfile != null && String(row.mindStorageProfile).trim() !== '') {
    return normalizeScheduledTaskMindStorageProfile(row.mindStorageProfile);
  }
  return inferMindStorageProfileFromGraphSessionId(sid);
}

/**
 * Mind store for an in-flight graph run: URL `/graph-pipeline/mirror/:id` forces System B when it matches
 * `sessionId` (registry/KV can lag after “New workspace” or IndexedDB bootstrap).
 * @param {string | null | undefined} sessionId - bound graph session (e.g. {@link getGraphPipelineSessionId})
 * @param {string | null | undefined} pathname - `location.pathname`
 * @returns {typeof MIND_STORAGE_PROFILE_PRIMARY | typeof MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR}
 */
export function graphPipelineWorkspaceMindProfileFromLocation(sessionId, pathname) {
  const sid = String(sessionId || '').trim();
  const p = String(pathname || '');
  if (!sid) return MIND_STORAGE_PROFILE_PRIMARY;
  if (sid === PLAYGROUND_GRAPH_SESSION_B) return MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR;

  const mirrorPathSid = graphPathMirrorSessionIdFromPathname(p);
  if (mirrorPathSid && mirrorPathSid === sid) return MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR;

  const primaryPathSid = graphPathPrimaryWorkspaceSessionIdFromPathname(p);
  if (primaryPathSid && primaryPathSid === sid && sid !== PLAYGROUND_GRAPH_SESSION_B) {
    return MIND_STORAGE_PROFILE_PRIMARY;
  }

  const remembered = getGraphWorkspaceMindSessionStorage(sid);
  if (remembered != null) return remembered;

  return resolveGraphSessionMindStorageProfile(sid);
}

/**
 * Options for {@link startConsciousnessStreamRun} when resuming from checkpoint or reconnect.
 * @param {string | null | undefined} sessionId
 */
export function graphResumeStreamOptsForSession(sessionId) {
  const s = String(sessionId || '').trim();
  const mindStorageProfile = resolveGraphSessionMindStorageProfile(s);
  if (s === PLAYGROUND_GRAPH_SESSION_A || s === PLAYGROUND_GRAPH_SESSION_B) {
    return { mindStorageProfile, playgroundSystemChatMetacognition: true };
  }
  return { mindStorageProfile };
}

/**
 * Canonical URL for a graph workspace. UUID (and similar) mirror workspaces use `/graph-pipeline/mirror/:id` so
 * MindScope “System B” and the session registry agree; dual-playground sessions keep stable `/graph-pipeline/:id` URLs.
 * @param {string | null | undefined} sessionId
 * @returns {string}
 */
export function graphPipelineWorkspaceHref(sessionId) {
  const raw = String(sessionId || '').trim();
  if (!raw) return '/graph-pipeline';
  const enc = encodeURIComponent(raw);
  if (raw === PLAYGROUND_GRAPH_SESSION_A || raw === PLAYGROUND_GRAPH_SESSION_B) {
    return `/graph-pipeline/${enc}`;
  }
  if (resolveGraphSessionMindStorageProfile(raw) === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR) {
    return `/graph-pipeline/mirror/${enc}`;
  }
  return `/graph-pipeline/${enc}`;
}
