/**
 * Classify stored scheduler failure text for debugging (supervisor reruns, pipeline runs, etc.).
 * Tags are stable prefixes so users can search/filter and map to the diagnosis table in docs.
 */

/** @typedef {'health_preflight'|'network_fetch'|'payload_too_large'|'llm_or_provider'|'continuation_shared_memory'|'sse_incomplete'|'stale_running_cap'|'user_abort'|'unknown'} SchedulerFailureBucket */

/**
 * @param {string} raw
 * @returns {{ bucket: SchedulerFailureBucket, tag: string }}
 */
export function classifyScheduledTaskFailureMessage(raw) {
  const s = String(raw || '').trim();
  const lower = s.toLowerCase();

  if (
    /run exceeded the maximum time|tab closed before completion|stale running/i.test(s) ||
    lower.includes('maximum time')
  ) {
    return { bucket: 'stale_running_cap', tag: '[stale_running_cap]' };
  }
  if (lower.includes('stopped during run')) {
    return { bucket: 'user_abort', tag: '[user_abort]' };
  }
  if (
    /missing sharedmemory|missing shared memory|continuation event is missing/i.test(lower) ||
    lower.includes('cannot post the next pipeline leg')
  ) {
    return { bucket: 'continuation_shared_memory', tag: '[continuation_shared_memory]' };
  }
  if (/413|payload too large|entity too large|request entity too large/i.test(s)) {
    return { bucket: 'payload_too_large', tag: '[payload_too_large]' };
  }
  if (
    /api unreachable|\/api\/health|\/api\/ping|health returned http|api returned http|is the backend running|is the express backend/i.test(
      lower
    ) || lower.includes('cannot reach the app api')
  ) {
    return { bucket: 'health_preflight', tag: '[health_preflight]' };
  }
  if (
    /failed to fetch|networkerror|connection failed|net::err|offline/i.test(lower) ||
    lower.includes('browser reports offline')
  ) {
    return { bucket: 'network_fetch', tag: '[network_fetch]' };
  }
  if (
    /local_llm|openrouter|groq|together|provider|rate limit|429|time budget|pipeline failed|inference/i.test(lower) ||
    /\btimeout\b|timed out/i.test(lower)
  ) {
    return { bucket: 'llm_or_provider', tag: '[llm_or_provider]' };
  }
  if (/stream ended without|exceeded \d+ metacognition continuation legs/i.test(lower)) {
    return { bucket: 'sse_incomplete', tag: '[sse_incomplete]' };
  }

  return { bucket: 'unknown', tag: '[unknown]' };
}

/**
 * Prefix a one-line failure summary with a stable bucket tag once (idempotent).
 * @param {string} message
 * @returns {string}
 */
export function tagScheduledTaskFailureSummary(message) {
  const msg = String(message || '').trim();
  if (!msg) return msg;
  if (/^\[[^\]]+\]\s/.test(msg)) return msg;
  const { tag } = classifyScheduledTaskFailureMessage(msg);
  return `${tag} ${msg}`;
}
