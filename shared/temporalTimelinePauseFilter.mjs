/**
 * Cooperative-pause checkpoints are operational metadata, not mind history.
 * Drop matching TemporalEvent rows (and client-forged payloads) from LLM-facing digests.
 */

/**
 * @param {unknown} event
 * @returns {boolean}
 */
export function isPauseTimelineNoise(event) {
  if (!event || typeof event !== 'object') return false;
  const title = String(event.title || '').trim().toLowerCase();
  const details = String(event.details || event.description || '').trim();
  if (/^\(paused before\b/i.test(details)) return true;
  if (/\bpaused cooperatively before\b/i.test(details)) return true;
  if (/\bcooperative pause\b/i.test(details)) return true;
  if (title === 'pipeline paused') return true;
  return false;
}

/**
 * @param {unknown[]} rows
 * @returns {object[]}
 */
export function temporalEventsExcludingPauseNoise(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((e) => !isPauseTimelineNoise(e));
}
