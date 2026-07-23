/**
 * Heuristic candidate pairs for contradictory or duplicate beliefs (no embeddings).
 */

const NEGATORS = /^(not|no|never|isn'?t|aren'?t|wasn'?t|weren'?t|cannot|can't|without)\b/i;

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

/**
 * Token Jaccard similarity for two natural-language strings (layout / grouping).
 * @param {string} sa
 * @param {string} sb
 * @returns {number}
 */
export function jaccardSimilarity(sa, sb) {
  return jaccard(tokens(String(sa || '')), tokens(String(sb || '')));
}

/**
 * @param {Array<{ id?: string, statement?: string, belief?: string }>} rows
 * @param {{ maxPairs?: number, minJaccard?: number }} opts
 * @returns {Array<{ a: object, b: object, score: number, reason: string }>}
 */
export function suggestContradictionPairs(rows, opts = {}) {
  const maxPairs = opts.maxPairs ?? 24;
  const minJ = opts.minJaccard ?? 0.18;
  const list = Array.isArray(rows) ? rows.filter((r) => r && (r.statement || r.belief)) : [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const sa = String(list[i].statement || list[i].belief || '').trim();
    if (sa.length < 12) continue;
    const ta = tokens(sa);
    for (let j = i + 1; j < list.length; j += 1) {
      const sb = String(list[j].statement || list[j].belief || '').trim();
      if (sb.length < 12) continue;
      const tb = tokens(sb);
      const jac = jaccard(ta, tb);
      if (jac < minJ) continue;
      let reason = 'similar_topic';
      if (NEGATORS.test(sa) !== NEGATORS.test(sb) && jac > 0.35) reason = 'possible_negation_mismatch';
      out.push({ a: list[i], b: list[j], score: jac, reason });
    }
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, maxPairs);
}
