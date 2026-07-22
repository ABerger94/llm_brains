"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InitProgressReport, MLCEngineInterface } from "@mlc-ai/web-llm";
import { MIND_CHAIN, sanitizeStageText } from "./mindChain";
import { loadEngine, runStage } from "./webllmEngine";
import {
  addEpisode,
  clearMemory as clearPersistedMemory,
  getEpisodes,
  getSelfNarrative,
  retrieveRelevantEpisodes,
  setSelfNarrative,
  type MemoryEpisode,
} from "./memoryStore";

export type StageStatus = "pending" | "running" | "done" | "error";

export interface StageState {
  id: string;
  status: StageStatus;
  text: string;
}

export type EngineStatus = "idle" | "loading" | "ready" | "error";

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
  const [selfNarrative, setSelfNarrativeState] = useState<string>("");

  const engineRef = useRef<MLCEngineInterface | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refreshMemory = useCallback(() => {
    setEpisodes(getEpisodes());
    setSelfNarrativeState(getSelfNarrative());
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
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    const results: Record<string, string> = {};
    // Loaded once per run: real persisted memory, not fabricated per-stage.
    const memory = {
      selfNarrative: getSelfNarrative(),
      relevantEpisodes: retrieveRelevantEpisodes(stimulus, 3),
    };

    try {
      for (const stage of MIND_CHAIN) {
        if (signal.aborted) break;

        setStages((prev) =>
          prev.map((s) => (s.id === stage.id ? { ...s, status: "running" } : s)),
        );

        const deps: Record<string, string> = {};
        for (const depId of stage.deps) deps[depId] = results[depId] ?? "";

        const userPrompt = stage.buildUserPrompt({ stimulus, deps, memory });

        const rawText = await runStage(engineRef.current, stage.systemPrompt, userPrompt, {
          signal,
          temperature: stage.temperature,
          onToken: (partial) => {
            const clean = sanitizeStageText(partial);
            setStages((prev) =>
              prev.map((s) => (s.id === stage.id ? { ...s, text: clean } : s)),
            );
          },
        });

        const text = sanitizeStageText(rawText);
        results[stage.id] = text;
        setStages((prev) =>
          prev.map((s) => (s.id === stage.id ? { ...s, status: "done", text } : s)),
        );
      }

      // Consolidate: fold this episode into persisted memory so the next run
      // starts from a mind that actually remembers this one, not a blank slate.
      if (!signal.aborted && results.consciousOutput) {
        if (results.narrative) setSelfNarrative(results.narrative);
        addEpisode({
          timestamp: Date.now(),
          stimulus,
          emotion: results.emotion ?? "",
          decision: results.decision ?? "",
          consciousOutput: results.consciousOutput ?? "",
        });
        refreshMemory();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsRunning(false);
    }
  }, [resetStages, refreshMemory]);

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
    selfNarrative,
    forgetEverything,
  };
}
