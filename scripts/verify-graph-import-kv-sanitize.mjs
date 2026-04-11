/**
 * Sanity check: import KV sanitizer clears ghost running flags and stale pause tokens;
 * entity sanitizer demotes imported ScheduledTask rows stuck in `running`.
 */
import {
  GRAPH_PIPELINE_SESSIONS_REGISTRY_KEY,
  sanitizeGraphPipelineRelatedKvEntries,
} from '../src/lib/graphPipelineImportKvSanitize.js';
import { sanitizeImportedEntityRecords } from '../src/lib/mindArchiveImportSanitize.js';

const registry = [
  { id: 'default', label: 'Default', createdAt: 1, updatedAt: 2, isProcessing: true },
  { id: 's1', label: 'A', createdAt: 1, updatedAt: 3, isProcessing: true },
];

const graphUi = {
  isRunning: true,
  uploading: true,
  cooperativePauseToken: 'dead-token',
  moduleStatuses: { Perception: 'processing', Voice: 'complete' },
  pipelineCheckpoint: { executionCursor: { v: 1 }, slimSharedMemory: { moduleOutputs: {} } },
  runInterrupted: true,
};

const draft = { inFlight: true, entries: [{ type: 'user-input', content: 'hi' }] };

const input = {
  [GRAPH_PIPELINE_SESSIONS_REGISTRY_KEY]: JSON.stringify(registry),
  mybrain_graph_pipeline_ui_v2: JSON.stringify(graphUi),
  'mybrain_graph_pipeline_ui_v2__s_abc': JSON.stringify({ ...graphUi, cooperativePauseToken: 'x' }),
  mybrain_graph_pipeline_ui_v1: JSON.stringify({ ...graphUi }),
  'mybrain_graph_pipeline_ui_v1__s_old': JSON.stringify({ ...graphUi }),
  mybrain_consciousness_stream_draft_v1: JSON.stringify(draft),
  'mybrain_consciousness_stream_draft_v1__s_abc': JSON.stringify(draft),
  mybrain_other_kv: 'keep',
};

const out = sanitizeGraphPipelineRelatedKvEntries(input);

const regOut = JSON.parse(out[GRAPH_PIPELINE_SESSIONS_REGISTRY_KEY]);
if (regOut.some((r) => r.isProcessing !== false)) {
  console.error('fail: registry isProcessing should all be false');
  process.exit(1);
}

function assertGraphUi(key) {
  const g = JSON.parse(out[key]);
  if (g.isRunning !== false || g.uploading !== false || g.cooperativePauseToken !== '') {
    console.error('fail: graph UI flags/token', key);
    process.exit(1);
  }
  if (g.moduleStatuses.Perception !== undefined || g.moduleStatuses.Voice !== 'complete') {
    console.error('fail: moduleStatuses strip processing only', key, g.moduleStatuses);
    process.exit(1);
  }
  if (!g.pipelineCheckpoint || !g.runInterrupted) {
    console.error('fail: should preserve checkpoint + runInterrupted', key);
    process.exit(1);
  }
}

assertGraphUi('mybrain_graph_pipeline_ui_v2');
assertGraphUi('mybrain_graph_pipeline_ui_v2__s_abc');
assertGraphUi('mybrain_graph_pipeline_ui_v1');
assertGraphUi('mybrain_graph_pipeline_ui_v1__s_old');

const d1 = JSON.parse(out.mybrain_consciousness_stream_draft_v1);
const d2 = JSON.parse(out['mybrain_consciousness_stream_draft_v1__s_abc']);
if (d1.inFlight !== false || d2.inFlight !== false || d1.entries.length !== 1) {
  console.error('fail: draft inFlight');
  process.exit(1);
}

if (out.mybrain_other_kv !== 'keep') {
  console.error('fail: unrelated keys untouched');
  process.exit(1);
}

const taskRows = [
  { id: 't1', entityType: 'ScheduledTask', value: { status: 'running', task_type: 'curiosity_pursuit' } },
  { id: 't2', entityType: 'ScheduledTask', value: { status: 'pending' } },
  { id: 'c1', entityType: 'CuriosityItem', value: { question: 'q' } },
];
const sanitizedTasks = sanitizeImportedEntityRecords(taskRows);
const s0 = sanitizedTasks[0].value;
if (s0.status !== 'failed' || typeof s0.completed_at !== 'string' || !String(s0.result_summary || '').includes('Import')) {
  console.error('fail: running ScheduledTask should become failed with summary', s0);
  process.exit(1);
}
if (sanitizedTasks[1].value.status !== 'pending') {
  console.error('fail: pending task unchanged');
  process.exit(1);
}
if (sanitizedTasks[2].entityType !== 'CuriosityItem') {
  console.error('fail: non-ScheduledTask row unchanged');
  process.exit(1);
}

console.log('verify-graph-import-kv-sanitize: ok (KV + ScheduledTask rows)');
