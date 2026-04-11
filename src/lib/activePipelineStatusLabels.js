import { stringifyUnknownError } from './pipelineRunErrorFormat';

/**
 * Shared copy for active pipeline UIs: Dashboard module column, stage minimap strip,
 * execution.log empty states, and progress lines — keep wording aligned everywhere.
 */

/** Left label on {@link PipelineStageMinimap} (matches Dashboard “Module” column concept). */
export const PIPELINE_MINIMAP_STRIP_LABEL = 'Module';

/** `computePipelineMinimapSnapshot` / screen-reader `liveStatus` prefix. */
export const PIPELINE_LIVE_STATUS_PREFIX = PIPELINE_MINIMAP_STRIP_LABEL;

/** When {@link formatActivePipelineDetail} has no lead and no tail. */
export const PIPELINE_DASHBOARD_FALLBACK_DETAIL = 'Pipeline running';

/** Primary line for graph / scheduler rows on the Dashboard (and similar). */
export function formatPipelineDashboardStatusLine({ uploading, moduleName, isActive = false } = {}) {
  if (uploading) return 'Uploading attachments…';
  const m = String(moduleName || '').trim();
  if (m) return `Module: ${m}`;
  if (isActive) return 'Starting pipeline…';
  return 'Module: Running';
}

export const PIPELINE_LOG_EMPTY_RUNNING = 'Waiting for pipeline events…';
export const PIPELINE_LOG_EMPTY_IDLE = 'No pipeline output yet.';
/** Graph Pipeline page when the run has not emitted log lines yet. */
export const PIPELINE_LOG_EMPTY_IDLE_GRAPH_COMPOSER =
  'No pipeline output yet — run the pipeline from the composer below.';
/** Scheduler task live panel when the buffer is gone but the row may still exist. */
export const PIPELINE_LOG_EMPTY_IDLE_SCHEDULER_BUFFER =
  'No live buffer for this task — it may have finished or live UI is only kept while the scheduler holds this run open.';
/** Curiosity / goal carousel when the pursuit is not owned by this tab. */
export const PIPELINE_LOG_PURSUIT_OUTSIDE_TAB =
  'Pursuing outside this tab (e.g. scheduler) — live logs appear when you run a pursuit from this page.';

/**
 * Banner above execution.log: "Processing" while running; otherwise explicit `runError` or the last `Error:` line from the log.
 * @param {{ runError?: unknown, isRunning?: boolean, executionLog?: unknown }} input
 * @returns {{ showProcessing: boolean, errorText: string | null }}
 */
function formatRunErrorLine(runError) {
  if (runError == null) return '';
  if (typeof runError === 'string') return runError.trim();
  if (typeof runError === 'object') return stringifyUnknownError(runError).trim();
  return String(runError).trim();
}

export function derivePipelineExecutionStatus({ runError, isRunning, executionLog }) {
  if (isRunning) {
    return { showProcessing: true, errorText: null };
  }
  const ex = formatRunErrorLine(runError);
  if (ex) {
    return { showProcessing: false, errorText: ex };
  }
  const log = Array.isArray(executionLog) ? executionLog : [];
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const row = log[i];
    const m = String(row?.msg ?? '');
    const detail = row?.detail != null && String(row.detail).trim() ? `\n\n${String(row.detail).trim()}` : '';
    if (m.startsWith('Pipeline failed:')) {
      return { showProcessing: false, errorText: m.replace(/^Pipeline failed:\s*/, '').trim() + detail };
    }
    if (m.startsWith('Error:')) {
      return { showProcessing: false, errorText: m.replace(/^Error:\s*/, '').trim() + detail };
    }
  }
  return { showProcessing: false, errorText: null };
}
