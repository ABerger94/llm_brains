import { useSyncExternalStore } from 'react';
import {
  getSchedulerPipelineUiSnapshot,
  subscribeSchedulerPipelineUi,
} from '../../lib/schedulerPipelineUiStore';
import { initialCuriosityPipelineUi } from '../../lib/curiosityPipelineSseUi';
import { getFirstProcessingModuleId } from '../../lib/cognitiveModules';
import {
  PIPELINE_LOG_EMPTY_IDLE_SCHEDULER_BUFFER,
  PIPELINE_LOG_EMPTY_RUNNING,
} from '../../lib/activePipelineStatusLabels';
import PipelineExecutionLiveView from './PipelineExecutionLiveView';

/** Live minimap / neural / log for one scheduled task (same SSE reduction as curiosity goals). */
export default function SchedulerTaskPipelineLivePanel({ taskId }) {
  const id = String(taskId || '').trim();
  const snap = useSyncExternalStore(
    subscribeSchedulerPipelineUi,
    getSchedulerPipelineUiSnapshot,
    getSchedulerPipelineUiSnapshot
  );
  const entry = id ? snap.byTaskId[id] : null;
  const ui = entry?.ui ?? initialCuriosityPipelineUi();
  const ms = ui.moduleStatuses && typeof ui.moduleStatuses === 'object' ? ui.moduleStatuses : {};
  const isRunning = Boolean(id && entry && getFirstProcessingModuleId(ms));

  return (
    <PipelineExecutionLiveView
      moduleStatuses={ui.moduleStatuses}
      executionLog={ui.executionLog}
      moduleOutputs={ui.moduleOutputs}
      isRunning={isRunning}
      emptyRunningMessage={PIPELINE_LOG_EMPTY_RUNNING}
      emptyIdleMessage={PIPELINE_LOG_EMPTY_IDLE_SCHEDULER_BUFFER}
      lineKeyPrefix={id ? `sched-${id}` : 'sched-task'}
    />
  );
}
