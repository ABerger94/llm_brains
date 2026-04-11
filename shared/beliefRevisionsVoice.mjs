/**
 * Fragile appendix: scheduled belief tension review may append BELIEF_REVISIONS to Voice output.
 * Strip before user-visible persistence; parse for Belief Map sync.
 */

/** Must match the first line prefix in scheduledTaskRunner runBeliefTensionReviewScheduled. */
export const BELIEF_TENSION_REVIEW_PRIMARY_MARKER = '[Belief tension review — scheduled]';

export function isBeliefTensionReviewPrimaryTurn(originalInput) {
  return String(originalInput || '').includes(BELIEF_TENSION_REVIEW_PRIMARY_MARKER);
}

function parseJsonObjectAfterBeliefRevisionsMarker(raw) {
  const re = /\bBELIEF_REVISIONS\s*:/i;
  const m = raw.match(re);
  if (!m || m.index == null) return null;
  const sub = raw.slice(m.index + m[0].length).trimStart();
  const brace = sub.indexOf('{');
  if (brace === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = brace; i < sub.length; i += 1) {
    if (sub[i] === '{') depth += 1;
    else if (sub[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(sub.slice(brace, end + 1));
  } catch {
    return null;
  }
}

/**
 * If Voice ends with a valid BELIEF_REVISIONS JSON object, return prose without that tail.
 * If marker exists but JSON is invalid, leave text unchanged (do not strip).
 * @returns {{ displayText: string, revisionsPayload: object | null }}
 */
export function splitVoiceOutputBeliefRevisionsAppendix(text) {
  const raw = String(text || '');
  const re = /\bBELIEF_REVISIONS\s*:/i;
  const m = raw.match(re);
  if (!m || m.index == null) return { displayText: raw, revisionsPayload: null };
  const parsed = parseJsonObjectAfterBeliefRevisionsMarker(raw);
  if (!parsed || typeof parsed !== 'object') return { displayText: raw, revisionsPayload: null };
  const displayText = raw.slice(0, m.index).replace(/\s+$/u, '');
  return { displayText, revisionsPayload: parsed };
}
