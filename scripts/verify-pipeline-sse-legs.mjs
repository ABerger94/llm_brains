/**
 * Contract tests for supervisor RERUN SSE chaining (no LLM, no Vite).
 * Mirrors src/lib/pipelineSse.js consumePipelineSse + multi-leg loop — update if that logic changes.
 *
 * Run: node scripts/verify-pipeline-sse-legs.mjs
 */
import { normalizeExecutionResume } from '../shared/pipelineExecutionResume.mjs';
import { slimSharedMemoryForPipelinePost } from '../src/lib/slimSharedMemory.js';

/** Mirrors pipelineSse.js synthetic pause result (keep in sync). */
function buildSyntheticPauseResult(pausedEvt) {
  const sm = pausedEvt.sharedMemory && typeof pausedEvt.sharedMemory === 'object' ? pausedEvt.sharedMemory : null;
  const ecRaw = pausedEvt.executionCursor;
  const executionCursor =
    ecRaw && typeof ecRaw === 'object'
      ? ecRaw
      : {
          v: 1,
          phase: pausedEvt.phase,
          nextModuleName: pausedEvt.nextModuleName,
        };
  const ru = sm?.metacognitionRerunsUsed;
  const rerunsUsed =
    typeof ru === 'number' && Number.isFinite(ru) ? ru : Number(pausedEvt.rerunsUsed) || 0;
  return {
    type: 'paused',
    pipelinePaused: true,
    sharedMemory: sm,
    executionCursor,
    voiceOutput: '',
    partial: true,
    rerunsUsed,
    providerUsed: sm?.lastProviderUsed ?? null,
    modelUsed: sm?.lastModelUsed ?? null,
  };
}

function processSseBuffer(buffer, onEvent) {
  let rest = buffer;
  for (;;) {
    const sep = rest.indexOf('\n\n');
    if (sep === -1) break;
    const chunk = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    for (const line of chunk.split('\n')) {
      if (line.startsWith('data:')) {
        const rawLine = line.slice(5).trim();
        if (!rawLine) continue;
        try {
          onEvent(JSON.parse(rawLine));
        } catch (e) {
          console.warn('SSE parse error', e);
        }
      }
    }
  }
  return rest;
}

async function consumePipelineSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value?.byteLength) {
      buffer += decoder.decode(value, { stream: true });
    }
    buffer = processSseBuffer(buffer, onEvent);
    if (done) {
      buffer += decoder.decode();
      processSseBuffer(buffer, onEvent);
      break;
    }
  }
}

/** Same control flow as consumePipelineSseWithMetacognitionContinuations (dashboard patch omitted). */
async function consumeLegs({
  buildFetchInit,
  initialSlimSharedMemory = null,
  fetchImpl,
  maxLegs = 25,
  treatFirstLegAsContinuation = false,
}) {
  let slimSm = initialSlimSharedMemory;
  let streamResult = null;
  const streamUrl = '/api/pipeline/stream';

  for (let leg = 1; leg <= maxLegs; leg += 1) {
    streamResult = null;
    const pipelineMetacognitionContinuation =
      leg > 1 || (leg === 1 && treatFirstLegAsContinuation === true);
    const init = await buildFetchInit({
      leg,
      slimSharedMemory: slimSm,
      pipelineMetacognitionContinuation,
    });
    const res = await fetchImpl(streamUrl, init);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    let continuation = null;
    let pausedEvt = null;
    await consumePipelineSse(res, (evt) => {
      if (evt.type === 'error') {
        throw new Error(evt.message || 'Pipeline failed');
      }
      if (evt.type === 'pipeline_continuation') continuation = evt;
      if (evt.type === 'complete') streamResult = evt;
      if (evt.type === 'paused') pausedEvt = evt;
    });

    if (streamResult) return streamResult;
    if (pausedEvt) {
      return buildSyntheticPauseResult(pausedEvt);
    }
    if (continuation) {
      if (!continuation.sharedMemory || typeof continuation.sharedMemory !== 'object') {
        throw new Error(
          'Supervisor continuation event is missing sharedMemory — cannot POST the next pipeline leg (check server slimSharedMemoryForSse / SSE payload size).'
        );
      }
      slimSm = slimSharedMemoryForPipelinePost(continuation.sharedMemory, { continuation: true });
      continue;
    }
    throw new Error('Stream ended without a complete or pipeline_continuation event.');
  }

  throw new Error(`Pipeline exceeded ${maxLegs} metacognition continuation legs.`);
}

function sseResponse(lines) {
  const encoder = new TextEncoder();
  const text = lines.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('');
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

let fetchLeg = 0;

async function testChainedContinuationThenComplete() {
  fetchLeg = 0;
  const contSm = {
    moduleOutputs: { Metacognition: 'PROCEED' },
    originalInput: 'verify-pipeline-sse-legs',
    metacognitionRerunsUsed: 1,
  };
  const finalSm = {
    moduleOutputs: { Voice: 'All good.' },
    originalInput: 'verify-pipeline-sse-legs',
    metacognitionRerunsUsed: 1,
  };

  const fetchImpl = async () => {
    fetchLeg += 1;
    if (fetchLeg === 1) {
      return sseResponse([
        { type: 'module_complete', moduleName: 'Metacognition', layer: 'layer5', output: 'PROCEED' },
        {
          type: 'pipeline_continuation',
          sharedMemory: contSm,
          supervisor: 'Metacognition',
          reason: 'unit-test',
        },
      ]);
    }
    if (fetchLeg === 2) {
      return sseResponse([
        {
          type: 'complete',
          voiceOutput: 'All good.',
          sharedMemory: finalSm,
          rerunsUsed: 1,
        },
      ]);
    }
    throw new Error(`unexpected fetch leg ${fetchLeg}`);
  };

  const result = await consumeLegs({
    fetchImpl,
    initialSlimSharedMemory: null,
    maxLegs: 8,
    buildFetchInit: ({ leg, slimSharedMemory, pipelineMetacognitionContinuation }) => {
      if (leg === 1 && pipelineMetacognitionContinuation) {
        throw new Error('first HTTP leg must not set pipelineMetacognitionContinuation');
      }
      if (leg >= 2 && !pipelineMetacognitionContinuation) {
        throw new Error('leg 2+ must be continuation');
      }
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          input: 'verify-pipeline-sse-legs',
          attachmentIds: [],
          sharedMemory: slimSharedMemory,
          options: {
            ...(pipelineMetacognitionContinuation ? { pipelineMetacognitionContinuation: true } : {}),
          },
        }),
      };
    },
  });

  if (result?.type !== 'complete') throw new Error(`expected final complete, got ${result?.type}`);
  if (String(result.voiceOutput || '').trim() !== 'All good.') {
    throw new Error(`unexpected voiceOutput: ${result.voiceOutput}`);
  }
  if (fetchLeg !== 2) throw new Error(`expected 2 fetch legs, got ${fetchLeg}`);
  console.log('verify-pipeline-sse-legs: chained continuation → complete OK');
}

async function testContinuationMissingSharedMemoryThrows() {
  fetchLeg = 0;
  const fetchImpl = async () => {
    fetchLeg += 1;
    return sseResponse([
      { type: 'pipeline_continuation', supervisor: 'Metacognition', reason: 'bad', sharedMemory: null },
    ]);
  };

  let threw = false;
  try {
    await consumeLegs({
      fetchImpl,
      initialSlimSharedMemory: null,
      maxLegs: 4,
      buildFetchInit: ({ slimSharedMemory, pipelineMetacognitionContinuation }) => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: 'x',
          attachmentIds: [],
          sharedMemory: slimSharedMemory,
          options: {
            ...(pipelineMetacognitionContinuation ? { pipelineMetacognitionContinuation: true } : {}),
          },
        }),
      }),
    });
  } catch (e) {
    threw = true;
    if (!String(e?.message || '').includes('sharedMemory')) {
      throw new Error(`wrong error: ${e?.message}`);
    }
  }
  if (!threw) throw new Error('expected missing sharedMemory to throw');
  console.log('verify-pipeline-sse-legs: missing continuation sharedMemory throws OK');
}

async function testPausedLegCarriesExecutionCursorAndReruns() {
  fetchLeg = 0;
  const executionCursor = { v: 1, phase: 'layer14', nextModuleName: 'Memory' };
  const pausedSm = {
    moduleOutputs: { Perception: 'ok' },
    metacognitionRerunsUsed: 2,
    lastProviderUsed: 'openrouter',
    lastModelUsed: 'x/y',
  };
  const fetchImpl = async () => {
    fetchLeg += 1;
    return sseResponse([
      {
        type: 'paused',
        nextModuleName: 'Memory',
        phase: 'layer14',
        executionCursor,
        sharedMemory: pausedSm,
        reason: 'cooperative_pause',
      },
    ]);
  };

  const result = await consumeLegs({
    fetchImpl,
    initialSlimSharedMemory: null,
    maxLegs: 4,
    buildFetchInit: ({ slimSharedMemory, pipelineMetacognitionContinuation }) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        input: 'x',
        attachmentIds: [],
        sharedMemory: slimSharedMemory,
        options: {
          ...(pipelineMetacognitionContinuation ? { pipelineMetacognitionContinuation: true } : {}),
        },
      }),
    }),
  });

  if (!result?.pipelinePaused) throw new Error('expected pipelinePaused');
  if (normalizeExecutionResume(result.executionCursor) == null) {
    throw new Error('executionCursor failed normalizeExecutionResume');
  }
  if (result.rerunsUsed !== 2) throw new Error(`rerunsUsed expected 2, got ${result.rerunsUsed}`);
  if (result.providerUsed !== 'openrouter') throw new Error('providerUsed');
  if (result.modelUsed !== 'x/y') throw new Error('modelUsed');
  console.log('verify-pipeline-sse-legs: paused leg (executionCursor + reruns) OK');
}

await testChainedContinuationThenComplete();
await testContinuationMissingSharedMemoryThrows();
await testPausedLegCarriesExecutionCursorAndReruns();
console.log('verify-pipeline-sse-legs: all checks passed');
