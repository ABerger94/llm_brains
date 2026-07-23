"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InitProgressReport, MLCEngineInterface } from "@mlc-ai/web-llm";
import { MIND_CHAIN, sanitizeStageText, parsePhi, type MindStage } from "./mindChain";
import { loadEngine, runStage, unloadEngine } from "./webllmEngine";
import {
  addEpisode,
  clearMemory as clearPersistedMemory,
  getEpisodes,
  getIdentityNarrative,
  getTemporalSnapshot,
  retrieveRelevantEpisodes,
  setIdentityNarrative,
  type MemoryEpisode,
} from "./memoryStore";

export type StageStatus = "pending" | "running" | "done" | "error";

export interface StageState {
  id: string;
  status: StageStatus;
  text: string;
}

export type EngineStatus = "idle" | "loading" | "ready" | "error";

function isDeviceLostError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /device|context lost|gpu/i.test(message);
}

/** Lets the browser breathe between heavy WebGPU calls instead of monopolizing the main thread back-to-back for the whole run. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function useMindChain() {
  const [engineStatus, setEngineStatus] = useState<EngineStatus>("idle");
  const [loadProgress, setLoadProgress] = useState<InitProgressReport | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [stages, setStages] = useState<StageState[]>(
    MIND_CHAIN.map((s) => ({ id: s.id, status: "pending", text: "" })),
  );
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<MemoryEpisode[]>([]);
  const [identityNarrative, setIdentityNarrativeState] = useState<string>("");
  const [phi, setPhi] = useState<number | null>(null);

  const engineRef = useRef<MLCEngineInterface | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Streaming tokens arrive far faster than the UI needs to redraw; batching
  // to one flush per animation frame cuts re-renders from roughly one per
  // token (thousands over a full run) down to ~60/sec, which matters when
  // that churn is competing with the WebGPU compute for the main thread.
  const pendingTextRef = useRef<Record<string, string>>({});
  const rafIdRef = useRef<number | null>(null);

  const flushPendingText = useCallback(() => {
    rafIdRef.current = null;
    const updates = pendingTextRef.current;
    pendingTextRef.current = {};
    const ids = Object.keys(updates);
    if (ids.length === 0) return;
    setStages((prev) => prev.map((s) => (updates[s.id] !== undefined ? { ...s, text: updates[s.id] } : s)));
  }, []);

  const scheduleTextUpdate = useCallback(
    (id: string, text: string) => {
      pendingTextRef.current[id] = text;
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(flushPendingText);
      }
    },
    [flushPendingText],
  );

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    };
  }, []);

  const refreshMemory = useCallback(() => {
    setEpisodes(getEpisodes());
    setIdentityNarrativeState(getIdentityNarrative());
  }, []);

  useEffect(() => {
    refreshMemory();
  }, [refreshMemory]);

  const forgetEverything = useCallback(() => {
    clearPersistedMemory();
    refreshMemory();
  }, [refreshMemory]);

  const prepareModel = useCallback(async (id: string) => {
    setEngineStatus("loading");
    setError(null);
    setModelId(id);
    try {
      const engine = await loadEngine(id, (report) => setLoadProgress(report));
      engineRef.current = engine;
      setEngineStatus("ready");
    } catch (e) {
      setEngineStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const resetStages = useCallback(() => {
    setStages(MIND_CHAIN.map((s) => ({ id: s.id, status: "pending", text: "" })));
  }, []);

  const run = useCallback(async (stimulus: string) => {
    if (!engineRef.current) {
      setError("Model isn't loaded yet.");
      return;
    }
    setIsRunning(true);
    setError(null);
    resetStages();
    setPhi(null);
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    const results: Record<string, string> = {};
    // Loaded once per run: real persisted memory, not fabricated per-module.
    const memory = {
      identityNarrative: getIdentityNarrative(),
      relevantEpisodes: retrieveRelevantEpisodes(stimulus, 3),
      ...getTemporalSnapshot(),
    };

    async function runOneStage(stage: MindStage) {
      setStages((prev) => prev.map((s) => (s.id === stage.id ? { ...s, status: "running" } : s)));

      const deps: Record<string, string> = {};
      for (const depId of stage.deps) deps[depId] = results[depId] ?? "";

      const userPrompt = stage.buildUserPrompt({ stimulus, deps, memory });

      const rawText = await runStage(engineRef.current!, stage.systemPrompt, userPrompt, {
        signal,
        temperature: stage.temperature,
        maxTokens: stage.maxTokens,
        onToken: (partial) => scheduleTextUpdate(stage.id, sanitizeStageText(partial)),
      });

      const text = sanitizeStageText(rawText);
      results[stage.id] = text;
      setStages((prev) => prev.map((s) => (s.id === stage.id ? { ...s, status: "done", text } : s)));

      // Each module call is a fresh, unrelated single-turn prompt — clear the
      // engine's internal conversation/KV state between calls rather than
      // letting 22 sequential generations accumulate in one browser tab.
      try {
        await engineRef.current!.resetChat();
      } catch {
        // non-fatal: not every backend/build supports this.
      }

      await yieldToBrowser();
    }

    try {
      // A single straight-line pass over all 22 modules, in order. An
      // earlier version let Contradiction Engine and Metacognition actually
      // re-execute earlier modules (up to ~75 model calls worst case in one
      // browser tab) — that was sustained enough WebGPU/WASM load to crash
      // both the installed PWA and the browser tab outright, on desktop and
      // mobile. Both modules still run and still produce their real audit
      // output (visible in their own cards) — the app just no longer acts
      // on it, trading some self-correction depth for actually staying up.
      for (const stage of MIND_CHAIN) {
        if (signal.aborted) break;
        await runOneStage(stage);
      }

      if (signal.aborted) return;

      setPhi(parsePhi(results.integration ?? ""));

      // Consolidate: Identity's rewritten narrative becomes the persisted
      // identity, and this session becomes a new episode — so the next run
      // starts from a mind that actually remembers this one.
      if (results.voice) {
        if (results.identity) setIdentityNarrative(results.identity);
        addEpisode({
          timestamp: Date.now(),
          stimulus,
          emotion: results.emotion ?? "",
          reasoning: results.reasoning ?? "",
          voice: results.voice ?? "",
        });
        refreshMemory();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (isDeviceLostError(e)) {
        // The GPU context is gone — nothing further will run on this engine.
        // Force back to idle so the user can reload rather than being stuck
        // on a "ready" state that silently fails on every next attempt.
        unloadEngine();
        engineRef.current = null;
        setEngineStatus("idle");
        setModelId(null);
      }
    } finally {
      setIsRunning(false);
    }
  }, [resetStages, refreshMemory, scheduleTextUpdate]);

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
    phi,
  };
}
