/**
 * Scheduler `reason` strings that are internal boilerplate — hide when choosing a user-facing topic
 * (prefer `input_text` or task type label instead).
 */
const GENERIC_REASON_EXACT = new Set([
  'Auto-queued after pipeline flagged belief tensions.',
  'Pipeline flagged belief tensions (Contradiction Engine or Metacognition META_ACTIONS).',
  'Auto-chained after curiosity_generation.',
]);

const GENERIC_REASON_PREFIXES = [
  'Pipeline flagged belief tensions',
  'Auto-queued after pipeline flagged belief tensions',
];

/**
 * @param {string} reason
 * @returns {boolean}
 */
export function isGenericSchedulerReason(reason) {
  const r = String(reason || '').trim();
  if (!r) return true;
  if (GENERIC_REASON_EXACT.has(r)) return true;
  return GENERIC_REASON_PREFIXES.some((p) => r.startsWith(p));
}

/**
 * Best short label for lists: real topic / question / contradiction text.
 * @param {{ input_text?: string, reason?: string }} task
 * @returns {string}
 */
export function getScheduledTaskTopicSummary(task) {
  const input = String(task?.input_text || '').trim();
  if (input) return input;
  const reason = String(task?.reason || '').trim();
  if (reason && !isGenericSchedulerReason(reason)) return reason;
  return '';
}

/**
 * Same rules as {@link getScheduledTaskTopicSummary} for scheduler UI store entries.
 * @param {{ runInputText?: string, runReason?: string }} entry
 * @returns {string}
 */
export function getSchedulerPipelineEntryTopicSummary(entry) {
  return getScheduledTaskTopicSummary({
    input_text: entry?.runInputText,
    reason: entry?.runReason,
  });
}
