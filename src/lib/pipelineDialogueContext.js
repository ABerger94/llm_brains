/**
 * Build options.recentDialogue for the pipeline from conversation rows (chronological).
 */
export function rowsToRecentDialogue(rows, maxEntries = 16) {
  const dateMs = (r) => { const t = Date.parse(r?.created_date); return Number.isFinite(t) ? t : 0; };
  const sorted = [...(rows || [])].sort((a, b) => dateMs(a) - dateMs(b));
  const out = [];
  for (const m of sorted.slice(-maxEntries)) {
    if (m.role === 'user' || m.role === 'assistant') {
      out.push({
        role: m.role,
        content: String(m.content || '').slice(0, 3500),
      });
    }
  }
  return out;
}
