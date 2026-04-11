/**
 * Client-side keyword search across saved pipeline runs and optional chat messages.
 */

function jsonPretty(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

/**
 * Full labeled context for display and search (structured sections + pretty JSON).
 * @param {Record<string, unknown>} run
 */
export function buildPipelineRunDisplayDocument(run) {
  const parts = [];
  parts.push('=== Input ===');
  parts.push(String(run?.input ?? run?.input_text ?? '').trim() || '(empty)');
  parts.push('');
  parts.push('=== Final output (voice) ===');
  parts.push(
    String(run?.final_output ?? run?.narrative_output ?? '').trim() || '(empty)'
  );
  parts.push('');
  parts.push('=== Module outputs ===');
  parts.push(run?.module_outputs != null ? jsonPretty(run.module_outputs) : '(none)');
  parts.push('');
  parts.push('=== Shared memory ===');
  parts.push(run?.shared_memory != null ? jsonPretty(run.shared_memory) : '(none)');
  return parts.join('\n');
}

/**
 * @param {Record<string, unknown>} msg
 */
export function buildConversationMessageDisplayDocument(msg) {
  const parts = [];
  parts.push('=== Assistant message ===');
  parts.push(String(msg?.content ?? '').trim() || '(empty)');
  parts.push('');
  parts.push('=== Module outputs ===');
  parts.push(msg?.module_outputs != null ? jsonPretty(msg.module_outputs) : '(none)');
  parts.push('');
  parts.push('=== Shared memory ===');
  parts.push(msg?.shared_memory != null ? jsonPretty(msg.shared_memory) : '(none)');
  return parts.join('\n');
}

/** @deprecated Use buildPipelineRunDisplayDocument for search + display */
export function buildPipelineRunSearchBlob(run) {
  return buildPipelineRunDisplayDocument(run);
}

/** @deprecated Use buildConversationMessageDisplayDocument */
export function buildConversationMessageSearchBlob(msg) {
  return buildConversationMessageDisplayDocument(msg);
}

/**
 * @param {string} query
 * @returns {string[]}
 */
export function parseSearchTerms(query) {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * @param {string} blobLower
 * @param {string[]} termsLower
 */
export function blobMatchesAllTerms(blobLower, termsLower) {
  return termsLower.length > 0 && termsLower.every((t) => blobLower.includes(t));
}

/**
 * @param {string} blob
 * @param {string[]} termsLower
 * @param {number} [pad]
 */
export function excerptAroundFirstTerm(blob, termsLower, pad = 130) {
  if (!blob || !termsLower.length) return '';
  const lower = blob.toLowerCase();
  let best = -1;
  let len = 0;
  for (const t of termsLower) {
    const i = lower.indexOf(t);
    if (i !== -1 && (best === -1 || i < best)) {
      best = i;
      len = t.length;
    }
  }
  if (best === -1) return blob.slice(0, Math.min(blob.length, pad * 2));
  const s = Math.max(0, best - pad);
  const e = Math.min(blob.length, best + len + pad);
  const prefix = s > 0 ? '…' : '';
  const suffix = e < blob.length ? '…' : '';
  return prefix + blob.slice(s, e) + suffix;
}

/**
 * @typedef {{ type: 'text' | 'hit', value: string }} ExcerptSegment
 * @param {string} excerpt
 * @param {string[]} termsLower
 * @returns {ExcerptSegment[]}
 */
export function excerptHighlightSegments(excerpt, termsLower) {
  if (!excerpt) return [];
  const lower = excerpt.toLowerCase();
  let best = -1;
  let len = 0;
  for (const t of termsLower) {
    const i = lower.indexOf(t);
    if (i !== -1 && (best === -1 || i < best)) {
      best = i;
      len = t.length;
    }
  }
  if (best === -1) return [{ type: 'text', value: excerpt }];
  const rawMatch = excerpt.slice(best, best + len);
  /** @type {ExcerptSegment[]} */
  const out = [];
  if (best > 0) out.push({ type: 'text', value: excerpt.slice(0, best) });
  out.push({ type: 'hit', value: rawMatch });
  if (best + len < excerpt.length) out.push({ type: 'text', value: excerpt.slice(best + len) });
  return out;
}

/**
 * Merge adjacent text segments (fewer DOM nodes).
 * @param {ExcerptSegment[]} segs
 * @returns {ExcerptSegment[]}
 */
function mergeAdjacentTextSegments(segs) {
  /** @type {ExcerptSegment[]} */
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (s.type === 'text' && last?.type === 'text') {
      last.value += s.value;
    } else {
      out.push({ type: s.type, value: s.value });
    }
  }
  return out;
}

/**
 * Split full text into segments, marking every occurrence of any search term (longest match at each position).
 * @param {string} text
 * @param {string[]} termsLower
 * @returns {ExcerptSegment[]}
 */
export function segmentFullTextWithHighlights(text, termsLower) {
  if (!text) return [];
  if (!termsLower.length) return [{ type: 'text', value: text }];
  const lower = text.toLowerCase();
  /** @type {ExcerptSegment[]} */
  const segs = [];
  let pos = 0;
  const len = text.length;

  while (pos < len) {
    let hitLen = 0;
    for (const t of termsLower) {
      if (!t) continue;
      if (lower.slice(pos, pos + t.length) === t && t.length > hitLen) {
        hitLen = t.length;
      }
    }
    if (hitLen > 0) {
      segs.push({ type: 'hit', value: text.slice(pos, pos + hitLen) });
      pos += hitLen;
      continue;
    }

    let nextHit = -1;
    for (const t of termsLower) {
      if (!t) continue;
      const i = lower.indexOf(t, pos);
      if (i !== -1 && (nextHit === -1 || i < nextHit)) nextHit = i;
    }
    if (nextHit === -1) {
      segs.push({ type: 'text', value: text.slice(pos) });
      break;
    }
    if (nextHit > pos) segs.push({ type: 'text', value: text.slice(pos, nextHit) });
    pos = nextHit;
  }

  return mergeAdjacentTextSegments(segs);
}
