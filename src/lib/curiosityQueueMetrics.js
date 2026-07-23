/**
 * Shared curiosity status rules for Curiosity Queue UI and Cognitive Health counts.
 * DB `pursuing` without a live page pursuit slot is stale (e.g. reload mid-run) — treat as `open`
 * so aggregates match what users see on /curiosity.
 */

export function curiosityNormStatus(s) {
  const v = s || 'open';
  if (v === 'pursuing' || v === 'resolved' || v === 'dormant') return v;
  return 'open';
}

/**
 * @param {object} item CuriosityItem row
 * @param {Record<string, { running?: boolean }>} pursuits from {@link getCuriosityPagePursuitSnapshot}.pursuits
 */
export function curiosityUiStatus(item, pursuits) {
  const norm = curiosityNormStatus(item.status);
  if (norm === 'pursuing' && !pursuits?.[String(item.id)]?.running) return 'open';
  return norm;
}

/**
 * @param {object[]} items
 * @param {Record<string, { running?: boolean }>} pursuits
 */
export function countCuriosityItemsByUiStatus(items, pursuits) {
  let open = 0;
  let pursuing = 0;
  let resolved = 0;
  let dormant = 0;
  for (const i of items) {
    const st = curiosityUiStatus(i, pursuits);
    if (st === 'open') open += 1;
    else if (st === 'pursuing') pursuing += 1;
    else if (st === 'resolved') resolved += 1;
    else if (st === 'dormant') dormant += 1;
  }
  return { open, pursuing, resolved, dormant, total: items.length };
}
