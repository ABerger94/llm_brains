/**
 * Cross-turn prediction audit: compares last run's Planning prediction with the new primary turn.
 * Built client-side and passed as options.priorPredictionAudit to POST /api/pipeline/stream.
 */

const SEP = '\n---\n\n';

export function extractPrimaryTurnText(composedInput) {
  const s = String(composedInput || '').trim();
  if (!s) return '';
  const idx = s.lastIndexOf(SEP);
  const tail = idx === -1 ? s : s.slice(idx + SEP.length).trim();
  return tail;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

function alignmentLabel(overlapScore, predText, newPrimary) {
  if (!predText && !newPrimary) return 'unknown';
  const p = String(predText || '').toLowerCase();
  const n = String(newPrimary || '').toLowerCase();
  if (!n.trim()) return 'unknown';
  if (p.length > 8 && n.includes(p.slice(0, Math.min(40, p.length)))) return 'aligned';
  if (overlapScore > 0.22) return 'aligned';
  if (overlapScore > 0.08) return 'shifted';
  return 'shifted';
}

/**
 * @param {object | null} previousSharedMemory - Prior run's shared_memory (slim ok).
 * @param {string} newInputText - This request's `input` (before server composes attachments/dialogue).
 * @returns {object | null} Serializable payload for options.priorPredictionAudit
 */
export function buildPriorPredictionAuditPayload(previousSharedMemory, newInputText) {
  const pred = previousSharedMemory?.userStancePrediction;
  if (!pred || typeof pred !== 'object') return null;
  const expectUserWants = String(pred.expectUserWants || pred.summary || '').trim();
  if (!expectUserWants && pred.confidence == null) return null;

  const prevPrimary = extractPrimaryTurnText(previousSharedMemory?.originalInput || '');
  const newPrimary = extractPrimaryTurnText(newInputText);
  const predTokens = tokenize(expectUserWants);
  const newTokens = tokenize(newPrimary);
  const overlapScore = jaccard(predTokens, newTokens);
  const heuristicAlignment = alignmentLabel(overlapScore, expectUserWants, newPrimary);

  return {
    at: new Date().toISOString(),
    sessionId: previousSharedMemory?.sessionId || null,
    previousExpectUserWants: expectUserWants.slice(0, 1200),
    previousConfidence:
      typeof pred.confidence === 'number' && Number.isFinite(pred.confidence) ? pred.confidence : null,
    previousPrimaryTurnPreview: prevPrimary.slice(0, 800),
    newPrimaryTurnPreview: newPrimary.slice(0, 800),
    overlapScore,
    heuristicAlignment,
  };
}
