/**
 * Sanitize entity rows restored from a mind archive so UI does not treat exported mid-flight state as live.
 */

const IMPORT_CLEARED_RUN_MSG =
  'Import cleared in-flight run state; this task was not running in this session.';

/**
 * @param {unknown} status
 * @returns {string}
 */
function normalizedScheduledTaskStatus(status) {
  const s = String(status ?? '')
    .trim()
    .toLowerCase();
  if (!s) return 'pending';
  if (s === 'canceled') return 'cancelled';
  return s;
}

/**
 * @param {{ id: string, entityType: string, value: object }} row
 * @returns {{ id: string, entityType: string, value: object }}
 */
function sanitizeScheduledTaskRow(row) {
  const v = row.value && typeof row.value === 'object' ? { ...row.value } : {};
  if (normalizedScheduledTaskStatus(v.status) !== 'running') {
    return { ...row, value: v };
  }
  return {
    ...row,
    value: {
      ...v,
      status: 'failed',
      result_summary: IMPORT_CLEARED_RUN_MSG,
      completed_at: new Date().toISOString(),
    },
  };
}

/**
 * @param {Array<{ id: string, entityType: string, value: object }>} rows
 * @returns {Array<{ id: string, entityType: string, value: object }>}
 */
export function sanitizeImportedEntityRecords(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => {
    if (!r || typeof r !== 'object' || r.entityType !== 'ScheduledTask') return r;
    return sanitizeScheduledTaskRow(r);
  });
}
