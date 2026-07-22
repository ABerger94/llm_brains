"use client";

import { useEffect, useMemo, useState } from "react";
import { MIND_CHAIN, PHASES } from "@/lib/mindChain";
import { useMindChain } from "@/lib/useMindChain";
import { isWebGPUAvailable, AVAILABLE_MODELS } from "@/lib/webllmEngine";
import { ModelPicker } from "@/components/ModelPicker";
import { LoadProgress } from "@/components/LoadProgress";
import { StimulusInput } from "@/components/StimulusInput";
import { StageCard } from "@/components/StageCard";
import { ConsciousOutput } from "@/components/ConsciousOutput";
import { MemoryPanel } from "@/components/MemoryPanel";

export default function Home() {
  const {
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
  } = useMindChain();

  const [webgpuOk, setWebgpuOk] = useState<boolean | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>(AVAILABLE_MODELS[0].id);

  useEffect(() => {
    setWebgpuOk(isWebGPUAvailable());
  }, []);

  const stageById = useMemo(() => {
    const map = new Map(stages.map((s) => [s.id, s]));
    return map;
  }, [stages]);

  const finalStage = stageById.get("consciousOutput");

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-5 px-4 py-8 pb-16">
      <header>
        <h1 className="text-xl font-semibold text-neutral-50">Mind Chain</h1>
        <p className="mt-1 text-sm text-neutral-400">
          A small language model, running entirely on your device, walks a stimulus through 22
          chained prompts modeling perception, memory, emotion, reasoning, and conscious
          broadcast — no server, no API calls. Every run consolidates into a persisted
          self-narrative and episodic memory, so this mind actually accumulates a past instead
          of resetting each time.
        </p>
      </header>

      <MemoryPanel selfNarrative={selfNarrative} episodes={episodes} onForget={forgetEverything} />

      {webgpuOk === false && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          This browser doesn&apos;t expose WebGPU, so local inference won&apos;t run here. Try
          Safari on iOS 17+/macOS or Chrome/Edge on desktop.
        </div>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-400">
          1. Choose a model
        </h2>
        <ModelPicker
          selectedId={selectedModel}
          disabled={engineStatus === "loading" || isRunning}
          onSelect={setSelectedModel}
        />
        {engineStatus !== "ready" || modelId !== selectedModel ? (
          <button
            type="button"
            disabled={engineStatus === "loading" || webgpuOk === false}
            onClick={() => prepareModel(selectedModel)}
            className="self-start rounded-lg border border-edge bg-panel px-4 py-2 text-sm font-medium text-neutral-100 hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {engineStatus === "loading" ? "Downloading…" : "Download & load model"}
          </button>
        ) : null}
        <LoadProgress status={engineStatus} progress={loadProgress} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-400">
          2. Give it something to perceive
        </h2>
        <StimulusInput
          disabled={engineStatus !== "ready"}
          isRunning={isRunning}
          onRun={run}
          onStop={stop}
        />
      </section>

      {error && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {finalStage && (finalStage.text || finalStage.status !== "pending") && (
        <ConsciousOutput text={finalStage.text} isRunning={finalStage.status === "running"} />
      )}

      <section className="flex flex-col gap-5">
        {PHASES.map((phase) => {
          const phaseStages = MIND_CHAIN.filter((s) => s.phase === phase);
          return (
            <div key={phase} className="flex flex-col gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                {phase}
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {phaseStages.map((stage) => {
                  const state = stageById.get(stage.id);
                  if (!state) return null;
                  return <StageCard key={stage.id} stage={stage} state={state} />;
                })}
              </div>
            </div>
          );
        })}
      </section>

      <footer className="pt-4 text-center text-[11px] text-neutral-600">
        Model weights download once and are cached by your browser. All 22 stages run locally —
        nothing you type or generate leaves this device.
      </footer>
    </main>
  );
}
