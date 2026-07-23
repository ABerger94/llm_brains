import { useSyncExternalStore } from 'react';
import { graphPipelineStore, subscribeGraphPipeline } from '../../lib/graphPipelineStore';
import { consciousnessStreamStore, subscribeConsciousnessStream } from '../../lib/consciousnessStreamStore';
import { getGraphPipelineSessionId, subscribeGraphPipelineSessionId } from '../../lib/graphPipelineSessionScope';
import {
  PLAYGROUND_GRAPH_SESSION_A,
  PLAYGROUND_GRAPH_SESSION_B,
} from '../../lib/playgroundDualGraphRunner';
import {
  PIPELINE_LOG_EMPTY_IDLE_GRAPH_COMPOSER,
  PIPELINE_LOG_EMPTY_RUNNING,
} from '../../lib/activePipelineStatusLabels';
import PipelineExecutionLiveView from './PipelineExecutionLiveView';

/**
 * Curiosity / scheduled-task style live view: stage minimap (from module statuses), neural map, execution.log.
 * Subscribes to {@link graphPipelineStore} — same source as `addGraphExecutionLog` during SSE.
 * Interactive runs also mirror {@link consciousnessStreamStore} `isProcessing` so the execution.log
 * banner stays on while the stream is live (graph `isRunning` can lag or be cleared by rehydrate/heal).
 *
 * @param {{ systemChatTurnCount?: number, workspaceSystemAccent?: 'a'|'b' }} [props]
 * `workspaceSystemAccent`: graph workspace primary vs mirror (any session id). When set, tints the live
 * neural card while busy; Playground omits this and uses playground A/B session ids only.
 */
export default function GraphPipelineExecutionPanel({ systemChatTurnCount, workspaceSystemAccent } = {}) {
  const snap = useSyncExternalStore(
    subscribeGraphPipeline,
    () => graphPipelineStore.getState(),
    () => graphPipelineStore.getState()
  );
  const cs = useSyncExternalStore(
    subscribeConsciousnessStream,
    () => consciousnessStreamStore.getState(),
    () => consciousnessStreamStore.getState()
  );
  const graphSessionId = useSyncExternalStore(
    subscribeGraphPipelineSessionId,
    getGraphPipelineSessionId,
    getGraphPipelineSessionId
  );

  const { moduleStatuses, executionLog, moduleOutputs, isRunning, runError } = snap;
  const pipelineBusy = Boolean(isRunning || cs.isProcessing);

  const playgroundDualAccent =
    graphSessionId === PLAYGROUND_GRAPH_SESSION_A
      ? 'a'
      : graphSessionId === PLAYGROUND_GRAPH_SESSION_B
        ? 'b'
        : null;
  const resolvedBusyAccent =
    workspaceSystemAccent === 'a' || workspaceSystemAccent === 'b'
      ? workspaceSystemAccent
      : playgroundDualAccent;
  const processingSystemAccent =
    pipelineBusy && (resolvedBusyAccent === 'a' || resolvedBusyAccent === 'b') ? resolvedBusyAccent : null;

  return (
    <PipelineExecutionLiveView
      moduleStatuses={moduleStatuses}
      executionLog={executionLog}
      moduleOutputs={moduleOutputs}
      isRunning={pipelineBusy}
      runError={runError}
      emptyRunningMessage={PIPELINE_LOG_EMPTY_RUNNING}
      emptyIdleMessage={PIPELINE_LOG_EMPTY_IDLE_GRAPH_COMPOSER}
      streamEntriesForMinimap={cs.entries}
      processingSystemAccent={processingSystemAccent}
      turnCount={typeof systemChatTurnCount === 'number' ? systemChatTurnCount : null}
    />
  );
}
