/**
 * Fast-fail when the browser cannot reach this app's API (offline, server down, wrong origin).
 * Avoids starting long pipeline / SSE work that will only fail at fetch or hang reading the stream.
 */

/**
 * Browsers on phones/tablets resolve `localhost` to the device itself, not your dev machine.
 * @returns {string}
 */
function loopbackCrossDeviceHint() {
  if (typeof window === 'undefined' || !window.location?.hostname) return '';
  const h = String(window.location.hostname).toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1') {
    return ' If this tab is on a phone or tablet, replace localhost in the address bar with your computer’s LAN IP and port (same Wi‑Fi), e.g. http://192.168.1.10:5174 for npm run dev — not http://localhost:…';
  }
  return '';
}

/**
 * Human message when `fetch()` throws (no Response), e.g. TypeError: Failed to fetch.
 * @param {unknown} err
 * @returns {string}
 */
export function describeNetworkOrOfflineError(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return (
      'Browser reports offline — check your network connection, then try again.' + loopbackCrossDeviceHint()
    );
  }
  const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
  const msg = err instanceof Error ? err.message : String(err || '');
  const lower = msg.toLowerCase();
  if (name === 'AbortError' || lower.includes('aborted')) {
    return 'Request timed out or was aborted before the API responded.' + loopbackCrossDeviceHint();
  }
  if (
    name === 'TypeError' ||
    /failed to fetch|networkerror|load failed|network request failed|net::err/i.test(lower)
  ) {
    return (
      'Cannot reach the app API (connection failed). Start the dev stack with npm run dev (Vite + Express), keep this tab on the same origin as the dev server, then retry.' +
      loopbackCrossDeviceHint()
    );
  }
  return msg || 'Unknown network error';
}

/**
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: true } | { ok: false, status?: number, error: string }>}
 */
export async function probeApiHealth(options = {}) {
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 5000;
  const ac = new AbortController();
  const outer = options.signal;
  const onOuterAbort = () => ac.abort();
  if (outer) {
    if (outer.aborted) {
      return { ok: false, error: 'Request aborted.' };
    }
    outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch('/api/ping', {
      method: 'GET',
      signal: ac.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `API returned HTTP ${res.status}. Start the Express backend on the same origin (npm run dev — Vite proxies /api).`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describeNetworkOrOfflineError(e) };
  } finally {
    clearTimeout(t);
    if (outer) outer.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Throws an Error if /api/ping cannot be reached (lightweight; full stack is GET /api/health).
 * @param {{ timeoutMs?: number, signal?: AbortSignal, retries?: number, retryDelayMs?: number }} [options]
 * - `retries`: extra attempts after the first failed probe (e.g. 1 = two tries total). Useful when the API is slow to wake.
 */
export async function ensureApiReachable(options = {}) {
  const { retries = 0, retryDelayMs = 400, ...probeOpts } = options;
  const extra = Math.max(0, Math.min(3, Math.floor(Number(retries) || 0)));
  const delay =
    typeof retryDelayMs === 'number' && Number.isFinite(retryDelayMs) && retryDelayMs >= 0
      ? retryDelayMs
      : 400;
  const attempts = 1 + extra;
  let lastErr = 'API unreachable';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const r = await probeApiHealth(probeOpts);
    if (r.ok) return;
    lastErr = r.error || lastErr;
    if (attempt < attempts - 1) {
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  throw new Error(lastErr);
}
