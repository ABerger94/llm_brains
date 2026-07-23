/**
 * URL helpers for Primary vs System B (mirror) mind routes.
 * Mirror segment is a literal path segment `mirror` (e.g. /beliefs/mirror, /voice/mirror).
 * Dual System Chat graph sessions use ids `playground-dual-a` / `playground-dual-b`. Other mirror workspaces use
 * `/graph-pipeline/mirror/:sessionId` so MindScope matches the registry.
 * Keep in sync with {@link PLAYGROUND_GRAPH_SESSION_A} / {@link PLAYGROUND_GRAPH_SESSION_B} in `playgroundDualGraphRunner.js`
 * (avoid importing that module here — it chains `consciousnessStreamRunner`).
 */
const GRAPH_SESSION_PLAYGROUND_DUAL_A = 'playground-dual-a';
const GRAPH_SESSION_PLAYGROUND_DUAL_B = 'playground-dual-b';

/**
 * @param {string} pathname
 * @returns {boolean}
 */
export function pathnameHasMindMirror(pathname) {
  const segments = String(pathname || '')
    .split('/')
    .filter(Boolean);
  if (segments.includes('mirror')) return true;
  if (segments[0] === 'graph-pipeline' && segments[1] === GRAPH_SESSION_PLAYGROUND_DUAL_B) return true;
  return false;
}

/**
 * Strip one `/mirror` segment: /beliefs/mirror -> /beliefs, /graph-pipeline/mirror/x -> /graph-pipeline/x
 * @param {string} pathname
 * @returns {string}
 */
export function mirrorToPrimaryPath(pathname) {
  const p = String(pathname || '') || '/';
  const seg = p.split('/').filter(Boolean);
  if (seg[0] === 'graph-pipeline' && seg[1] === GRAPH_SESSION_PLAYGROUND_DUAL_B) {
    return `/graph-pipeline/${GRAPH_SESSION_PLAYGROUND_DUAL_A}`;
  }
  const m = p.match(/^(.+?)\/mirror(?:\/(.*))?$/);
  if (!m) return p;
  const base = m[1];
  const rest = m[2];
  return rest ? `${base}/${rest}` : base;
}

/**
 * System B tab target for `/playground` (dual System Chat). There is no `/playground/mirror` route — that path
 * used to fall through to `*` and eject the user to `/`, breaking an in-flight dual pipeline.
 */
export const PLAYGROUND_MIRROR_TAB_FALLBACK = '/voice/mirror';

/** No `/mirror` root route — use a real mirror hub so MindScope tab does not hit `*` → `/`. */
export const ROOT_MIRROR_TAB_FALLBACK = '/beliefs/mirror';

export function primaryToMirrorPath(pathname) {
  const p = String(pathname || '') || '/';
  if (p.split('/').filter(Boolean).includes('mirror')) return p;
  const parts = p.split('/').filter(Boolean);
  /** Dual-graph System A workspace → System B (mirror) graph session. */
  if (parts[0] === 'graph-pipeline' && parts[1] === GRAPH_SESSION_PLAYGROUND_DUAL_A) {
    return `/graph-pipeline/${GRAPH_SESSION_PLAYGROUND_DUAL_B}`;
  }
  /** Dual chat runs both minds in one UI; link System B tab to mirror Voice hub instead of `/playground/mirror`. */
  if (parts[0] === 'playground') {
    return PLAYGROUND_MIRROR_TAB_FALLBACK;
  }
  /**
   * Graph workspaces: `/graph-pipeline/:sessionId` ↔ `/graph-pipeline/mirror/:sessionId` (see App.jsx).
   * Scheduled / legacy run paths still jump to the mirror hub only.
   */
  if (parts[0] === 'graph-pipeline' && parts.length > 1 && parts[1] !== 'mirror') {
    const seg = parts[1];
    if (seg === 'scheduled' || seg === 'run') {
      return '/graph-pipeline/mirror';
    }
    const tail = parts.slice(1).join('/');
    return `/graph-pipeline/mirror/${encodeURIComponent(tail)}`;
  }
  if (parts.length === 0) return ROOT_MIRROR_TAB_FALLBACK;
  return `/${parts[0]}/mirror${parts.length > 1 ? `/${parts.slice(1).join('/')}` : ''}`;
}
