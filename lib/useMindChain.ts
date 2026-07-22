"use client";

import { useCallback, useRef, useState } from "react";
import type { InitProgressReport, MLCEngineInterface } from "@mlc-ai/web-llm";
import { MIND_CHAIN } from "./mindChain";
import { loadEngine, runStage } from "./webllmEngine";

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

  const engineRef = useRef<MLCEngineInterface | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

    try {
      for (const stage of MIND_CHAIN) {
        if (signal.aborted) break;

        setStages((prev) =>
          prev.map((s) => (s.id === stage.id ? { ...s, status: "running" } : s)),
        );

        const deps: Record<string, string> = {};
        for (const depId of stage.deps) deps[depId] = results[depId] ?? "";

        const userPrompt = stage.buildUserPrompt({ stimulus, deps });

        const text = await runStage(engineRef.current, stage.systemPrompt, userPrompt, {
          signal,
          onToken: (partial) => {
            setStages((prev) =>
              prev.map((s) => (s.id === stage.id ? { ...s, text: partial } : s)),
            );
          },
        });

        results[stage.id] = text;
        setStages((prev) =>
          prev.map((s) => (s.id === stage.id ? { ...s, status: "done", text } : s)),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsRunning(false);
    }
  }, [resetStages]);

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
  };
}
