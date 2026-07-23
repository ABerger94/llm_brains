import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from '../components/ui';
import { getDashboardActiveWorkSnapshot } from './dashboardActiveWork';
import {
  getDashboardPauseAllUiSnapshot,
  resetDashboardPauseAllUi,
  setDashboardPauseAllSucceededAck,
  setDashboardPauseSettlementPhase,
  subscribeDashboardPauseAllUi,
} from './dashboardPauseAllAckStore';
import {
  notifyCooperativePauseRequestOutcome,
  pauseAllDashboardSettlementEligible,
  runCooperativePauseAllForThisTab,
} from './cooperativePauseAllDashboard';

const PAUSE_SETTLEMENT_IDLE = 'idle';
const PAUSE_SETTLEMENT_WAITING = 'waiting_idle';
const PAUSE_SETTLEMENT_COMPLETE_FLASH = 'complete_flash';

const COMPLETE_FLASH_MS = 6000;

/**
 * Dashboard “Pause & save all”: cooperative pause orchestration + settlement UI phase (amber → rows drain → green flash).
 *
 * @param {object} input
 * @param {number} input.activeRowCount — `rows.length` from {@link getDashboardActiveWorkSnapshot}
 * @param {boolean} input.loadSavedPipelinesBusy — disables pause while Load saved runs; clears settlement when true
 */
export function useDashboardPauseAllSettlement({ activeRowCount, loadSavedPipelinesBusy }) {
  const ui = useSyncExternalStore(
    subscribeDashboardPauseAllUi,
    getDashboardPauseAllUiSnapshot,
    getDashboardPauseAllUiSnapshot
  );

  const [pauseAllBusy, setPauseAllBusy] = useState(false);
  const completeFlashTimerRef = useRef(null);
  /** Blocks stray ack clear while ack can emit before the store commits settlement phase. */
  const pauseAllInFlightRef = useRef(false);
  /** Rows at click time; list can empty during `await` while pause still succeeded. */
  const hadRowsAtPauseClickRef = useRef(false);

  const pauseSettlementPhase = ui.settlementPhase;
  const pauseAllSucceededAck = ui.ack;

  const isWaitingSettle = pauseSettlementPhase === PAUSE_SETTLEMENT_WAITING;
  const isCompleteFlash = pauseSettlementPhase === PAUSE_SETTLEMENT_COMPLETE_FLASH;

  useEffect(() => {
    if (!loadSavedPipelinesBusy) return;
    if (completeFlashTimerRef.current) {
      clearTimeout(completeFlashTimerRef.current);
      completeFlashTimerRef.current = null;
    }
    resetDashboardPauseAllUi();
  }, [loadSavedPipelinesBusy]);

  useEffect(() => {
    if (
      pauseSettlementPhase !== PAUSE_SETTLEMENT_WAITING ||
      activeRowCount !== 0 ||
      !pauseAllSucceededAck
    ) {
      return;
    }
    setDashboardPauseSettlementPhase(PAUSE_SETTLEMENT_COMPLETE_FLASH);
  }, [pauseSettlementPhase, activeRowCount, pauseAllSucceededAck]);

  useEffect(() => {
    if (pauseSettlementPhase !== PAUSE_SETTLEMENT_COMPLETE_FLASH) return;
    completeFlashTimerRef.current = setTimeout(() => {
      completeFlashTimerRef.current = null;
      resetDashboardPauseAllUi();
    }, COMPLETE_FLASH_MS);
    return () => {
      if (completeFlashTimerRef.current) {
        clearTimeout(completeFlashTimerRef.current);
        completeFlashTimerRef.current = null;
      }
    };
  }, [pauseSettlementPhase]);

  useEffect(() => {
    if (pauseAllInFlightRef.current) return;
    if (
      pauseSettlementPhase !== PAUSE_SETTLEMENT_IDLE ||
      activeRowCount !== 0 ||
      !pauseAllSucceededAck
    ) {
      return;
    }
    setDashboardPauseAllSucceededAck(false);
  }, [pauseSettlementPhase, activeRowCount, pauseAllSucceededAck]);

  const runPauseAll = useCallback(async () => {
    hadRowsAtPauseClickRef.current = getDashboardActiveWorkSnapshot().rows.length > 0;
    pauseAllInFlightRef.current = true;
    setPauseAllBusy(true);
    try {
      const { request, appended } = await runCooperativePauseAllForThisTab();
      notifyCooperativePauseRequestOutcome(request);
      if (pauseAllDashboardSettlementEligible(request, hadRowsAtPauseClickRef.current)) {
        setDashboardPauseAllSucceededAck(true);
        setDashboardPauseSettlementPhase(PAUSE_SETTLEMENT_WAITING);
      } else if (appended) {
        setDashboardPauseAllSucceededAck(true);
      }
    } catch (e) {
      toast({
        title: 'Pause failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      pauseAllInFlightRef.current = false;
      setPauseAllBusy(false);
    }
  }, []);

  const pauseButtonTitle = isWaitingSettle
    ? 'Waiting for pipelines to finish: cooperative pause applies after each current module completes; checkpoints save when each run stops.'
    : 'Notifies every open app tab (same origin), then POSTs pause for hooks registered in this tab. Other tabs POST their own hooks. Pipelines stop after the current LLM module completes (not instant), then save checkpoints.';

  const resumeButtonTitle = isCompleteFlash
    ? 'All pipelines saved in this tab; use Load saved if needed, then Resume on each card.'
    : 'Merges saved curiosity/goal pursuit slots from storage and refreshes the list so cooperative-pause pipelines appear. Does not start runs — use Resume on each card to continue from the last checkpoint.';

  return {
    pauseAllBusy,
    runPauseAll,
    isWaitingSettle,
    isCompleteFlash,
    pauseButtonTitle,
    resumeButtonTitle,
    pauseAllSucceededAck,
  };
}
