import { BeliefStore } from './data';

/**
 * Remove beliefId from every other row's contradicts[] (after resolving or deleting a belief).
 */
export async function removeBeliefIdFromOthersContradicts(beliefId, listLimit = 400) {
  const id = String(beliefId || '').trim();
  if (!id) return;
  const rows = await BeliefStore.list('-created_date', listLimit);
  for (const b of rows) {
    if (b.id === id) continue;
    const arr = Array.isArray(b.contradicts) ? b.contradicts : [];
    if (!arr.includes(id)) continue;
    await BeliefStore.update(b.id, { contradicts: arr.filter((x) => x !== id) });
  }
}
