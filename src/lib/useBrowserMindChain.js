/**
 * Ported from llm_brains' lib/useMindChain.ts. Drives the 22-module
 * browserMindChain.js pipeline against a WebGPU engine (browserLlmEngine.js),
 * with memory persisted locally via browserMindMemory.js.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MIND_CHAIN,
  METACOGNITION_MAX_RERUNS,
  MAX_TOTAL_MODULE_CALLS,
  sanitizeStageText,
  parseModuleRerunDirectives,
  parseMetacognitionVerdict,
  parsePhi,
} from './browserMindChain';
import { loadEngine, runStage, unloadEngine } from './browserLlmEngine';
import {
  clearMemory as clearPersistedMemory,
  fetchMindSnapshot,
  getTemporalSnapshot,
  retrieveRelevantEpisodes,
  saveSession,
} from './browserMindMemory';

function isDeviceLostError(e) {
  const message = e instanceof Error ? e.message : String(e);
  return /device|context lost|gpu/i.test(message);
}

/** Lets the browser breathe between heavy WebGPU calls instead of monopolizing the main thread back-to-back for the whole run. */
function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const stageById = new Map(MIND_CHAIN.map((s) => [s.id, s]));
// Modules 1-15 (Perception..Metacognition): the span Metacognition can send back for a fresh pass.
const LOOP_MODULE_IDS = MIND_CHAIN.filter((s) => s.order <= 15).map((s) => s.id);
// Modules 16-22 (Integration..Voice): run once, after the loop above settles on PROCEED.
const TAIL_MODULE_IDS = MIND_CHAIN.filter((s) => s.order > 15).map((s) => s.id);

export function useBrowserMindChain() {
  const [engineStatus, setEngineStatus] = useState('idle');
  const [loadProgress, setLoadProgress] = useState(null);
  const [modelId, setModelId] = useState(null);
  const [stages, setStages] = useState(MIND_CHAIN.map((s) => ({ id: s.id, status: 'pending', text: '' })));
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);
  const [episodes, setEpisodes] = useState([]);
  const [identityNarrative, setIdentityNarrativeState] = useState('');
  const [rerunEvents, setRerunEvents] = useState([]);
  const [phi, setPhi] = useState(null);

  const engineRef = useRef(null);
  const abortRef = useRef(null);

  // Streaming tokens arrive far faster than the UI needs to redraw; batching
  // to one flush per animation frame cuts re-renders from roughly one per
  // token down to ~60/sec, which matters when that churn is competing with
  // the WebGPU compute for the main thread.
  const pendingTextRef = useRef({});
  const rafIdRef = useRef(null);

  const flushPendingText = useCallback(() => {
    rafIdRef.current = null;
    const updates = pendingTextRef.current;
    pendingTextRef.current = {};
    const ids = Object.keys(updates);
    if (ids.length === 0) return;
    setStages((prev) => prev.map((s) => (updates[s.id] !== undefined ? { ...s, text: updates[s.id] } : s)));
  }, []);

  const scheduleTextUpdate = useCallback(
    (id, text) => {
      pendingTextRef.current[id] = text;
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(flushPendingText);
      }
    },
    [flushPendingText]
  );

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    };
  }, []);

  const refreshMemory = useCallback(async () => {
    const snapshot = await fetchMindSnapshot();
    setEpisodes(snapshot.episodes);
    setIdentityNarrativeState(snapshot.identityNarrative);
  }, []);

  useEffect(() => {
    refreshMemory();
  }, [refreshMemory]);

  const forgetEverything = useCallback(async () => {
    await clearPersistedMemory();
    await refreshMemory();
  }, [refreshMemory]);

  const prepareModel = useCallback(async (id) => {
    setEngineStatus('loading');
    setError(null);
    setModelId(id);
    try {
      const engine = await loadEngine(id, (report) => setLoadProgress(report));
      engineRef.current = engine;
      setEngineStatus('ready');
    } catch (e) {
      setEngineStatus('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const resetStages = useCallback(() => {
    setStages(MIND_CHAIN.map((s) => ({ id: s.id, status: 'pending', text: '' })));
  }, []);

  const run = useCallback(
    async (stimulus) => {
      if (!engineRef.current) {
        setError("Model isn't loaded yet.");
        return;
      }
      setIsRunning(true);
      setError(null);
      resetStages();
      setRerunEvents([]);
      setPhi(null);
      abortRef.current = new AbortController();
      const signal = abortRef.current.signal;

      const results = {};
      const mindSnapshot = await fetchMindSnapshot();
      const memory = {
        identityNarrative: mindSnapshot.identityNarrative,
        relevantEpisodes: retrieveRelevantEpisodes(mindSnapshot.episodes, stimulus, 3),
        ...getTemporalSnapshot(mindSnapshot.episodes),
      };

      let totalCalls = 0;

      async function runOneStage(stage, note) {
        totalCalls++;
        setStages((prev) => prev.map((s) => (s.id === stage.id ? { ...s, status: 'running' } : s)));

        const deps = {};
        for (const depId of stage.deps) deps[depId] = results[depId] ?? '';

        const userPrompt = stage.buildUserPrompt({ stimulus, deps, memory, priorAttemptNote: note });

        const rawText = await runStage(engineRef.current, stage.systemPrompt, userPrompt, {
          signal,
          temperature: stage.temperature,
          maxTokens: stage.maxTokens,
          onToken: (partial) => scheduleTextUpdate(stage.id, sanitizeStageText(partial)),
        });

        const text = sanitizeStageText(rawText);
        results[stage.id] = text;
        setStages((prev) => prev.map((s) => (s.id === stage.id ? { ...s, status: 'done', text } : s)));

        // Each module call is a fresh, unrelated single-turn prompt — clear the
        // engine's internal conversation/KV state between calls rather than
        // letting sequential generations accumulate in one browser tab.
        try {
          await engineRef.current.resetChat();
        } catch {
          // non-fatal: not every backend/build supports this.
        }

        await yieldToBrowser();
      }

      try {
        let priorAttemptNote;
        let metaRerunCount = 0;

        // Modules 1-15, looping back to 1 whenever Metacognition says RERUN
        // (capped at METACOGNITION_MAX_RERUNS, with a hard MAX_TOTAL_MODULE_CALLS
        // backstop independent of that cap).
        while (!signal.aborted) {
          if (metaRerunCount > 0) {
            setStages((prev) =>
              prev.map((s) => (LOOP_MODULE_IDS.includes(s.id) ? { id: s.id, status: 'pending', text: '' } : s))
            );
          }

          for (const id of LOOP_MODULE_IDS) {
            if (signal.aborted || totalCalls >= MAX_TOTAL_MODULE_CALLS) break;
            const stage = stageById.get(id);
            await runOneStage(stage, priorAttemptNote);

            if (id === 'contradictionEngine') {
              const directives = parseModuleRerunDirectives(results.contradictionEngine ?? '');
              if (directives.length > 0) {
                setRerunEvents((prev) => [
                  ...prev,
                  {
                    type: 'contradiction',
                    detail: `Flagged for rerun: ${directives.map((d) => `${d.moduleTitle} — ${d.reason}`).join('; ')}`,
                  },
                ]);
                for (const d of directives) {
                  if (signal.aborted || totalCalls >= MAX_TOTAL_MODULE_CALLS) break;
                  await runOneStage(
                    stageById.get(d.moduleId),
                    `A consistency audit flagged this output: "${d.reason}". Revise it accordingly, more carefully this time.`
                  );
                }
              }
            }
          }

          if (signal.aborted || totalCalls >= MAX_TOTAL_MODULE_CALLS) break;

          const verdict = parseMetacognitionVerdict(results.metacognition ?? '');
          if (verdict.verdict === 'RERUN' && metaRerunCount < METACOGNITION_MAX_RERUNS) {
            metaRerunCount++;
            priorAttemptNote = verdict.detail || 'Metacognition determined this run needs to be redone.';
            setRerunEvents((prev) => [
              ...prev,
              { type: 'metacognition', detail: `Rerun ${metaRerunCount}/${METACOGNITION_MAX_RERUNS}: ${priorAttemptNote}` },
            ]);
            continue;
          }
          break;
        }

        if (signal.aborted) return;

        // Modules 16-22, run once. Not gated by MAX_TOTAL_MODULE_CALLS: the
        // safety valve is sized so these always fit even in the legitimate
        // worst case, and skipping straight past Voice would be a worse
        // failure than a few extra calls.
        for (const id of TAIL_MODULE_IDS) {
          if (signal.aborted) break;
          await runOneStage(stageById.get(id));
        }

        setPhi(parsePhi(results.integration ?? ''));

        // Consolidate: Identity's rewritten narrative becomes the persisted
        // identity, and this session becomes a new episode — so the next run
        // starts from a mind that actually remembers this one.
        if (!signal.aborted && results.voice) {
          const saved = await saveSession({
            identityNarrative: results.identity || undefined,
            newEpisode: {
              timestamp: Date.now(),
              stimulus,
              emotion: results.emotion ?? '',
              reasoning: results.reasoning ?? '',
              voice: results.voice ?? '',
            },
          });
          if (saved) {
            setEpisodes(saved.episodes);
            setIdentityNarrativeState(saved.identityNarrative);
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        if (isDeviceLostError(e)) {
          // The GPU context is gone — nothing further will run on this engine.
          // Force back to idle so the user can reload rather than being stuck
          // on a "ready" state that silently fails on every next attempt.
          unloadEngine();
          engineRef.current = null;
          setEngineStatus('idle');
          setModelId(null);
        }
      } finally {
        setIsRunning(false);
      }
    },
    [resetStages, scheduleTextUpdate]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setIsRunning(false);
  }, []);

  return {
    modelId,
    engineStatus,
    loadProgress,
    prepareModel,
    stages,
    isRunning,
    error,
    run,
    stop,
    episodes,
    identityNarrative,
    forgetEverything,
    rerunEvents,
    phi,
  };
}
