/**
 * Dashboard “Pause & save all” UI: row-level “Paused” ack + settlement phase (amber / complete flash).
 * Single store so ack and phase stay in sync for useSyncExternalStore subscribers.
 */

const listeners = new Set();

let pauseAllSucceededAck = false;

/** @type {'idle' | 'waiting_idle' | 'complete_flash'} */
let pauseSettlementPhase = 'idle';

/** @type {{ ack: boolean, settlementPhase: 'idle' | 'waiting_idle' | 'complete_flash' } | null} */
let cachedUiSnapshot = null;

function emit() {
  cachedUiSnapshot = null;
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

export function subscribeDashboardPauseAllUi(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** @deprecated Use {@link subscribeDashboardPauseAllUi} */
export const subscribeDashboardPauseAllAck = subscribeDashboardPauseAllUi;

/**
 * @returns {{ ack: boolean, settlementPhase: 'idle' | 'waiting_idle' | 'complete_flash' }}
 */
export function getDashboardPauseAllUiSnapshot() {
  if (
    !cachedUiSnapshot ||
    cachedUiSnapshot.ack !== pauseAllSucceededAck ||
    cachedUiSnapshot.settlementPhase !== pauseSettlementPhase
  ) {
    cachedUiSnapshot = { ack: pauseAllSucceededAck, settlementPhase: pauseSettlementPhase };
  }
  return cachedUiSnapshot;
}

/** @deprecated Use {@link getDashboardPauseAllUiSnapshot}().ack */
export function getDashboardPauseAllAckSnapshot() {
  return pauseAllSucceededAck;
}

export function setDashboardPauseAllSucceededAck(value) {
  const next = Boolean(value);
  if (next === pauseAllSucceededAck) return;
  pauseAllSucceededAck = next;
  emit();
}

/**
 * @param {'idle' | 'waiting_idle' | 'complete_flash'} phase
 */
export function setDashboardPauseSettlementPhase(phase) {
  const p =
    phase === 'waiting_idle' || phase === 'complete_flash' || phase === 'idle' ? phase : 'idle';
  if (p === pauseSettlementPhase) return;
  pauseSettlementPhase = p;
  emit();
}

/** Clears ack and settlement (e.g. Resume all, or timer end). */
export function resetDashboardPauseAllUi() {
  if (!pauseAllSucceededAck && pauseSettlementPhase === 'idle') return;
  pauseAllSucceededAck = false;
  pauseSettlementPhase = 'idle';
  emit();
}
