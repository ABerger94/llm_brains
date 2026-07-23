/**
 * Dual playground (System Chat): session/profile invariants, peer Voice resolution, and pure helpers for
 * `Playground.jsx`, resume, and analytics.
 *
 * Storage rule: `playground-dual-b` and graph workspaces flagged in the session registry as mirror use the
 * mirror IndexedDB profile; others use primary — see `resolveGraphSessionMindStorageProfile`.
 */
import { ConversationMessage, MirrorConversationMessage } from './data';
import { filterConversationRowsForGraphSession } from './graphPipelineConversation';
import {
  PLAYGROUND_GRAPH_SESSION_A,
  PLAYGROUND_GRAPH_SESSION_B,
  PLAYGROUND_PEER_VOICE_PREFIX,
  PLAYGROUND_TWIN_PREAMBLE,
  composePlaygroundSystemAInput,
  composePlaygroundSystemAInputChained,
  composePlaygroundSystemBInput,
  inferMindStorageProfileFromGraphSessionId,
} from './playgroundDualGraphRunner';
import { resolveGraphSessionMindStorageProfile } from './graphSessionMindProfile';
import { MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR } from './mindEntityContext';
import { notifyMindStorageChanged } from './mindStorageEvents';

export {
  PLAYGROUND_GRAPH_SESSION_A,
  PLAYGROUND_GRAPH_SESSION_B,
  PLAYGROUND_PEER_VOICE_PREFIX,
  PLAYGROUND_TWIN_PREAMBLE,
  composePlaygroundSystemAInput,
  composePlaygroundSystemAInputChained,
  composePlaygroundSystemBInput,
  inferMindStorageProfileFromGraphSessionId,
};

/** Label for UI / live analytics accents. */
export const PLAYGROUND_SYSTEM_LABEL_A = 'System A (primary)';
export const PLAYGROUND_SYSTEM_LABEL_B = 'System B (mirror)';

/**
 * @param {string} sessionId
 * @returns {typeof MIND_STORAGE_PROFILE_PRIMARY | typeof MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR}
 */
export function mindStorageProfileForPlaygroundGraphSession(sessionId) {
  return resolveGraphSessionMindStorageProfile(sessionId);
}

/**
 * Which conversation entity to read for the latest assistant Voice for a playground graph session.
 * @param {string} sessionId
 * @returns {typeof ConversationMessage | typeof MirrorConversationMessage}
 */
export function conversationEntityForPlaygroundSession(sessionId) {
  return resolveGraphSessionMindStorageProfile(sessionId) === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR
    ? MirrorConversationMessage
    : ConversationMessage;
}

/**
 * Newest non-empty assistant line for a graph session (ConversationMessage rows for that graph session id).
 *
 * @param {typeof ConversationMessage | typeof MirrorConversationMessage} Entity
 * @param {string} sessionId
 */
export async function latestAssistantVoiceTextForGraphSession(Entity, sessionId) {
  const rows = await Entity.list('-created_date', 1200);
  const inSession = filterConversationRowsForGraphSession(rows, sessionId);
  const sorted = [...inSession].sort(
    (a, b) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime()
  );
  for (const r of sorted) {
    if ((r.role || '') === 'assistant') {
      const t = String(r.content || '').trim();
      if (t) return t;
    }
  }
  return '';
}

/**
 * Latest System B (mirror) Voice in the transcript. Both A→B and B→A rows store mirror output in `voiceB`.
 * @param {{ voiceB?: string }[]} turns
 */
export function lastSystemBVoiceInDialogue(turns) {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const v = String(turns[i].voiceB || '').trim();
    if (v) return v;
  }
  return '';
}

/** After a B→A block, the next B input is the last Voice A from a completed B-row. */
export function lastBaVoiceAForContinue(turns) {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i];
    if (t.target === 'B' && t.ok) {
      const v = String(t.voiceA || '').trim();
      if (v) return v;
    }
  }
  return '';
}

/** First human line in an A→B thread (non-chained A row). */
export function threadHumanAnchorAb(turns) {
  const t = turns.find((x) => x.target === 'A' && !x.dualChain);
  return t ? String(t.userLine || '').trim() : '';
}

/** Latest Voice A in the transcript (A→B and B→A rows both store it in `voiceA`). */
export function lastVoiceAInDialogue(turns) {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const v = String(turns[i].voiceA || '').trim();
    if (v) return v;
  }
  return '';
}

/** Prefer in-panel dual rows; else last persisted mirror Voice for the playground mirror session. */
export function lastSystemBVoiceForPeer(turns, persistedMirrorB) {
  const t = lastSystemBVoiceInDialogue(turns).trim();
  if (t) return t;
  return String(persistedMirrorB || '').trim();
}

/** Prefer in-panel rows; else last persisted primary Voice for playground-dual-a. */
export function lastVoiceAForPeer(turns, persistedPrimaryA) {
  const t = lastVoiceAInDialogue(turns).trim();
  if (t) return t;
  return String(persistedPrimaryA || '').trim();
}

/** First human line in a B→A thread (non-chained B row). */
export function threadHumanAnchorBa(turns) {
  const t = turns.find((x) => x.target === 'B' && !x.dualChain);
  return t ? String(t.userLine || '').trim() : '';
}

/** Latest Voice A from an A-started dual row (for Continue chaining). */
export function lastVoiceAFromAbDialogue(turns) {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i];
    if (t.target === 'A' && t.ok) {
      const v = String(t.voiceA || '').trim();
      if (v) return v;
    }
  }
  return '';
}

/**
 * Save the composer line as a synthetic assistant (Voice) row on the **peer** mind store for this graph session,
 * so the other system “said” the line before the first pipeline leg. Uses direct entity imports (not
 * {@link getMindEntityStores}) so dual orchestration cannot pick the wrong profile.
 *
 * @param {{ inputTarget: 'A' | 'B', userLine: string }} p
 */
export async function persistPlaygroundComposerAsPeerSyntheticVoice({ inputTarget, userLine }) {
  const content = String(userLine || '').trim();
  if (!content) return;

  if (inputTarget === 'A') {
    await MirrorConversationMessage.create({
      role: 'assistant',
      content,
      graph_session_id: PLAYGROUND_GRAPH_SESSION_B,
      source: 'playground_composer_peer_seed',
    });
  } else if (inputTarget === 'B') {
    await ConversationMessage.create({
      role: 'assistant',
      content,
      graph_session_id: PLAYGROUND_GRAPH_SESSION_A,
      source: 'playground_composer_peer_seed',
    });
  }

  notifyMindStorageChanged({ source: 'playground-composer-peer-seed' });
}
