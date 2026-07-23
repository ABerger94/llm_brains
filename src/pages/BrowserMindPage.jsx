import { useEffect, useMemo, useState } from 'react';
import { Laptop } from 'lucide-react';
import { MIND_CHAIN, PHASES } from '../lib/browserMindChain';
import { useBrowserMindChain } from '../lib/useBrowserMindChain';
import { isWebGPUAvailable, AVAILABLE_MODELS } from '../lib/browserLlmEngine';
import PageDescriptionCollapsible from '../components/PageDescriptionCollapsible';
import ModelPicker from '../components/browserMind/ModelPicker';
import LoadProgress from '../components/browserMind/LoadProgress';
import StimulusInput from '../components/browserMind/StimulusInput';
import StageCard from '../components/browserMind/StageCard';
import ConsciousOutput from '../components/browserMind/ConsciousOutput';
import MemoryPanel from '../components/browserMind/MemoryPanel';
import RerunLog from '../components/browserMind/RerunLog';

/** iOS Safari kills the whole tab (blank page / silent reload) when a page's memory footprint gets too high. */
function isLikelyMobile() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isTouchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1; // iPadOS reports as Mac
  return /iPhone|iPad|iPod|Android/.test(ua) || isTouchMac;
}

export default function BrowserMindPage() {
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
    identityNarrative,
    forgetEverything,
    rerunEvents,
    phi,
  } = useBrowserMindChain();

  const [webgpuOk, setWebgpuOk] = useState(null);
  const [selectedModel, setSelectedModel] = useState(AVAILABLE_MODELS[0].id);
  const [mobile, setMobile] = useState(false);
  const [confirmingRiskyLoad, setConfirmingRiskyLoad] = useState(false);

  useEffect(() => {
    setWebgpuOk(isWebGPUAvailable());
    setMobile(isLikelyMobile());
  }, []);

  const selectedModelInfo = AVAILABLE_MODELS.find((m) => m.id === selectedModel);
  const needsRiskConfirm = mobile && !!selectedModelInfo?.riskyOnMobile;

  function handleSelectModel(id) {
    setSelectedModel(id);
    setConfirmingRiskyLoad(false);
  }

  function handleLoadClick() {
    if (needsRiskConfirm && !confirmingRiskyLoad) {
      setConfirmingRiskyLoad(true);
      return;
    }
    setConfirmingRiskyLoad(false);
    prepareModel(selectedModel);
  }

  const stageById = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages]);
  const finalStage = stageById.get('voice');

  return (
    <div className="w-full min-h-0 p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
            <Laptop className="h-7 w-7 text-violet-400" />
            Browser Mind
          </h1>
          <PageDescriptionCollapsible className="mt-1">
            A small language model, running entirely on your device via WebGPU, walks a stimulus
            through 22 modules mapped to real brain-region equivalents — Perception through Voice
            — grounded in Integrated Information Theory. Contradiction Engine and Metacognition
            can send parts of the run back for a redo when something doesn't hold together, and
            each session consolidates into an identity and episodic memory kept in this browser's
            IndexedDB. This is a separate, self-contained pipeline from the main {' '}
            <span className="text-foreground/80">Graph Pipeline</span> — it needs no local LLM
            server or API key, only a WebGPU-capable browser.
          </PageDescriptionCollapsible>
        </div>

        <MemoryPanel identityNarrative={identityNarrative} episodes={episodes} onForget={forgetEverything} />

        {webgpuOk === false && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-200">
            This browser doesn't expose WebGPU, so local inference won't run here. Try Safari on
            iOS 17+/macOS or Chrome/Edge on desktop.
          </div>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">1. Choose a model</h2>
          <ModelPicker
            selectedId={selectedModel}
            disabled={engineStatus === 'loading' || isRunning}
            onSelect={handleSelectModel}
          />
          {engineStatus !== 'ready' || modelId !== selectedModel ? (
            <button
              type="button"
              disabled={engineStatus === 'loading' || webgpuOk === false}
              onClick={handleLoadClick}
              className={`self-start rounded-lg border px-4 py-2 text-sm font-medium hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40 ${
                confirmingRiskyLoad
                  ? 'border-amber-500/60 bg-amber-500/10 text-amber-600 dark:text-amber-200'
                  : 'border-border bg-card text-foreground'
              }`}
            >
              {engineStatus === 'loading'
                ? 'Downloading…'
                : confirmingRiskyLoad
                  ? 'Tap again to load anyway (may crash the tab)'
                  : 'Download & load model'}
            </button>
          ) : null}
          <LoadProgress status={engineStatus} progress={loadProgress} />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            2. Give it something to perceive
          </h2>
          <StimulusInput disabled={engineStatus !== 'ready'} isRunning={isRunning} onRun={run} onStop={stop} />
          {isRunning && (
            <p className="text-[11px] text-muted-foreground">
              Modules 1-15 can loop back on themselves if Contradiction Engine or Metacognition
              flag something — this can take noticeably longer than a straight pass, especially on
              small local models.
            </p>
          )}
        </section>

        {error && (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-200">
            {error}
          </div>
        )}

        <RerunLog events={rerunEvents} />

        {finalStage && (finalStage.text || finalStage.status !== 'pending') && (
          <ConsciousOutput text={finalStage.text} isRunning={finalStage.status === 'running'} phi={phi} />
        )}

        <section className="flex flex-col gap-5">
          {PHASES.map((phase) => {
            const phaseStages = MIND_CHAIN.filter((s) => s.phase === phase);
            return (
              <div key={phase} className="flex flex-col gap-2">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{phase}</h3>
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

        <p className="pt-2 text-center text-[11px] text-muted-foreground/70">
          Model weights download once and are cached by your browser, and all 22 modules run
          locally — the LLM itself never leaves this device. Memory (identity narrative + episode
          history) lives in this browser's IndexedDB.
        </p>
      </div>
    </div>
  );
}
