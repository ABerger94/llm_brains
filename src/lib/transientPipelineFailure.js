/**
 * True when failure text looks like transport/API outage (safe to auto-retry on reconnect).
 * Shared by reconnect recovery, dashboard active work, and graph stream error handling.
 * @param {string} text
 */
export function isTransientReconnectFailure(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/NO_AUTO_RETRY/i.test(s)) return false;
  const lower = s.toLowerCase();
  if (/\b(502|503|504)\b/.test(lower)) return true;
  if (/bad gateway|service unavailable|gateway timeout/.test(lower)) return true;
  if (/failed to fetch|networkerror|network request failed|load failed|net::err/.test(lower)) return true;
  if (/cannot reach|connection refused|econnreset|etimedout|socket hang up/.test(lower)) return true;
  if (/abort(ed|error)?|timed out|timeout\b/.test(lower)) return true;
  if (/api unreachable|api offline|offline\b|wrong origin/.test(lower)) return true;
  if (/http\s*408|http\s*429|\b429\b|rate limit|too many requests/.test(lower)) return true;
  if (/typeerror.*fetch|fetch.*failed/i.test(s)) return true;
  return false;
}
