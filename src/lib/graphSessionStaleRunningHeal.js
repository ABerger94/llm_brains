import { getKvSync, removeKvSync, setKvSync } from './browserStorage';
import { graphPipelineStore } from './graphPipelineStore';
import { consciousnessStreamStore } from './consciousnessStreamStore';
import {
  getActiveConsciousnessStreamGraphSessionId,
  isInteractiveStreamFetchAlive,
} from './consciousnessStreamRunner';
import {
  consciousnessStreamDraftKeyForSessionId,
  graphPipelineUiLegacyFallbackKeyForSessionId,
  graphPipelineUiStorageKeyForSessionId,
  getGraphPipelineSessionId,
} from './graphPipelineSessionScope';
import {
  getGraphPipelineSessionRegistry,
  patchGraphPipelineSessionIfInRegistry,
} from './graphPipelineSessionRegistry';
import { peekConsciousnessStreamDraftForSession, peekGraphPipelineUiPersisted } from './graphPipelineCrossSessionPeek';
import { hasKnownPipelineModuleProcessing } from './cognitiveModules';

function peekHasProcessingModule(peek) {
  const ms = peek?.moduleStatuses && typeof peek.moduleStatuses === 'object' ? peek.moduleStatuses : {};
  return hasKnownPipelineModuleProcessing(ms);
}

/**
 * Reset registry + per-session persisted graph/stream flags after reload, crash, or disconnect left
 * `isProcessing` / `isRunning` / `inFlight` stuck true with no live runner in this tab.
 *
 * @param {string} sessionId
 * @param {{ force?: boolean }} [opts] — `force: true` clears moduleStatuses even when a checkpoint
 *   exists (explicit user "Stop" vs. automatic heal).
 */
export function clearGraphSessionStaleRunningState(sessionId, { force = false } = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid || typeof window === 'undefined') return;

  const pk = graphPipelineUiStorageKeyForSessionId(sid);
  const fk = graphPipelineUiLegacyFallbackKeyForSessionId(sid);
  const keysToWrite = [];
  if (pk) keysToWrite.push(pk);
  if (fk && fk !== pk) keysToWrite.push(fk);

  for (const k of keysToWrite) {
    try {
      const raw = getKvSync(k);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') continue;
      parsed.isRunning = false;
      parsed.uploading = false;
      parsed.cooperativePauseToken = '';
      if (force) {
        parsed.moduleStatuses = {};
      } else if (!(parsed.pipelineCheckpoint && typeof parsed.pipelineCheckpoint === 'object')) {
        parsed.moduleStatuses = {};
      }
      setKvSync(k, JSON.stringify(parsed));
    } catch {
      /* ignore */
    }
  }

  const dk = consciousnessStreamDraftKeyForSessionId(sid);
  if (dk) {
    try {
      const raw = getKvSync(dk);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          const entries = Array.isArray(p.entries) ? p.entries : [];
          if (entries.length === 0) {
            removeKvSync(dk);
          } else {
            setKvSync(dk, JSON.stringify({ ...p, inFlight: false }));
          }
        }
      }
    } catch {
      try {
        removeKvSync(dk);
      } catch {
        /* ignore */
      }
    }
  }

  patchGraphPipelineSessionIfInRegistry({ id: sid, isProcessing: false });

  if (getGraphPipelineSessionId() === sid) {
    graphPipelineStore.rehydrateFromPersisted();
  }
}

/**
 * If the registry still says “running” but persisted graph + stream draft both look idle, fix the registry.
 * Never clears the session this tab is actively streaming ({@link getActiveConsciousnessStreamGraphSessionId} +
 * in-memory busy), or when peek still shows a module in `processing` (KV can lead `isRunning` by one flush).
 */
export function healGraphRegistryWhenPersistSaysIdle() {
  if (typeof window === 'undefined') return;
  const reg = getGraphPipelineSessionRegistry();
  const streamSid = getActiveConsciousnessStreamGraphSessionId();
  const gp = graphPipelineStore.getState();
  const cs = consciousnessStreamStore.getState();
  const thisTabPipelineBusy = Boolean(gp.isRunning || cs.isProcessing);

  const sseAlive = isInteractiveStreamFetchAlive();

  for (const s of reg) {
    const id = String(s?.id || '').trim();
    if (!id) continue;

    // Never touch the session this tab is actively streaming.  Check BOTH the
    // SSE AbortController ref AND the in-memory store flags — either one alone
    // is sufficient proof that the pipeline is live.
    if (sseAlive && streamSid === id) continue;
    if (thisTabPipelineBusy && streamSid === id) continue;

    const peek = peekGraphPipelineUiPersisted(id);
    const draft = peekConsciousnessStreamDraftForSession(id);
    const graphSaysRunning = Boolean(peek?.isRunning);
    const streamSaysBusy = Boolean(draft.inFlight);
    const hasProcessing = peekHasProcessingModule(peek);

    const anyFlagStuck = s.isProcessing || graphSaysRunning || streamSaysBusy;
    if (anyFlagStuck && !hasProcessing) {
      clearGraphSessionStaleRunningState(id, { force: true });
    }
  }
}
