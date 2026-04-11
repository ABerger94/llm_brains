/**
 * Cooperative pause: {@link runGraphPipelineOneShot} / persist path returns this shape when the server
 * stops between modules and saves a checkpoint.
 * @param {unknown} v
 * @returns {boolean}
 */
export function isPipelinePauseOutcome(v) {
  return Boolean(v && typeof v === 'object' && v.pipelinePaused === true);
}
