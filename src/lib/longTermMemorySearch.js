import { LongTermMemory } from './data';

/**
 * Lightweight local search over stored memories (title + content).
 */
export async function searchLongTermMemory(query, limit = 5) {
  const all = await LongTermMemory.list('-created_date', 80);
  const q = String(query || '').toLowerCase().trim();
  if (!q) return all.slice(0, limit);
  return all
    .filter((m) => {
      const t = `${m.title || ''} ${m.content || ''}`.toLowerCase();
      return t.includes(q);
    })
    .slice(0, limit);
}
