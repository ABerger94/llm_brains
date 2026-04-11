/**
 * Shared formatting for pipeline failures (SSE error events, caught exceptions, status line).
 * Kept free of graphPipelineStore / fetch so lightweight modules can import it.
 */

export function stringifyJsonSafe(value, space = 2) {
  try {
    return JSON.stringify(value, null, space);
  } catch {
    try {
      return JSON.stringify(String(value));
    } catch {
      return String(value);
    }
  }
}

/**
 * Full user-visible text for an SSE `type: 'error'` event (message, code/reason, and raw details).
 * @param {unknown} evt
 */
export function formatPipelineSseErrorPayload(evt) {
  if (!evt || typeof evt !== 'object') return 'Pipeline failed';
  const o = /** @type {Record<string, unknown>} */ (evt);
  const parts = [];
  const msg = o.message != null && String(o.message).trim() ? String(o.message).trim() : '';
  if (msg) parts.push(msg);
  if (o.code != null && String(o.code).trim()) parts.push(`code: ${String(o.code).trim()}`);
  if (o.reason != null && String(o.reason).trim()) parts.push(`reason: ${String(o.reason).trim()}`);
  if (o.details != null) {
    const d =
      typeof o.details === 'string' ? o.details.trim() : stringifyJsonSafe(o.details);
    if (d) parts.push(`details:\n${d}`);
  }
  return parts.join('\n\n').trim() || 'Pipeline failed';
}

/**
 * Serialize a thrown value for pipeline `runError` / logs (message, code, cause chain).
 * @param {unknown} err
 */
export function stringifyUnknownError(err) {
  if (err == null) return 'Unknown error';
  if (typeof err !== 'object') return String(err);
  const parts = [];
  const name = 'name' in err && typeof err.name === 'string' ? err.name : '';
  const message = 'message' in err && err.message != null ? String(err.message).trim() : '';
  if (name && name !== 'Error') {
    parts.push(message ? `${name}: ${message}` : name);
  } else {
    parts.push(message || String(err));
  }
  const code = 'code' in err && err.code != null && String(err.code).trim() ? String(err.code).trim() : '';
  if (code) parts.push(`code: ${code}`);
  const reason = 'reason' in err && err.reason != null && String(err.reason).trim() ? String(err.reason).trim() : '';
  if (reason) parts.push(`reason: ${reason}`);
  let c = 'cause' in err ? err.cause : undefined;
  let depth = 0;
  while (c != null && depth < 6) {
    if (c instanceof Error) {
      const cm = String(c.message || '').trim();
      if (cm) parts.push(`cause: ${cm}`);
      c = c.cause;
    } else {
      parts.push(`cause: ${stringifyJsonSafe(c, 0)}`);
      break;
    }
    depth += 1;
  }
  return parts.filter(Boolean).join('\n');
}
