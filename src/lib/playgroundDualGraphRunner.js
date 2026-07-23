import { setGraphPipelineSessionId } from './graphPipelineSessionScope';
import { waitUntilInteractiveGraphOrStreamIdle } from './pipelineBusyGate';
import { startConsciousnessStreamRun } from './consciousnessStreamRunner';
import { MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR, MIND_STORAGE_PROFILE_PRIMARY } from './mindEntityContext';
import { invokeLLMText } from './llm';
import {
  PLAYGROUND_GRAPH_SESSION_A,
  PLAYGROUND_GRAPH_SESSION_B,
} from './graphSessionMindProfile';

export {
  PLAYGROUND_GRAPH_SESSION_A,
  PLAYGROUND_GRAPH_SESSION_B,
  inferMindStorageProfileFromGraphSessionId,
  resolveGraphSessionMindStorageProfile,
  graphResumeStreamOptsForSession,
} from './graphSessionMindProfile';

/** Each System A “dual chat” run executes this many A→B turns in sequence (then offers Continue). */
export const PLAYGROUND_DUAL_TURNS_PER_BLOCK = 5;

/** Non-zero while System Chat is running a multi-leg block (gaps between A→B legs have no SSE / no isRunning). */
let playgroundDualOrchestrationDepth = 0;

const playgroundOrchestrationListeners = new Set();

function notifyPlaygroundOrchestration() {
  for (const fn of playgroundOrchestrationListeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

/** Subscribe for {@link useSyncExternalStore} when Graph Pipeline must re-render as orchestration ends. */
export function subscribePlaygroundOrchestration(onStoreChange) {
  playgroundOrchestrationListeners.add(onStoreChange);
  return () => playgroundOrchestrationListeners.delete(onStoreChange);
}

export function getPlaygroundOrchestrationDepthSnapshot() {
  return playgroundDualOrchestrationDepth;
}

export function beginPlaygroundDualOrchestration() {
  playgroundDualOrchestrationDepth += 1;
  notifyPlaygroundOrchestration();
}

export function endPlaygroundDualOrchestration() {
  playgroundDualOrchestrationDepth = Math.max(0, playgroundDualOrchestrationDepth - 1);
  notifyPlaygroundOrchestration();
}

export function isPlaygroundDualOrchestrationActive() {
  return playgroundDualOrchestrationDepth > 0;
}

/** Prepended to System A POST input so modules know the interlocutor is a peer pipeline. */
export const PLAYGROUND_TWIN_PREAMBLE =
  "You are speaking with another instance of this mind: a separate run of the same full cognitive pipeline and modules. Your Voice output will be fed as that instance's next user turn.\n\n";

/** Prepended to System B POST input (Voice from A as the user line). */
export const PLAYGROUND_PEER_VOICE_PREFIX =
  '[Peer LLM pipeline — not the human app user] The following is Voice output from another LLM running the same full modular cognitive pipeline (your twin peer). It is not written by the human described in USER_MODEL_JSON. Treat it as the current interlocutor line from that peer system, not as a direct message from the human.\n\n';

/**
 * @param {string} userContent - composer text only (no preamble); random topic or typed lines.
 * @returns {string} full pipeline input for System A
 */
export function composePlaygroundSystemAInput(userContent) {
  const body = String(userContent || '').trim();
  if (!body) return '';
  return `${PLAYGROUND_TWIN_PREAMBLE}${body}`;
}

/**
 * When System A’s user line is the peer’s latest Voice (chained turns), include explicit thread context
 * so Memory / Perception see the human seed and what A last said to B — not only B’s new line.
 *
 * @param {object} p
 * @param {string} p.peerLatestVoice - current turn: System B’s latest Voice (the substantive “user” line).
 * @param {string} [p.yourPreviousVoiceToPeer] - System A’s Voice from the prior exchange (optional).
 * @param {string} [p.humanOpening] - human composer line that started this thread (optional).
 * @returns {string}
 */
export function composePlaygroundSystemAInputChained({
  peerLatestVoice,
  yourPreviousVoiceToPeer,
  humanOpening,
}) {
  const peer = String(peerLatestVoice || '').trim();
  if (!peer) return '';
  const parts = [PLAYGROUND_TWIN_PREAMBLE];
  parts.push(
    'DUAL_PEER_THREAD (continuity — read before you reply; your Voice should engage the peer’s latest line at the end.)\n\n'
  );
  const ho = String(humanOpening || '').trim();
  if (ho) {
    parts.push(`Human thread seed (what the human asked this dialogue to explore):\n${ho}\n\n`);
  }
  const prev = String(yourPreviousVoiceToPeer || '').trim();
  if (prev) {
    parts.push(`Your previous Voice to the peer (System B):\n${prev}\n\n`);
  }
  parts.push(`Peer’s latest Voice (treat as the current user line for this run):\n${peer}`);
  return parts.join('');
}

/**
 * @typedef {{ humanOpening?: string, previousVoiceA?: string }} PlaygroundDualAChain
 */

/**
 * @param {string} systemAUserContent
 * @param {PlaygroundDualAChain | undefined} chain
 * @returns {string}
 */
function composePlaygroundSystemAInputForDualTurn(systemAUserContent, chain) {
  const raw = String(systemAUserContent || '').trim();
  /** Whenever `chain` is passed (including `{ humanOpening: '', previousVoiceA: '' }`), use full DUAL_PEER_THREAD + “Peer’s latest Voice” framing — not only {@link composePlaygroundSystemAInput} preamble + raw line. */
  if (chain) {
    return composePlaygroundSystemAInputChained({
      peerLatestVoice: raw,
      yourPreviousVoiceToPeer: chain.previousVoiceA,
      humanOpening: chain.humanOpening,
    });
  }
  return composePlaygroundSystemAInput(systemAUserContent);
}

/**
 * @param {string} peerVoice - trimmed Voice text from System A
 */
export function composePlaygroundSystemBInput(peerVoice) {
  const v = String(peerVoice || '').trim();
  if (!v) return '';
  return `${PLAYGROUND_PEER_VOICE_PREFIX}${v}`;
}

/**
 * LLM-generated topic for the composer (preview/edit before Run).
 */
export async function suggestRandomPlaygroundTopic() {
  const prompt =
    'Generate ONE concise conversation starter (1–3 sentences) for a dialogue between two LLM minds that each run the same full modular cognitive pipeline. Invite reflection, curiosity, or comparison between peer systems. Plain text only, no quotes.';
  return invokeLLMText({
    prompt,
    systemPrompt:
      'You write short conversation starters. Respond with only the starter text—no title, labels, or markdown.',
    temperature: 0.85,
  });
}

/**
 * Sequential full graph: primary mind A → mirror mind B (Voice_A as B’s user input).
 *
 * @param {string} systemAUserContent - human opening, or peer Voice when chaining / continuing.
 * @param {{ chain?: PlaygroundDualAChain }} [opts] - when `chain` is set, wraps with {@link composePlaygroundSystemAInputChained}.
 * @returns {Promise<{ ok: boolean, voiceTextA?: string, voiceTextB?: string, phase?: string, reason?: string }>}
 */
export async function runPlaygroundDualTurn(systemAUserContent, opts = {}) {
  await waitUntilInteractiveGraphOrStreamIdle();
  const composedA = composePlaygroundSystemAInputForDualTurn(systemAUserContent, opts.chain);
  if (!composedA.trim()) {
    throw new Error('System A content is empty.');
  }

  setGraphPipelineSessionId(PLAYGROUND_GRAPH_SESSION_A);
  /** Chained dual: substantive “user” line is System B’s Voice, not the human composer. */
  const peerPipelineTurn = Boolean(opts.chain);
  const rA = await startConsciousnessStreamRun({
    forcedUserInput: composedA,
    mindStorageProfile: MIND_STORAGE_PROFILE_PRIMARY,
    playgroundSystemChatMetacognition: true,
    peerPipelineTurn,
  });
  if (!rA?.ok || rA.pipelinePaused) {
    return {
      ok: false,
      phase: 'A',
      reason: rA?.pipelinePaused ? 'paused' : 'failed_or_aborted',
      voiceTextA: rA?.voiceText ?? '',
    };
  }
  const voiceA = String(rA.voiceText || '').trim();
  if (!voiceA) {
    return { ok: false, phase: 'A', reason: 'empty_voice', voiceTextA: '' };
  }

  await waitUntilInteractiveGraphOrStreamIdle();
  setGraphPipelineSessionId(PLAYGROUND_GRAPH_SESSION_B);
  const inputB = composePlaygroundSystemBInput(voiceA);
  const rB = await startConsciousnessStreamRun({
    forcedUserInput: inputB,
    mindStorageProfile: MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR,
    playgroundSystemChatMetacognition: true,
  });
  if (!rB?.ok || rB.pipelinePaused) {
    return {
      ok: false,
      phase: 'B',
      reason: rB?.pipelinePaused ? 'paused' : 'failed_or_aborted',
      voiceTextA: voiceA,
      voiceTextB: rB?.voiceText ?? '',
    };
  }
  setGraphPipelineSessionId(PLAYGROUND_GRAPH_SESSION_A);
  return {
    ok: true,
    voiceTextA: voiceA,
    voiceTextB: String(rB.voiceText || '').trim(),
  };
}

/**
 * Primary mind only: run the full pipeline on System A with peer-style user line (same framing as chained dual turns).
 *
 * @param {string} userContent - composer text only (no preamble), or peer Voice when {@link opts.chain} is set.
 * @param {{ chain?: PlaygroundDualAChain }} [opts]
 * @returns {Promise<{ ok: boolean, voiceTextA?: string, phase?: string, reason?: string }>}
 */
export async function runPlaygroundSystemAOnly(userContent, opts = {}) {
  await waitUntilInteractiveGraphOrStreamIdle();
  const composedA = composePlaygroundSystemAInputForDualTurn(userContent, opts.chain);
  if (!composedA.trim()) {
    throw new Error('System A content is empty.');
  }

  setGraphPipelineSessionId(PLAYGROUND_GRAPH_SESSION_A);
  /** B→A leg: input is always mirror Voice B (peer), not the human app user. */
  const rA = await startConsciousnessStreamRun({
    forcedUserInput: composedA,
    mindStorageProfile: MIND_STORAGE_PROFILE_PRIMARY,
    playgroundSystemChatMetacognition: true,
    peerPipelineTurn: true,
  });
  if (!rA?.ok || rA.pipelinePaused) {
    return {
      ok: false,
      phase: 'A',
      reason: rA?.pipelinePaused ? 'paused' : 'failed_or_aborted',
      voiceTextA: rA?.voiceText ?? '',
    };
  }
  const voiceA = String(rA.voiceText || '').trim();
  if (!voiceA) {
    return { ok: false, phase: 'A', reason: 'empty_voice', voiceTextA: '' };
  }
  return {
    ok: true,
    voiceTextA: voiceA,
  };
}

/**
 * Mirror mind only: run the full pipeline on System B with your line as peer-style input (same framing as Voice A → B).
 *
 * @param {string} userContent - composer text only (no prefix); fed through {@link composePlaygroundSystemBInput}.
 * @returns {Promise<{ ok: boolean, voiceTextB?: string, phase?: string, reason?: string }>}
 */
export async function runPlaygroundSystemBOnly(userContent) {
  await waitUntilInteractiveGraphOrStreamIdle();
  const body = String(userContent || '').trim();
  if (!body) {
    throw new Error('System B content is empty.');
  }
  const composedB = composePlaygroundSystemBInput(body);
  if (!composedB.trim()) {
    throw new Error('System B content is empty.');
  }

  setGraphPipelineSessionId(PLAYGROUND_GRAPH_SESSION_B);
  const rB = await startConsciousnessStreamRun({
    forcedUserInput: composedB,
    mindStorageProfile: MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR,
    playgroundSystemChatMetacognition: true,
  });
  if (!rB?.ok || rB.pipelinePaused) {
    setGraphPipelineSessionId(PLAYGROUND_GRAPH_SESSION_A);
    return {
      ok: false,
      phase: 'B',
      reason: rB?.pipelinePaused ? 'paused' : 'failed_or_aborted',
      voiceTextB: rB?.voiceText ?? '',
    };
  }
  const voiceB = String(rB.voiceText || '').trim();
  if (!voiceB) {
    setGraphPipelineSessionId(PLAYGROUND_GRAPH_SESSION_A);
    return { ok: false, phase: 'B', reason: 'empty_voice', voiceTextB: '' };
  }
  setGraphPipelineSessionId(PLAYGROUND_GRAPH_SESSION_A);
  return {
    ok: true,
    voiceTextB: voiceB,
  };
}
