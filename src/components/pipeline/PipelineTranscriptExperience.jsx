import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AlertTriangle, ChevronDown, Loader2, Play, RotateCcw, Send } from 'lucide-react';
import { Button, Input, toast } from '../ui';
import { ConversationMessage } from '../../lib/data';
import { conversationEntityForPlaygroundSession } from '../../lib/playgroundDualMind';
import FileAttachButton from './FileAttachButton';
import { cn } from '../../lib/utils';
import {
  subscribeConsciousnessStream,
  consciousnessStreamStore,
  hydrateConsciousnessStreamFromDb,
} from '../../lib/consciousnessStreamStore';
import { startConsciousnessStreamRun } from '../../lib/consciousnessStreamRunner';
import { resumeInterruptedGraphPipelineManual } from '../../lib/reconnectRecovery';
import { buildConsciousnessStreamRenderPlan } from '../../lib/conversationStreamRenderPlan';
import { conversationToStreamEntries } from '../../lib/conversationStreamEntries';
import { computePipelineMinimapSnapshot } from '../../lib/consciousnessStreamPipelineMinimap';
import { PipelineStageMinimap } from '../consciousness/PipelineStageMinimap';
import { MIND_PHASE_OPTIONS } from '../../lib/mindPersistence';
import { filterConversationRowsForGraphSession } from '../../lib/graphPipelineConversation';
import {
  graphPipelineStore,
  subscribeGraphPipeline,
  validCooperativePipelineCheckpoint,
} from '../../lib/graphPipelineStore';
import { isTransientReconnectFailure } from '../../lib/transientPipelineFailure.js';
import { graphResumeStreamOptsForSession } from '../../lib/playgroundDualGraphRunner';
import { resolveGraphSessionMindStorageProfile } from '../../lib/graphSessionMindProfile';

function consciousnessStreamEntryTextClass(entry) {
  switch (entry.type) {
    case 'user-input':
      return 'font-semibold text-primary';
    case 'system':
      return 'italic text-muted-foreground/60';
    case 'memory-recall':
      return 'text-sky-400';
    case 'module-start':
      return 'text-muted-foreground/50';
    case 'module-thought':
      return 'text-foreground/80';
    case 'module-complete':
      return 'text-sm font-semibold text-emerald-500';
    case 'narrative':
      return 'font-medium text-foreground';
    case 'voice':
      return 'font-medium text-foreground';
    case 'meta-calibration':
      return 'text-xs text-violet-300/90';
    default:
      return 'text-foreground/70';
  }
}

function consciousnessStreamEntrySurfaceClass(entry) {
  return cn(
    'flex gap-3 py-0.5',
    (entry.type === 'narrative' || entry.type === 'voice') &&
      'mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3',
    entry.type === 'module-thought' &&
      (entry.moduleId === 'narrative' || entry.moduleId === 'voice') &&
      'mt-2 rounded-lg border border-primary/15 bg-primary/[0.04] p-3',
    entry.type === 'module-complete' && 'mt-1 rounded-md border border-emerald-500/25 bg-emerald-500/5 py-1.5 pl-2 pr-3',
    entry.type === 'meta-calibration' && 'rounded border border-violet-500/15 bg-violet-500/5 py-1'
  );
}

function ConsciousnessStreamEntryRow({ entry }) {
  const hasModule = Boolean(entry.moduleColor);
  const body = (
    <>
      {entry.content}
      {entry.rationale ? (
        <div className="mt-1 text-[10px] font-normal text-muted-foreground">{entry.rationale}</div>
      ) : null}
    </>
  );
  return (
    <div className={cn(consciousnessStreamEntrySurfaceClass(entry), 'min-w-0')}>
      <span className="w-16 shrink-0 text-right text-muted-foreground/30">{entry.time}</span>
      {hasModule ? (
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,min(12rem,34vw))_minmax(0,1fr)] items-start gap-x-3">
          <span
            className="min-w-0 self-start break-words font-medium leading-snug [overflow-wrap:anywhere]"
            style={{ color: entry.moduleColor }}
          >
            [{entry.moduleName ?? '·'}]
          </span>
          <span
            className={cn(
              'min-w-0 break-words leading-relaxed whitespace-pre-wrap',
              consciousnessStreamEntryTextClass(entry)
            )}
          >
            {body}
          </span>
        </div>
      ) : (
        <span
          className={cn(
            'min-w-0 flex-1 break-words leading-relaxed whitespace-pre-wrap',
            consciousnessStreamEntryTextClass(entry)
          )}
        >
          {body}
        </span>
      )}
    </div>
  );
}

/**
 * @param {{
 *   title: string
 *   description: import('react').ReactNode
 *   titleIcon: import('react').ComponentType<{ className?: string }>
 *   beforeComposer?: import('react').ReactNode
 *   betweenMinimapAndTranscript?: import('react').ReactNode
 *   graphSessionId?: string
 * }} props
 */
export default function PipelineTranscriptExperience({
  title,
  description,
  titleIcon: TitleIcon,
  beforeComposer = null,
  betweenMinimapAndTranscript = null,
  graphSessionId,
}) {
  const snap = useSyncExternalStore(
    subscribeConsciousnessStream,
    () => consciousnessStreamStore.getState(),
    () => consciousnessStreamStore.getState()
  );

  const {
    entries: streamEntries,
    input,
    attachments,
    isProcessing,
    paused,
    mindPhase,
    arousal,
    streamIntent,
    runInterrupted,
    dbHydrated,
  } = snap;

  const [pendingFiles, setPendingFiles] = useState([]);
  const [resumeInterruptedBusy, setResumeInterruptedBusy] = useState(false);
  const [checkpointResumeBusy, setCheckpointResumeBusy] = useState(false);
  const scrollRef = useRef(null);
  const streamEndRef = useRef(null);

  const streamLocksUi = isProcessing;

  const gpSnap = useSyncExternalStore(
    subscribeGraphPipeline,
    () => graphPipelineStore.getState(),
    () => graphPipelineStore.getState()
  );
  const pipelineCheckpoint = validCooperativePipelineCheckpoint(gpSnap.pipelineCheckpoint);
  const ckNextModule = pipelineCheckpoint?.executionCursor?.nextModuleName;
  const ckSavedAt = pipelineCheckpoint?.savedAt;
  const recoverableResumeError =
    Boolean(runInterrupted && gpSnap.runError && isTransientReconnectFailure(String(gpSnap.runError)));

  const sid = graphSessionId != null && String(graphSessionId).trim() ? String(graphSessionId).trim() : '';

  const streamRenderPlan = useMemo(
    () => buildConsciousnessStreamRenderPlan(streamEntries, isProcessing),
    [streamEntries, isProcessing]
  );

  const pipelineMinimapSnapshot = useMemo(
    () => computePipelineMinimapSnapshot(streamEntries, isProcessing),
    [streamEntries, isProcessing]
  );

  useEffect(() => {
    if (graphSessionId == null || !String(graphSessionId).trim()) return;
    const sid = String(graphSessionId).trim();
    let cancelled = false;
    (async () => {
      const Conv = sid ? conversationEntityForPlaygroundSession(sid) : ConversationMessage;
      const rows = await Conv.list('-created_date', 320);
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

  const scrollStreamToBottom = useCallback(() => {
    const wrap = scrollRef.current;
    const end = streamEndRef.current;
    if (!wrap) return;
    if (end) {
      end.scrollIntoView({ block: 'end', behavior: 'auto' });
    } else {
      wrap.scrollTop = wrap.scrollHeight;
    }
  }, []);

  const snapStreamScrollToBottom = useCallback(() => {
    scrollStreamToBottom();
    return requestAnimationFrame(() => {
      scrollStreamToBottom();
      requestAnimationFrame(scrollStreamToBottom);
    });
  }, [scrollStreamToBottom]);

  useLayoutEffect(() => {
    const id = snapStreamScrollToBottom();
    return () => cancelAnimationFrame(id);
  }, [snapStreamScrollToBottom]);

  useLayoutEffect(() => {
    if (!dbHydrated) return;
    const id = snapStreamScrollToBottom();
    return () => cancelAnimationFrame(id);
  }, [dbHydrated, snapStreamScrollToBottom]);

  useLayoutEffect(() => {
    if (paused) return;
    const id = snapStreamScrollToBottom();
    return () => cancelAnimationFrame(id);
  }, [streamEntries, paused, isProcessing, snapStreamScrollToBottom]);

  const runStream = async () => {
    if (!input.trim() && pendingFiles.length === 0 && attachments.length === 0) return;
    if (isProcessing) return;
    const files = [...pendingFiles];
    setPendingFiles([]);
    await startConsciousnessStreamRun({
      pendingFiles: files,
      ...(sid
        ? {
            graphSessionIdForPersistence: sid,
            mindStorageProfile: resolveGraphSessionMindStorageProfile(sid),
          }
        : {}),
    });
  };

  const resumeInterruptedPipeline = async () => {
    setResumeInterruptedBusy(true);
    try {
      const r = await resumeInterruptedGraphPipelineManual();
      if (r.graphStarted) {
        toast({
          title: 'Resuming pipeline',
          description: 'Continuing the graph/stream run from the server…',
        });
        return;
      }
      const hints = {
        not_interrupted: 'Nothing to resume right now.',
        already_running: 'A run is already in progress.',
        pipeline_busy: 'The graph pipeline (this transcript) is already running in this tab.',
        no_recoverable_input: 'No saved user message or attachments to send.',
        not_started: 'The run did not start — check the API or your last message.',
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
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-start gap-x-4 gap-y-3 border-b border-border px-6 py-4">
        <div className="flex min-w-0 max-w-md shrink-0 grow-0 gap-3 lg:max-w-lg">
          <div className="relative shrink-0 pt-0.5">
            <TitleIcon className="h-5 w-5 text-primary" />
            {isProcessing ? (
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-ping rounded-full bg-primary" />
            ) : null}
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-foreground">{title}</h1>
            <div className="text-[11px] leading-snug text-muted-foreground">{description}</div>
          </div>
        </div>
        {pipelineCheckpoint ? (
          <div className="flex w-full basis-full flex-col gap-2 rounded-lg border border-sky-500/35 bg-sky-500/10 px-3 py-2 text-[11px] text-sky-100/90 sm:flex-row sm:items-start dark:bg-sky-950/25">
            <div className="flex min-w-0 flex-1 gap-2">
              <Play className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden />
              <p className="min-w-0 flex-1">
                Cooperative checkpoint — mid-pipeline resume. Use{' '}
                <span className="font-medium text-foreground/90">Continue</span> for the next module, or Discard. Dashboard
                &quot;Resume all&quot; can also pick up saved checkpoints.
                {ckNextModule ? (
                  <span className="mt-0.5 block text-muted-foreground/95">
                    Next: <span className="font-medium text-foreground/90">{ckNextModule}</span>
                    {typeof ckSavedAt === 'number'
                      ? ` · ${new Date(ckSavedAt).toLocaleString()}`
                      : ''}
                  </span>
                ) : null}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:pt-0">
              <Button
                type="button"
                variant="default"
                size="sm"
                className="h-7 gap-1 text-[10px]"
                disabled={isProcessing || checkpointResumeBusy}
                onClick={() => {
                  setCheckpointResumeBusy(true);
                  void (async () => {
                    try {
                      await startConsciousnessStreamRun({
                        resumeFromCheckpoint: true,
                        ...graphResumeStreamOptsForSession(sid),
                        ...(sid ? { graphSessionIdForPersistence: sid } : {}),
                      });
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
                className="h-7 shrink-0 border-sky-500/40 text-[10px]"
                disabled={isProcessing}
                onClick={() => graphPipelineStore.clearPipelineCheckpoint()}
              >
                Discard
              </Button>
            </div>
          </div>
        ) : null}
        {runInterrupted && !pipelineCheckpoint ? (
          <div className="flex w-full basis-full flex-col gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100/90 sm:flex-row sm:items-start">
            <div className="flex min-w-0 flex-1 gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              <p className="min-w-0 flex-1">
                {recoverableResumeError ? (
                  <>
                    Recoverable network/API error — <span className="font-medium text-foreground/90">Resume</span> retries
                    from your continuation seed. Mid-module position requires Pause &amp; save (checkpoint) first.
                  </>
                ) : (
                  <>
                    Reload or session restore — entries merged from disk where possible.{' '}
                    <span className="font-medium text-foreground/90">Resume</span> uses the server continuation seed (not a
                    module checkpoint unless you cooperatively paused).
                  </>
                )}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:pt-0">
              <Button
                type="button"
                variant="default"
                size="sm"
                className="h-7 gap-1 text-[10px]"
                disabled={isProcessing || resumeInterruptedBusy}
                title={isProcessing ? 'A run is already in progress' : undefined}
                onClick={() => void resumeInterruptedPipeline()}
              >
                <RotateCcw className="h-3 w-3 shrink-0" aria-hidden />
                Resume
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 border-amber-500/40 text-[10px]"
                onClick={() => consciousnessStreamStore.dismissInterrupted()}
              >
                Hide notice
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/70 bg-muted/10 px-4 py-2">
        <select
          value={mindPhase}
          onChange={(e) => consciousnessStreamStore.setState({ mindPhase: e.target.value })}
          disabled={streamLocksUi}
          className="rounded border border-input bg-background px-2 py-1 text-[10px]"
        >
          {MIND_PHASE_OPTIONS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <div
          className="flex min-w-[112px] max-w-[160px] flex-1 items-center gap-2"
          title="Arousal tracks the model’s internal state (emotion, interoception, voice) during runs; it is not editable."
        >
          <span className="shrink-0 text-[10px] text-muted-foreground">arousal</span>
          <div className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full border border-border/80 bg-muted/50">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-500/70 to-rose-500/80 transition-[width] duration-300 ease-out"
              style={{
                width: `${Math.min(100, Math.max(0, Number(arousal) || 0) * 100)}%`,
              }}
            />
          </div>
          <span className="w-7 shrink-0 tabular-nums text-[10px] text-muted-foreground">
            {Number(arousal).toFixed(2)}
          </span>
        </div>
        <Input
          value={streamIntent}
          onChange={(e) => consciousnessStreamStore.setState({ streamIntent: e.target.value })}
          placeholder="Intent (optional)"
          className="h-7 min-w-[140px] max-w-[220px] flex-1 bg-background text-[10px]"
          disabled={streamLocksUi}
        />
      </div>

      <PipelineStageMinimap snapshot={pipelineMinimapSnapshot} />

      {betweenMinimapAndTranscript ? (
        <div className="shrink-0 border-b border-border/70 bg-muted/10 px-3 py-2">
          {betweenMinimapAndTranscript}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto bg-background p-4 font-mono text-xs [overflow-anchor:none]"
      >
        {streamEntries.length === 0 && !isProcessing ? (
          <div className="py-20 text-center text-muted-foreground">
            <TitleIcon className="mx-auto mb-3 h-8 w-8 opacity-20" />
            <p>The stream awaits your first thought…</p>
          </div>
        ) : null}
        {streamRenderPlan.map((segment) => {
          if (segment.kind === 'flat') {
            return (
              <Fragment key={segment.key}>
                {segment.entries.map((entry) => (
                  <ConsciousnessStreamEntryRow key={entry.id} entry={entry} />
                ))}
              </Fragment>
            );
          }
          const n = segment.pipelineEntries.length;
          return (
            <div key={segment.key} className="space-y-0.5">
              <ConsciousnessStreamEntryRow entry={segment.userEntry} />
              <details className="group rounded-md border border-border/60 bg-muted/5 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-center gap-2 py-1.5 pl-2 pr-2 font-sans text-[11px] text-muted-foreground/90 hover:bg-muted/20">
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
                  <span>Pipeline details{n > 0 ? ` (${n} ${n === 1 ? 'line' : 'lines'})` : ''}</span>
                </summary>
                <div className="space-y-0.5 border-t border-border/40 px-2 pb-2 pt-1">
                  {segment.pipelineEntries.map((entry) => (
                    <ConsciousnessStreamEntryRow key={entry.id} entry={entry} />
                  ))}
                </div>
              </details>
              <ConsciousnessStreamEntryRow entry={segment.voiceEntry} />
            </div>
          );
        })}
        {isProcessing ? (
          <div className="flex gap-3 py-0.5">
            <span className="w-16 text-right text-muted-foreground/30">…</span>
            <Loader2 className="mt-0.5 h-3 w-3 animate-spin text-primary" />
            <span className="text-muted-foreground/50">processing…</span>
          </div>
        ) : null}
        <div ref={streamEndRef} className="h-px w-full shrink-0" aria-hidden />
      </div>

      {beforeComposer ? <div className="shrink-0 border-t border-border">{beforeComposer}</div> : null}

      <div className="shrink-0 border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
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
                runStream();
              }
            }}
            placeholder="Enter a thought, question, or scenario…"
            className="min-w-[120px] flex-1 bg-muted/30 font-mono text-xs"
            disabled={streamLocksUi}
          />
          <Button
            type="button"
            size="icon"
            disabled={
              streamLocksUi || (!input.trim() && pendingFiles.length === 0 && attachments.length === 0)
            }
            onClick={runStream}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
