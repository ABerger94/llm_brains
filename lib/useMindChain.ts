"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InitProgressReport, MLCEngineInterface } from "@mlc-ai/web-llm";
import {
  MIND_CHAIN,
  METACOGNITION_MAX_RERUNS,
  sanitizeStageText,
  parseModuleRerunDirectives,
  parseMetacognitionVerdict,
  parsePhi,
  type MindStage,
} from "./mindChain";
import { loadEngine, runStage } from "./webllmEngine";
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

export interface RerunEvent {
  type: "contradiction" | "metacognition";
  detail: string;
}

const stageById = new Map(MIND_CHAIN.map((s) => [s.id, s]));
// Modules 1-15 (Perception..Metacognition): the span Metacognition can send back for a fresh pass.
const LOOP_MODULE_IDS = MIND_CHAIN.filter((s) => s.order <= 15).map((s) => s.id);
// Modules 16-22 (Integration..Voice): run once, after the loop above settles on PROCEED.
const TAIL_MODULE_IDS = MIND_CHAIN.filter((s) => s.order > 15).map((s) => s.id);

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
  const [rerunEvents, setRerunEvents] = useState<RerunEvent[]>([]);
  const [phi, setPhi] = useState<number | null>(null);

  const engineRef = useRef<MLCEngineInterface | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
    setRerunEvents([]);
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

    async function runOneStage(stage: MindStage, note?: string) {
      setStages((prev) => prev.map((s) => (s.id === stage.id ? { ...s, status: "running" } : s)));

      const deps: Record<string, string> = {};
      for (const depId of stage.deps) deps[depId] = results[depId] ?? "";

      const userPrompt = stage.buildUserPrompt({ stimulus, deps, memory, priorAttemptNote: note });

      const rawText = await runStage(engineRef.current!, stage.systemPrompt, userPrompt, {
        signal,
        temperature: stage.temperature,
        maxTokens: stage.maxTokens,
        onToken: (partial) => {
          const clean = sanitizeStageText(partial);
          setStages((prev) => prev.map((s) => (s.id === stage.id ? { ...s, text: clean } : s)));
        },
      });

      const text = sanitizeStageText(rawText);
      results[stage.id] = text;
      setStages((prev) => prev.map((s) => (s.id === stage.id ? { ...s, status: "done", text } : s)));
    }

    try {
      let priorAttemptNote: string | undefined;
      let metaRerunCount = 0;

      // Modules 1-15, looping back to 1 whenever Metacognition says RERUN (capped).
      while (!signal.aborted) {
        if (metaRerunCount > 0) {
          setStages((prev) =>
            prev.map((s) => (LOOP_MODULE_IDS.includes(s.id) ? { id: s.id, status: "pending", text: "" } : s)),
          );
        }

        for (const id of LOOP_MODULE_IDS) {
          if (signal.aborted) break;
          const stage = stageById.get(id)!;
          await runOneStage(stage, priorAttemptNote);

          if (id === "contradictionEngine") {
            const directives = parseModuleRerunDirectives(results.contradictionEngine ?? "");
            if (directives.length > 0) {
              setRerunEvents((prev) => [
                ...prev,
                {
                  type: "contradiction",
                  detail: `Flagged for rerun: ${directives.map((d) => `${d.moduleTitle} — ${d.reason}`).join("; ")}`,
                },
              ]);
              for (const d of directives) {
                if (signal.aborted) break;
                await runOneStage(
                  stageById.get(d.moduleId)!,
                  `A consistency audit flagged this output: "${d.reason}". Revise it accordingly, more carefully this time.`,
                );
              }
            }
          }
        }

        if (signal.aborted) break;

        const verdict = parseMetacognitionVerdict(results.metacognition ?? "");
        if (verdict.verdict === "RERUN" && metaRerunCount < METACOGNITION_MAX_RERUNS) {
          metaRerunCount++;
          priorAttemptNote = verdict.detail || "Metacognition determined this run needs to be redone.";
          setRerunEvents((prev) => [
            ...prev,
            { type: "metacognition", detail: `Rerun ${metaRerunCount}/${METACOGNITION_MAX_RERUNS}: ${priorAttemptNote}` },
          ]);
          continue;
        }
        break;
      }

      if (signal.aborted) return;

      // Modules 16-22, run once.
      for (const id of TAIL_MODULE_IDS) {
        if (signal.aborted) break;
        await runOneStage(stageById.get(id)!);
      }

      setPhi(parsePhi(results.integration ?? ""));

      // Consolidate: Identity's rewritten narrative becomes the persisted
      // identity, and this session becomes a new episode — so the next run
      // starts from a mind that actually remembers this one.
      if (!signal.aborted && results.voice) {
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
    identityNarrative,
    forgetEverything,
    rerunEvents,
    phi,
  };
}
