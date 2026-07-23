import { toast } from '../components/ui';
import { setCooperativePauseAllExternalHold } from './cooperativePauseAllExternalHold';
import { requestCooperativePauseForAllRegisteredTokens } from './pipelineActiveRunRegistry';
import {
  appendCooperativePauseAllRequestedToExecutionLogs,
  cooperativePauseAnyRequestOk,
} from './pipelinePauseAllExecutionLogs';
import { broadcastCooperativePauseAll } from './pipelinePauseBroadcast';

/**
 * Whether “Pause & save all” meaningfully dispatched: local pause-request(s) succeeded, optimistic
 * connection-limited queue, or **broadcast-only** (this tab had no hooks — another tab should POST).
 * False when every in-tab token POST failed.
 *
 * @param {{ tokenCount?: number, okCount?: number, failCount?: number, connectionLimited?: boolean } | null | undefined} request
 */
export function pauseAllDispatchReachedBackendOrBroadcast(request) {
  const r = request || { tokenCount: 0, okCount: 0, failCount: 0, connectionLimited: false };
  if (r.connectionLimited) return true;
  const tokenCount = Number(r.tokenCount) || 0;
  const okCount = Number(r.okCount) || 0;
  if (tokenCount > 0 && okCount <= 0) return false;
  return okCount > 0 || tokenCount === 0;
}

/**
 * Whether to show Dashboard settlement (amber → green) after Pause: requires visible active rows and a
 * successful dispatch path. When this tab had no pause hooks (`tokenCount === 0`), settlement still
 * applies if rows were present — other tabs receive the broadcast and POST their tokens (see
 * {@link installCooperativePauseBroadcastListener}).
 *
 * @param {{ tokenCount?: number, okCount?: number, failCount?: number, connectionLimited?: boolean } | null | undefined} request
 * @param {boolean} hadActiveRowsAtClick — {@link getDashboardActiveWorkSnapshot} had rows when Pause was clicked
 */
export function pauseAllDashboardSettlementEligible(request, hadActiveRowsAtClick) {
  if (!hadActiveRowsAtClick) return false;
  if (!pauseAllDispatchReachedBackendOrBroadcast(request)) return false;
  const r = request || { tokenCount: 0, okCount: 0, failCount: 0, connectionLimited: false };
  if (r.connectionLimited) return true;
  const tokenCount = Number(r.tokenCount) || 0;
  const okCount = Number(r.okCount) || 0;
  if (tokenCount > 0) return okCount > 0;
  return true;
}

/**
 * Same-origin broadcast + POST /api/pipeline/pause-request for every pause token registered in this tab.
 * When any pause-request succeeds, appends cooperative-pause lines to in-tab pipeline logs and sets the dashboard pause ack.
 *
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ request: { tokenCount: number, okCount: number, failCount: number, errors: string[] }, appended: boolean }>}
 */
export async function runCooperativePauseAllForThisTab(fetchImpl = fetch) {
  if (typeof window === 'undefined') {
    return {
      request: { tokenCount: 0, okCount: 0, failCount: 0, errors: [] },
      appended: false,
    };
  }

  broadcastCooperativePauseAll();
  const request = await requestCooperativePauseForAllRegisteredTokens(fetchImpl);
  const appended = cooperativePauseAnyRequestOk(request);
  const dispatchOk = pauseAllDispatchReachedBackendOrBroadcast(request);
  if (dispatchOk) {
    setCooperativePauseAllExternalHold(true);
  } else {
    setCooperativePauseAllExternalHold(false);
  }
  if (appended) {
    appendCooperativePauseAllRequestedToExecutionLogs();
  }
  return { request, appended };
}

const NEXT_MODULE_HINT =
  'Cooperative pause applies when the current LLM module finishes — not instantly mid-call. Each affected pipeline then stops before the next module and saves a checkpoint.';

const DEV_BOTH_HINT =
  'If you use dev:both (HF stack + local LM stack), keep one browser tab per stack so pause-request hits the same Node process as the live SSE stream.';

/**
 * User-facing summary for the pause-request round-trip.
 * @param {{ tokenCount: number, okCount: number, failCount: number, errors: string[], connectionLimited?: boolean }} request
 */
export function notifyCooperativePauseRequestOutcome(request) {
  const r = request || { failCount: 0, tokenCount: 0, okCount: 0, errors: [] };
  const errs = Array.isArray(r.errors) ? r.errors : [];

  if (r.connectionLimited) {
    toast({
      title: 'Pause queued (could not confirm yet)',
      description:
        `The pause request could not be confirmed within a few seconds — often because the browser has many ` +
        `simultaneous connections to this site (e.g. several SSE pipeline requests) or the network was slow. ` +
        `A pause was still queued for ${r.tokenCount} registered pause hook(s) — that count is internal tokens ` +
        `(this tab + active saved workspaces), not the same as the number of dashboard rows. ` +
        `It should apply after the current module when a slot frees up. ${NEXT_MODULE_HINT}`,
    });
    return;
  }

  if (r.tokenCount === 0) {
    toast({
      title: 'Pause sent to other tabs',
      description:
        `No pipeline pause hooks are registered in this tab; other open windows were notified and will POST ` +
        `their hooks (same origin). ${NEXT_MODULE_HINT} If nothing stops, focus the tab running the pipeline, ` +
        `or use Stop. ${DEV_BOTH_HINT}`,
    });
    return;
  }

  if (r.okCount <= 0) {
    const first = errs[0] || '';
    toast({
      title: 'Pause request failed',
      description: first
        ? `${first}${errs.length > 1 ? ` (+${errs.length - 1} more)` : ''}. ${DEV_BOTH_HINT}`
        : `Every pause-request failed. ${DEV_BOTH_HINT}`,
      variant: 'destructive',
    });
    return;
  }

  if (r.failCount > 0) {
    const first = errs[0] || '';
    toast({
      title: 'Pause partially applied',
      description: `${r.okCount} of ${r.tokenCount} hook(s) accepted pause; ${r.failCount} failed${first ? ` (${first}${errs.length > 1 ? ` +${errs.length - 1}` : ''})` : ''}. ${NEXT_MODULE_HINT} ${DEV_BOTH_HINT}`,
    });
    return;
  }

  toast({
    title: 'Pause requested',
    description: `${r.okCount} pipeline hook(s) in this tab will stop after the current module completes, then save checkpoints where supported. ${NEXT_MODULE_HINT}`,
  });
}
