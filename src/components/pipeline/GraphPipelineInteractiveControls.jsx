import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, ChevronDown, Loader2, Play, RotateCcw, Send, Settings2 } from 'lucide-react';
import { Button, Input, toast } from '../ui';
import FileAttachButton from './FileAttachButton';
import { cn } from '../../lib/utils';
import {
  subscribeConsciousnessStream,
  consciousnessStreamStore,
  hydrateConsciousnessStreamFromDb,
} from '../../lib/consciousnessStreamStore';
import { startConsciousnessStreamRun } from '../../lib/consciousnessStreamRunner';
import { resumeInterruptedGraphPipelineManual } from '../../lib/reconnectRecovery';
import { conversationToStreamEntries } from '../../lib/conversationStreamEntries';
import { filterConversationRowsForGraphSession } from '../../lib/graphPipelineConversation';
import { ConversationMessage } from '../../lib/data';
import { MIND_PHASE_OPTIONS } from '../../lib/mindPersistence';
import {
  graphPipelineStore,
  subscribeGraphPipeline,
  validCooperativePipelineCheckpoint,
} from '../../lib/graphPipelineStore';
import GraphPipelineMetacognitionLimitsRow from './GraphPipelineMetacognitionLimitsRow';

export default function GraphPipelineInteractiveControls({ graphSessionId }) {
  const snap = useSyncExternalStore(
    subscribeConsciousnessStream,
    () => consciousnessStreamStore.getState(),
    () => consciousnessStreamStore.getState()
  );

  const {
    input,
    attachments,
    isProcessing,
    mindPhase,
    arousal,
    streamIntent,
    runInterrupted,
    dbHydrated,
  } = snap;

  const [pendingFiles, setPendingFiles] = useState([]);
  const [resumeInterruptedBusy, setResumeInterruptedBusy] = useState(false);
  const [checkpointResumeBusy, setCheckpointResumeBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const gpSnap = useSyncExternalStore(
    subscribeGraphPipeline,
    () => graphPipelineStore.getState(),
    () => graphPipelineStore.getState()
  );
  const pipelineCheckpoint = validCooperativePipelineCheckpoint(gpSnap.pipelineCheckpoint);
  const streamLocksUi = isProcessing;

  useEffect(() => {
    if (graphSessionId == null || !String(graphSessionId).trim()) return;
    const sid = String(graphSessionId).trim();
    let cancelled = false;
    (async () => {
      const rows = await ConversationMessage.list('-created_date', 320);
      if (cancelled) return;
      const filtered = filterConversationRowsForGraphSession(rows, sid);
      const s = consciousnessStreamStore.getState();
      if (s.isProcessing) return;
      hydrateConsciousnessStreamFromDb(conversationToStreamEntries(filtered), {
        conversationRows: filtered,
        force: true,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [graphSessionId]);

  const runStream = async () => {
    if (isProcessing) return;
    if (!input.trim() && pendingFiles.length === 0 && attachments.length === 0) return;
    const files = [...pendingFiles];
    setPendingFiles([]);
    await startConsciousnessStreamRun({ pendingFiles: files });
  };

  const resumeInterruptedPipeline = useCallback(async () => {
    setResumeInterruptedBusy(true);
    try {
      const r = await resumeInterruptedGraphPipelineManual();
      if (r.graphStarted) {
        toast({
          title: 'Resuming pipeline',
          description: 'Continuing the graph/stream run from the server\u2026',
        });
        return;
      }
      const hints = {
        not_interrupted: 'Nothing to resume right now.',
        already_running: 'A run is already in progress.',
        pipeline_busy: 'The graph pipeline (this transcript) is already running in this tab.',
        no_recoverable_input: 'No saved user message or attachments to send.',
        not_started: 'The run did not start \u2014 check the API or your last message.',
      };
      const desc =
        hints[r.graphReason] ||
        (String(r.graphReason).startsWith('error:')
          ? String(r.graphReason).replace(/^error:/, '').trim()
          : r.graphReason);
      toast({
        title: 'Could not resume',
        description: desc,
        variant: r.graphReason === 'not_interrupted' ? 'default' : 'destructive',
      });
    } catch (e) {
      toast({
        title: 'Resume failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setResumeInterruptedBusy(false);
    }
  }, []);

  return (
    <>
      {/* Checkpoint banner */}
      {pipelineCheckpoint ? (
        <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-sky-500/5 px-4 py-2 text-xs sm:flex-row sm:items-center dark:bg-sky-950/25">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Play className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden />
            <p className="min-w-0 flex-1 text-muted-foreground">
              Checkpoint saved. <span className="font-medium text-foreground/90">Continue</span> to resume or discard.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              className="h-7 gap-1 text-xs"
              disabled={streamLocksUi || checkpointResumeBusy}
              onClick={() => {
                setCheckpointResumeBusy(true);
                void (async () => {
                  try {
                    await startConsciousnessStreamRun({ resumeFromCheckpoint: true });
                  } catch (e) {
                    toast({
                      title: 'Resume failed',
                      description: e instanceof Error ? e.message : String(e),
                      variant: 'destructive',
                    });
                  } finally {
                    setCheckpointResumeBusy(false);
                  }
                })();
              }}
            >
              <Play className="h-3 w-3 shrink-0" aria-hidden />
              Continue
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 border-sky-500/40 text-xs"
              disabled={streamLocksUi}
              onClick={() => graphPipelineStore.clearPipelineCheckpoint()}
            >
              Discard
            </Button>
          </div>
        </div>
      ) : null}

      {/* Interrupted banner */}
      {runInterrupted && !pipelineCheckpoint ? (
        <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-amber-500/5 px-4 py-2 text-xs sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
            <p className="min-w-0 flex-1 text-muted-foreground">
              Pipeline interrupted. <span className="font-medium text-foreground/90">Resume</span> to continue from server.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              className="h-7 gap-1 text-xs"
              disabled={streamLocksUi || resumeInterruptedBusy}
              onClick={() => void resumeInterruptedPipeline()}
            >
              <RotateCcw className="h-3 w-3 shrink-0" aria-hidden />
              Resume
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 border-amber-500/40 text-xs"
              onClick={() => consciousnessStreamStore.dismissInterrupted()}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      {/* Collapsible run settings */}
      <div className="shrink-0 border-b border-border/70">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/20"
          onClick={() => setSettingsOpen((v) => !v)}
          aria-expanded={settingsOpen}
        >
          <Settings2 className="h-3.5 w-3.5" aria-hidden />
          <span className="font-medium">Run settings</span>
          <span className="ml-1 flex items-center gap-2 text-[11px]">
            <span className="rounded bg-muted px-1.5 py-0.5">{MIND_PHASE_OPTIONS.find((p) => p.id === mindPhase)?.label || mindPhase}</span>
            {streamIntent ? <span className="truncate text-muted-foreground/70">intent: {streamIntent}</span> : null}
          </span>
          <ChevronDown className={cn('ml-auto h-3.5 w-3.5 transition-transform', settingsOpen && 'rotate-180')} aria-hidden />
        </button>
        {settingsOpen ? (
          <div className="space-y-2 border-t border-border/50 bg-muted/5 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="font-medium">Phase</span>
                <select
                  value={mindPhase}
                  onChange={(e) => consciousnessStreamStore.setState({ mindPhase: e.target.value })}
                  disabled={streamLocksUi}
                  className="h-7 rounded border border-input bg-background px-2 text-xs"
                >
                  {MIND_PHASE_OPTIONS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </label>
              <div
                className="flex items-center gap-2"
                title="Arousal tracks the model's internal state during runs (read-only)."
              >
                <span className="text-xs font-medium text-muted-foreground">Arousal</span>
                <div className="relative h-2 w-20 overflow-hidden rounded-full border border-border/80 bg-muted/50">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-500/70 to-rose-500/80 transition-[width] duration-300 ease-out"
                    style={{ width: `${Math.min(100, Math.max(0, Number(arousal) || 0) * 100)}%` }}
                  />
                </div>
                <span className="w-8 tabular-nums text-xs text-muted-foreground">{Number(arousal).toFixed(2)}</span>
              </div>
              <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
                <span className="shrink-0 font-medium">Intent</span>
                <Input
                  value={streamIntent}
                  onChange={(e) => consciousnessStreamStore.setState({ streamIntent: e.target.value })}
                  placeholder="Optional"
                  className="h-7 min-w-[100px] flex-1 bg-background text-xs"
                  disabled={streamLocksUi}
                />
              </label>
            </div>
            <GraphPipelineMetacognitionLimitsRow className="" />
          </div>
        ) : null}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-border bg-background px-4 py-3 shadow-[0_-1px_3px_rgba(0,0,0,0.06)]">
        <div className="flex items-center gap-2">
          <FileAttachButton
            pendingFiles={pendingFiles}
            onPendingFilesChange={setPendingFiles}
            attachments={attachments}
            onRemoveAttachment={(id) =>
              consciousnessStreamStore.setState({
                attachments: consciousnessStreamStore.getState().attachments.filter((a) => a.id !== id),
              })
            }
            disabled={streamLocksUi}
          />
          <Input
            value={input}
            onChange={(e) => consciousnessStreamStore.setState({ input: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void runStream();
              }
            }}
            placeholder="Enter a thought, question, or scenario\u2026"
            className="h-10 min-w-[120px] flex-1 bg-muted/20 text-sm"
            disabled={streamLocksUi}
          />
          <Button
            type="button"
            size="icon"
            className="h-10 w-10"
            disabled={
              streamLocksUi || (!input.trim() && pendingFiles.length === 0 && attachments.length === 0)
            }
            onClick={() => void runStream()}
          >
            {streamLocksUi ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        {!dbHydrated ? (
          <p className="mt-2 text-xs text-muted-foreground">Loading conversation prefs\u2026</p>
        ) : null}
      </div>
    </>
  );
}
