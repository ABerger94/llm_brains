/**
 * Auto-retry for failed scheduled tasks: requeue same row as `pending` with backoff (see scheduledTaskRunner).
 */

/**
 * @param {number} nextAttempt1Based - Count after this failure (1 = first retry).
 * @param {number} baseMinutes
 * @param {number} maxDelayMinutes - Cap for a single wait (default 60).
 * @returns {string} ISO time for `scheduled_at`
 */
export function computeNextBackoffIso(nextAttempt1Based, baseMinutes, maxDelayMinutes) {
  const base = Math.max(1, Math.floor(Number(baseMinutes) || 5));
  const maxCap = Math.max(base, Math.floor(Number(maxDelayMinutes) || 60));
  const exp = Math.max(0, Math.floor(nextAttempt1Based) - 1);
  const mult = Math.min(64, 2 ** exp);
  let minutes = base * mult;
  minutes = Math.min(maxCap, Math.max(1, minutes));
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * @param {object|null|undefined} task - ScheduledTask row
 * @param {object} settings - runtime settings (getRuntimeSettings())
 * @returns {boolean}
 */
export function shouldAutoRetryTask(task, settings) {
  if (!task || typeof task !== 'object') return false;
  if (!settings || typeof settings !== 'object') return false;
  if (settings.schedulerAutoRetryEnabled !== true) return false;
  if (task.scheduler_auto_retry === false) return false;
  if (settings.schedulerAutoRetryUnlimited !== false) return true;
  const max = Math.max(0, Math.floor(Number(settings.schedulerAutoRetryMaxAttempts) ?? 10));
  if (max === 0) return false;
  const current = Number(task.scheduler_retry_attempt) || 0;
  const nextAttempt = current + 1;
  return nextAttempt <= max;
}
