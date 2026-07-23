/**
 * Server-side scheduler: ticks every 30s, picks up due tasks from SQLite, runs them via runPipeline.
 * Independent of any browser tab — enables 24/7 autonomous operation.
 */
import {
  getDuePendingScheduledTasks,
  updateScheduledTask,
  insertScheduledTask,
  isSchedulerPaused,
  getScheduledTask,
} from './workspaceDb.js';
import { runPipeline } from './pipeline.js';

let tickInterval = null;
let runningTaskIds = new Set();

const TICK_INTERVAL_MS = 30_000;
const MAX_CONCURRENT_SERVER_TASKS = 2;

/**
 * @param {(sp: string, uc: string, o?: object) => Promise<string>} callLLM
 */
export function startServerScheduler(callLLM) {
  if (tickInterval) return;
  console.info('[serverScheduler] starting (tick every %dms)', TICK_INTERVAL_MS);
  tickInterval = setInterval(() => void tickOnce(callLLM), TICK_INTERVAL_MS);
  void tickOnce(callLLM);
}

export function stopServerScheduler() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
    console.info('[serverScheduler] stopped');
  }
}

/**
 * @param {(sp: string, uc: string, o?: object) => Promise<string>} callLLM
 */
async function tickOnce(callLLM) {
  try {
    if (isSchedulerPaused()) return;
    if (runningTaskIds.size >= MAX_CONCURRENT_SERVER_TASKS) return;

    const slotsAvailable = MAX_CONCURRENT_SERVER_TASKS - runningTaskIds.size;
    const dueTasks = getDuePendingScheduledTasks(slotsAvailable);
    if (!dueTasks.length) return;

    for (const task of dueTasks) {
      if (runningTaskIds.has(task.id)) continue;
      runningTaskIds.add(task.id);
      void executeTask(task, callLLM).finally(() => {
        runningTaskIds.delete(task.id);
      });
    }
  } catch (err) {
    console.error('[serverScheduler] tick error', err);
  }
}

/**
 * @param {object} task
 * @param {(sp: string, uc: string, o?: object) => Promise<string>} callLLM
 */
async function executeTask(task, callLLM) {
  const id = task.id;
  const taskType = task.task_type;
  const inputText = task.input_text || '';
  console.info('[serverScheduler] executing', id, taskType);

  updateScheduledTask(id, { status: 'running' });
  try {
    let resultExcerpt = '';
    switch (taskType) {
      case 'pipeline_run':
      case 'exploration_run': {
        const prompt =
          inputText.trim() ||
          (taskType === 'exploration_run'
            ? 'Self-initiated server-side exploration. Follow your curiosity.'
            : 'Scheduled server-side pipeline run.');
        const result = await runPipeline({
          input: prompt,
          existingSharedMemory: null,
          callLLM,
          options: {},
          onEvent: () => {},
        });
        const voice = result?.sharedMemory?.moduleOutputs?.Voice || '';
        resultExcerpt = String(voice).slice(0, 2000) || 'completed (no voice output)';
        break;
      }
      case 'dual_dialogue': {
        const topic = inputText.trim() || 'Autonomous dual dialogue initiated by server scheduler.';
        const resultA = await runPipeline({
          input: `[SYSTEM CHAT — System A] ${topic}`,
          existingSharedMemory: null,
          callLLM,
          options: {},
          onEvent: () => {},
        });
        const voiceA = String(resultA?.sharedMemory?.moduleOutputs?.Voice || '').trim();
        if (voiceA) {
          const resultB = await runPipeline({
            input: `[SYSTEM CHAT — System B responding to A] ${voiceA}`,
            existingSharedMemory: null,
            callLLM,
            options: {},
            onEvent: () => {},
          });
          const voiceB = String(resultB?.sharedMemory?.moduleOutputs?.Voice || '').trim();
          resultExcerpt = `A: ${voiceA.slice(0, 800)} | B: ${voiceB.slice(0, 800)}`;
        } else {
          resultExcerpt = 'System A produced no voice output.';
        }
        break;
      }
      default: {
        const prompt =
          inputText.trim() || `Scheduled ${taskType} task. Process current context and produce output.`;
        const result = await runPipeline({
          input: prompt,
          existingSharedMemory: null,
          callLLM,
          options: {},
          onEvent: () => {},
        });
        const voice = result?.sharedMemory?.moduleOutputs?.Voice || '';
        resultExcerpt = String(voice).slice(0, 2000) || 'completed';
        break;
      }
    }

    const completedAt = new Date().toISOString();
    updateScheduledTask(id, {
      status: 'completed',
      completed_at: completedAt,
      result_excerpt: resultExcerpt,
    });

    maybeScheduleRecurrence(task);
    console.info('[serverScheduler] completed', id, taskType);
  } catch (err) {
    console.error('[serverScheduler] task failed', id, err);
    updateScheduledTask(id, {
      status: 'failed',
      result_excerpt: String(err?.message || err).slice(0, 2000),
    });
  }
}

function maybeScheduleRecurrence(task) {
  if (!task.recurrence || !task.recurrence_interval || !task.recurrence_unit) return;
  const now = new Date();
  if (task.recurrence_end_date) {
    const end = new Date(task.recurrence_end_date);
    if (!isNaN(end.getTime()) && now >= end) return;
  }
  const interval = Math.max(1, Math.floor(Number(task.recurrence_interval) || 1));
  const unit = String(task.recurrence_unit).toLowerCase();
  const next = new Date(now);
  switch (unit) {
    case 'minutes':
      next.setMinutes(next.getMinutes() + interval);
      break;
    case 'hours':
      next.setHours(next.getHours() + interval);
      break;
    case 'days':
      next.setDate(next.getDate() + interval);
      break;
    default:
      next.setMinutes(next.getMinutes() + interval);
  }

  insertScheduledTask({
    taskType: task.task_type,
    scheduledAt: next.toISOString(),
    inputText: task.input_text,
    reason: task.reason,
    mindStorageProfile: task.mind_storage_profile,
    scheduledBy: 'server_scheduler_recurrence',
    recurrence: task.recurrence,
    recurrenceInterval: task.recurrence_interval,
    recurrenceUnit: task.recurrence_unit,
    recurrenceEndDate: task.recurrence_end_date,
  });
}
