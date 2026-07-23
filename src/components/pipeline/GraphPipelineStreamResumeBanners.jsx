import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, Play, RotateCcw } from 'lucide-react';
import { Button, toast } from '../ui';
import { subscribeConsciousnessStream, consciousnessStreamStore } from '../../lib/consciousnessStreamStore';
import { startConsciousnessStreamRun } from '../../lib/consciousnessStreamRunner';
import { resumeInterruptedGraphPipelineManual } from '../../lib/reconnectRecovery';
import {
  graphPipelineStore,
  subscribeGraphPipeline,
  validCooperativePipelineCheckpoint,
} from '../../lib/graphPipelineStore';
import { isTransientReconnectFailure } from '../../lib/transientPipelineFailure.js';
import {
  findResumableCheckpointForGraphSessionFromDb,
  tryLoadCheckpointFromDbIntoStore,
} from '../../lib/graphPipelineCheckpointResume';
import { graphResumeStreamOptsForSession } from '../../lib/playgroundDualGraphRunner';
import {
  MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR,
  normalizeScheduledTaskMindStorageProfile,
} from '../../lib/mindEntityContext';
import {
  PLAYGROUND_GRAPH_SESSION_B,
  resolveGraphSessionMindStorageProfile,
} from '../../lib/graphSessionMindProfile';
import { cn } from '../../lib/utils';

/**
 * Checkpoint + interrupted + retry-from-checkpoint banners shared by Graph Pipeline and System Chat.
 * @param {{ graphSessionId: string, mindStorageProfileOverride?: string }} props
 */
export default function GraphPipelineStreamResumeBanners({ graphSessionId, mindStorageProfileOverride }) {
  const snap = useSyncExternalStore(
    subscribeConsciousnessStream,
    () => consciousnessStreamStore.getState(),
    () => consciousnessStreamStore.getState()
  );

  const { isProcessing, runInterrupted } = snap;

  const [resumeInterruptedBusy, setResumeInterruptedBusy] = useState(false);
  const [checkpointResumeBusy, setCheckpointResumeBusy] = useState(false);
  const [dbCheckpointAvailable, setDbCheckpointAvailable] = useState(null);

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
  const streamLocksUi = isProcessing;
  const runErrorText = gpSnap.runError != null && String(gpSnap.runError).trim() ? String(gpSnap.runError).trim() : '';
  const sid = graphSessionId != null && String(graphSessionId).trim() ? String(graphSessionId).trim() : '';
  const mirrorChrome = useMemo(() => {
    if (mindStorageProfileOverride != null && String(mindStorageProfileOverride).trim() !== '') {
      return (
        normalizeScheduledTaskMindStorageProfile(mindStorageProfileOverride) ===
        MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR
      );
    }
    if (!sid) return false;
    if (sid === PLAYGROUND_GRAPH_SESSION_B) return true;
    return resolveGraphSessionMindStorageProfile(sid) === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR;
  }, [mindStorageProfileOverride, sid]);
  const resumeMindOpts = useMemo(() => {
    if (mindStorageProfileOverride == null || String(mindStorageProfileOverride).trim() === '') return {};
    return { mindStorageProfile: normalizeScheduledTaskMindStorageProfile(mindStorageProfileOverride) };
  }, [mindStorageProfileOverride]);

  useEffect(() => {
    if (!runErrorText || pipelineCheckpoint || !sid) {
      setDbCheckpointAvailable(null);
      return undefined;
    }
    let cancelled = false;
    setDbCheckpointAvailable(null);
    void (async () => {
      try {
        const blob = await findResumableCheckpointForGraphSessionFromDb(sid);
        if (!cancelled) setDbCheckpointAvailable(Boolean(blob));
      } catch {
        if (!cancelled) setDbCheckpointAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runErrorText, pipelineCheckpoint, sid]);

  const resumeFromLastCheckpointAfterFailure = useCallback(async () => {
    setCheckpointResumeBusy(true);
    try {
      const loaded = await tryLoadCheckpointFromDbIntoStore(sid);
      if (!loaded.ok) {
        toast({
          title: 'No checkpoint to resume',
          description:
            'No saved module checkpoint was found for this session. Start a new run, or use Pause to save progress earlier.',
          variant: 'destructive',
        });
        return;
      }
      await startConsciousnessStreamRun({
        resumeFromCheckpoint: true,
        ...graphResumeStreamOptsForSession(sid),
        ...(sid ? { graphSessionIdForPersistence: sid } : {}),
        ...resumeMindOpts,
      });
    } catch (e) {
      toast({
        title: 'Resume from checkpoint failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setCheckpointResumeBusy(false);
    }
  }, [sid, resumeMindOpts]);

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
      {pipelineCheckpoint && !runErrorText ? (
        <div
          className={cn(
            'flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2 text-xs sm:flex-row sm:items-center',
            mirrorChrome
              ? 'bg-red-500/5 dark:bg-red-950/25'
              : 'bg-sky-500/5 dark:bg-sky-950/25'
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Play
              className={cn('h-3.5 w-3.5 shrink-0', mirrorChrome ? 'text-red-400' : 'text-sky-400')}
              aria-hidden
            />
            <p className="min-w-0 flex-1 text-muted-foreground">
              Cooperative checkpoint saved — mid-pipeline resume.{' '}
              <span className="font-medium text-foreground/90">Continue</span> picks up at the next module, or discard.
              {ckNextModule ? (
                <span className="mt-0.5 block text-[11px] text-muted-foreground/95">
                  Next: <span className="font-medium text-foreground/90">{ckNextModule}</span>
                  {typeof ckSavedAt === 'number'
                    ? ` · ${new Date(ckSavedAt).toLocaleString()}`
                    : ''}
                </span>
              ) : null}
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
                    await startConsciousnessStreamRun({
                      resumeFromCheckpoint: true,
                      ...graphResumeStreamOptsForSession(sid),
                      ...(sid ? { graphSessionIdForPersistence: sid } : {}),
                      ...resumeMindOpts,
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
              className={cn('h-7 text-xs', mirrorChrome ? 'border-red-500/40' : 'border-sky-500/40')}
              disabled={streamLocksUi}
              onClick={() => graphPipelineStore.clearPipelineCheckpoint()}
            >
              Discard
            </Button>
          </div>
        </div>
      ) : null}

      {runErrorText && !streamLocksUi && (pipelineCheckpoint || dbCheckpointAvailable) ? (
        <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-red-500/5 px-4 py-2 text-xs sm:flex-row sm:items-center dark:bg-red-950/20">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <RotateCcw className="h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden />
            <p className="min-w-0 flex-1 text-muted-foreground">
              Pipeline stopped with an error. If a module finished before the failure, you can{' '}
              <span className="font-medium text-foreground/90">retry from the last saved checkpoint</span> instead of
              starting over.
              {pipelineCheckpoint ? (
                <span className="mt-0.5 block text-[11px] text-muted-foreground/95">
                  Checkpoint is already loaded — continues at the next module.
                </span>
              ) : dbCheckpointAvailable ? (
                <span className="mt-0.5 block text-[11px] text-muted-foreground/95">
                  A checkpoint was found in your local pipeline log for this session.
                </span>
              ) : null}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              className="h-7 gap-1 border-red-500/30 text-xs"
              disabled={streamLocksUi || checkpointResumeBusy}
              onClick={() => {
                if (pipelineCheckpoint) {
                  setCheckpointResumeBusy(true);
                  void (async () => {
                    try {
                      await startConsciousnessStreamRun({
                        resumeFromCheckpoint: true,
                        ...graphResumeStreamOptsForSession(sid),
                        ...(sid ? { graphSessionIdForPersistence: sid } : {}),
                        ...resumeMindOpts,
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
                } else {
                  void resumeFromLastCheckpointAfterFailure();
                }
              }}
            >
              <RotateCcw className="h-3 w-3 shrink-0" aria-hidden />
              Retry from last checkpoint
            </Button>
          </div>
        </div>
      ) : null}

      {runInterrupted && !pipelineCheckpoint ? (
        <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-amber-500/5 px-4 py-2 text-xs sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
            <p className="min-w-0 flex-1 text-muted-foreground">
              {recoverableResumeError ? (
                <>
                  Last run stopped on a recoverable network/API error.{' '}
                  <span className="font-medium text-foreground/90">Resume</span> retries using your continuation seed;
                  mid-module position needs a cooperative checkpoint (Pause) or the sky banner above.
                </>
              ) : (
                <>
                  Session restored or reload — transcript merged from disk where possible.{' '}
                  <span className="font-medium text-foreground/90">Resume</span> continues from the server continuation
                  seed (not a module checkpoint unless you paused cooperatively).
                </>
              )}
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
    </>
  );
}
