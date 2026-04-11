/**
 * Sanity checks for buildConsciousnessStreamRenderPlan (consciousness stream UI grouping).
 */
import { buildConsciousnessStreamRenderPlan } from '../src/lib/conversationStreamRenderPlan.js';

function assert(cond, msg) {
  if (!cond) {
    console.error('fail:', msg);
    process.exit(1);
  }
}

// 1) Hydrated-style turn: meta before voice, system after → all non-user/voice in pipeline
const hydrated = [
  { id: 'u1', type: 'user-input', content: 'hi', time: '1' },
  { id: 'm1', type: 'meta-calibration', content: 'decision=x', time: '2' },
  { id: 'v1', type: 'voice', content: 'hello', moduleId: 'voice', time: '3' },
  { id: 's1', type: 'system', content: 'Reruns used: 1', time: '3' },
];
const p1 = buildConsciousnessStreamRenderPlan(hydrated, false);
assert(p1.length === 1 && p1[0].kind === 'foldedTurn', 'hydrated: one folded turn');
assert(p1[0].pipelineEntries.length === 2, 'hydrated: meta + system in pipeline');
assert(p1[0].voiceEntry.id === 'v1', 'hydrated: voice entry');

// 2) Live-style: module-thought voice + tail
const live = [
  { id: 'u2', type: 'user-input', content: 'q', time: '1' },
  { id: 'sys', type: 'system', content: 'init', time: '2' },
  { id: 'vt', type: 'module-thought', moduleId: 'voice', content: 'spoken', time: '3' },
  { id: 'mc', type: 'module-complete', moduleId: 'voice', content: '✓ Voice', time: '4' },
  { id: 'saved', type: 'system', content: 'Stream saved', time: '5' },
];
const p2 = buildConsciousnessStreamRenderPlan(live, false);
assert(p2.length === 1 && p2[0].kind === 'foldedTurn', 'live: folded');
assert(
  p2[0].pipelineEntries.some((e) => e.id === 'sys') && p2[0].pipelineEntries.some((e) => e.id === 'mc'),
  'live: sys + complete in pipeline'
);
assert(p2[0].voiceEntry.id === 'vt', 'live: module-thought is voice');
assert(p2[0].pipelineEntries.some((e) => e.id === 'saved'), 'live: saved line in pipeline');

// 3) Last turn in-flight → flat (full detail)
const p3 = buildConsciousnessStreamRenderPlan(live, true);
assert(p3.length === 1 && p3[0].kind === 'flat', 'in-flight: flat');
assert(p3[0].entries.length === live.length, 'in-flight: all entries');

// 4) Error turn (no voice) → flat
const err = [
  { id: 'u3', type: 'user-input', content: 'q', time: '1' },
  { id: 'e1', type: 'system', content: 'Error: boom', time: '2' },
];
const p4 = buildConsciousnessStreamRenderPlan(err, false);
assert(p4.length === 1 && p4[0].kind === 'flat', 'error: flat');
assert(p4[0].entries.length === 2, 'error: both rows');

// 5) Older folded + newer flat when last is in-flight
const two = [...hydrated, ...live];
const p5 = buildConsciousnessStreamRenderPlan(two, true);
assert(p5.length === 2, 'two segments');
assert(p5[0].kind === 'foldedTurn', 'first turn folded');
assert(p5[1].kind === 'flat', 'last turn flat while processing');

console.log('verify-conversation-stream-plan: ok');
