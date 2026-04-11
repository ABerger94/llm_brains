/**
 * Truncate prose at a complete boundary (paragraph → line → sentence → word).
 * Avoids cutting mid-word or mid-sentence when possible. Does not parse JSON — use only on natural language.
 *
 * @param {unknown} text
 * @param {number} maxLen  Maximum string length (including ellipsis when used)
 * @param {{ ellipsis?: boolean }} [opts]  ellipsis defaults true when text was shortened
 * @returns {string}
 */
export function clipTextComplete(text, maxLen, opts = {}) {
  const useEllipsis = opts.ellipsis !== false;
  const ell = useEllipsis ? '…' : '';
  const s = String(text ?? '');
  if (!Number.isFinite(maxLen) || maxLen <= 0) return useEllipsis ? ell : '';
  if (s.length <= maxLen) return s;

  const reserve = useEllipsis ? ell.length : 0;
  const budget = Math.max(1, maxLen - reserve);
  if (budget < 1) return useEllipsis ? ell : '';

  if (!useEllipsis) {
    let slice = s.slice(0, maxLen);
    const minKeep = Math.max(1, Math.floor(maxLen * 0.38));
    const para = slice.lastIndexOf('\n\n');
    if (para >= minKeep) slice = slice.slice(0, para);
    else {
      const nl = slice.lastIndexOf('\n');
      if (nl >= minKeep) slice = slice.slice(0, nl);
      else {
        const sp = slice.lastIndexOf(' ');
        if (sp >= minKeep) slice = slice.slice(0, sp);
      }
    }
    return slice.trimEnd();
  }

  let slice = s.slice(0, budget);
  const minKeep = Math.max(1, Math.floor(budget * 0.38));

  let cut = slice.length;
  const para = slice.lastIndexOf('\n\n');
  if (para >= minKeep) cut = para;
  else {
    const nl = slice.lastIndexOf('\n');
    if (nl >= minKeep) cut = nl;
    else {
      let sentCut = -1;
      for (let i = slice.length - 1; i >= minKeep; i -= 1) {
        const c = slice[i];
        if ((c === '.' || c === '!' || c === '?') && (i === slice.length - 1 || /\s/.test(slice[i + 1]))) {
          sentCut = i + 1;
          break;
        }
      }
      if (sentCut > minKeep) cut = sentCut;
      else {
        const sp = slice.lastIndexOf(' ');
        if (sp >= minKeep) cut = sp;
      }
    }
  }

  let out = slice.slice(0, cut).trimEnd();
  if (!out) {
    out = slice.trimEnd();
    const sp2 = out.lastIndexOf(' ');
    if (sp2 > 0) out = out.slice(0, sp2).trimEnd();
  }
  if (!out) out = slice.slice(0, Math.min(budget, slice.length)).trimEnd();

  const shortened = out.length < s.length;
  return shortened && useEllipsis ? `${out}${ell}` : out;
}
