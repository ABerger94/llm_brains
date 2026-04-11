import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import moment from 'moment';
import {
  Activity,
  AlertTriangle,
  BookOpen,
  Brain,
  CheckCircle,
  Clock,
  Cpu,
  Database,
  Fingerprint,
  GitBranch,
  HeartPulse,
  Play,
  FlaskConical,
  Loader2,
  Download,
  Radio,
  RefreshCw,
  ScanSearch,
  Search,
  StopCircle,
  Target,
  Upload,
  Trash2,
  Pause,
} from 'lucide-react';
import NeuralNetworkViz from '../components/NeuralNetworkViz';
import { PipelineProgressTrack } from '../components/consciousness/PipelineProgressTrack';
import { COGNITIVE_MODULES } from '../lib/cognitiveModules';
import { PipelineRun, Dataset, TrainingRun } from '../lib/data';
import { Button, toast } from '../components/ui';
import { buildMindArchiveBlob, importMindArchive, wipeAllLocalMindData } from '../lib/mindBackup';
import { cn } from '../lib/utils';
import { getDashboardActiveWorkSnapshot, subscribeDashboardActiveWork } from '../lib/dashboardActiveWork';
import {
  getDashboardConnectivitySnapshot,
  subscribeDashboardConnectivity,
} from '../lib/dashboardConnectivitySnapshot';
import { abortDashboardActivePipelineRow } from '../lib/dashboardAbortActivePipeline';
import { useDashboardPauseAllSettlement } from '../lib/useDashboardPauseAllSettlement';
import { resetDashboardPauseAllUi } from '../lib/dashboardPauseAllAckStore';
import { reloadInterruptedPipelineWorkFromDashboard } from '../lib/reloadInterruptedPipelineWork';
import {
  getVoiceModuleOutputTextFromPipelineRun,
  pickLatestPipelineRunWithVoiceModuleOutput,
} from '../lib/pipelineRunCheckpoint';
import { splitVoiceOutputBeliefRevisionsAppendix } from '../../shared/beliefRevisionsVoice.mjs';

/** Fallback label when health has not reported a model yet. */
const PRIMARY_MODEL_LABEL = 'HF + OpenRouter + local (see .env.example for model limits)';

/** Pretty-print known router and LM Studio model ids for the dashboard. */
function formatActiveModelName(modelId) {
  const s = String(modelId || '').trim();
  if (!s) return PRIMARY_MODEL_LABEL;
  if (/^neuraldaredevil-8b-obliterated$/i.test(s)) return 'Neural Daredevil (local id)';
  if (/dolphin3\.0-r1-mistral-24b/i.test(s)) return 'Dolphin 3.0 R1 Mistral 24B';
  if (/Dolphin3\.0-R1-Mistral-24B/i.test(s)) return 'Dolphin 3.0 R1 Mistral 24B';
  if (/cognitivecomputations\/dolphin3\.0-r1-mistral-24b/i.test(s)) return 'Dolphin 3.0 R1 Mistral 24B';
  if (/dolphin-mistral-24b-venice-edition/i.test(s)) return 'Dolphin Mistral 24B (Venice, OpenRouter)';
  if (/dphn\/Dolphin-Mistral-24B-Venice-Edition/i.test(s)) return 'Dolphin Mistral 24B (Venice, HF router)';
  if (/NeuralDaredevil-8B-abliterated/i.test(s)) return 'Neural Daredevil 8B (HF · Featherless)';
  return s.replace(/:featherless-ai$/i, ' (HF · Featherless)');
}

function StatusCard({
  icon: Icon,
  label,
  value,
  subtext,
  className,
  valueClassName,
  secondaryValue,
  secondaryValueClassName,
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-border/80',
        className
      )}
    >
      <div className="mb-2 flex items-center gap-3">
        <Icon className="h-5 w-5 shrink-0 text-primary" />
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      </div>
      <div
        className={cn('break-words text-lg font-bold leading-snug', valueClassName || 'text-foreground')}
      >
        {value}
      </div>
      {secondaryValue ? (
        <div
          className={cn(
            'mt-0.5 break-words text-lg font-bold leading-snug',
            secondaryValueClassName || 'text-foreground'
          )}
        >
          {secondaryValue}
        </div>
      ) : null}
      {subtext ? <p className="mt-1 text-xs text-muted-foreground">{subtext}</p> : null}
    </div>
  );
}

function narrativeFromRun(run) {
  const mo = run?.module_outputs || run?.moduleOutputs || {};
  return String(mo.Narrative || mo.narrative || '').trim();
}

function activeWorkRowIcon(variant) {
  switch (variant) {
    case 'graph':
      return GitBranch;
    case 'curiosity':
      return ScanSearch;
    case 'goal':
      return Target;
    case 'global':
      return Cpu;
    case 'scheduler':
      return Clock;
    default:
      return Activity;
  }
}

function DashboardActiveWorkSection({ onResumeAllPipelines, resumeAllPipelinesBusy }) {
  const { rows } = useSyncExternalStore(
    subscribeDashboardActiveWork,
    getDashboardActiveWorkSnapshot,
    getDashboardActiveWorkSnapshot
  );
  const {
    pauseAllBusy,
    runPauseAll,
    isWaitingSettle,
    isCompleteFlash,
    pauseButtonTitle,
    resumeButtonTitle,
    pauseAllSucceededAck,
  } = useDashboardPauseAllSettlement({
    activeRowCount: rows.length,
    resumeAllPipelinesBusy,
  });

  const allPaused = rows.length > 0 && rows.every((r) => r.paused);

  return (
    <div
      className={cn(
        'mt-6 rounded-xl border p-4 shadow-sm transition-[border-color,background-color] duration-300',
        isWaitingSettle &&
          'border-amber-500/40 bg-amber-500/[0.06] dark:border-amber-400/35 dark:bg-amber-950/20',
        isCompleteFlash &&
          'border-emerald-500/35 bg-emerald-500/[0.05] dark:border-emerald-500/30 dark:bg-emerald-950/20',
        !isWaitingSettle && !isCompleteFlash && allPaused &&
          'border-muted-foreground/20 bg-muted/10 dark:border-muted-foreground/15 dark:bg-muted/5',
        !isWaitingSettle && !isCompleteFlash && !allPaused && 'border-border bg-card'
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {isCompleteFlash ? (
            <CheckCircle
              className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden
            />
          ) : isWaitingSettle ? (
            <Loader2
              className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600 dark:text-amber-400"
              aria-hidden
            />
          ) : allPaused ? (
            <Pause className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          ) : rows.length > 0 ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-hidden />
          ) : (
            <Activity className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
          )}
          {allPaused ? 'Paused pipelines' : 'Active pipelines & pages'}
        </h2>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              'h-7 gap-1 text-[10px]',
              isWaitingSettle &&
                'border-amber-500/55 bg-amber-500/10 text-amber-950 hover:bg-amber-500/[0.16] dark:border-amber-400/45 dark:bg-amber-950/35 dark:text-amber-100 dark:hover:bg-amber-950/45'
            )}
            disabled={pauseAllBusy || resumeAllPipelinesBusy}
            title={pauseButtonTitle}
            onClick={() => {
              void runPauseAll();
            }}
          >
            <Pause className="h-3 w-3 shrink-0" aria-hidden />
            Pause &amp; save all
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              'h-7 gap-1 text-[10px]',
              isCompleteFlash &&
                'border-emerald-600/80 bg-emerald-500/10 text-emerald-900 hover:bg-emerald-500/[0.18] dark:border-emerald-500/55 dark:bg-emerald-950/40 dark:text-emerald-100 dark:hover:bg-emerald-950/55'
            )}
            disabled={pauseAllBusy || resumeAllPipelinesBusy}
            title={resumeButtonTitle}
            onClick={() => {
              if (typeof onResumeAllPipelines === 'function') onResumeAllPipelines();
            }}
          >
            <Play className="h-3 w-3 shrink-0" aria-hidden />
            Resume all
          </Button>
          <span className="text-[10px] text-muted-foreground">
            Pause: this tab + other windows, and holds due scheduled tasks until you Resume all. Resume: checkpoints,
            paused pursuits, and releases the scheduler hold.
          </span>
        </div>
        {isWaitingSettle ? (
          <p className="mb-2 text-[10px] leading-snug text-amber-900/90 dark:text-amber-200/90">
            Cooperative pause: pipelines finish the current LLM module first, then stop and save checkpoints — not an instant abort.
          </p>
        ) : null}
      </div>
      {rows.length === 0 ? (
        isCompleteFlash ? (
          <div className="rounded-lg border border-dashed border-emerald-500/45 bg-emerald-500/[0.06] px-3 py-6 text-center dark:border-emerald-500/35 dark:bg-emerald-950/25">
            <CheckCircle
              className="mx-auto mb-2 h-8 w-8 text-emerald-600 dark:text-emerald-400"
              aria-hidden
            />
            <p className="text-sm font-medium text-emerald-900 dark:text-emerald-100">
              All active pipelines in this tab have finished; checkpoints are saved.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Use Resume all when you want to continue from saved checkpoints or paused pursuits.
            </p>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border/80 bg-muted/20 px-3 py-6 text-center text-sm text-muted-foreground">
            No interactive graph runs or curiosity / goal pursuits in progress.
          </p>
        )
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const isAttentionRow = row.interrupted;
            const isPausedRow = Boolean(row.paused);
            const RowIcon = activeWorkRowIcon(row.variant);
            const progressAmber = isAttentionRow;
            const showStop = row.variant !== 'global';
            const baseStopLabel =
              row.key === 'graph-pipeline-interrupted'
                ? 'Clear'
                : row.key === 'graph-pipeline-checkpoint'
                  ? 'Discard'
                  : 'Stop';
            const showPausedInstead =
              isPausedRow || (pauseAllSucceededAck && baseStopLabel === 'Stop' && !isAttentionRow);
            const stopLabel = showPausedInstead ? 'Paused' : baseStopLabel;

            return (
              <li
                key={row.key}
                className={cn(
                  'flex min-h-0 overflow-hidden rounded-lg border',
                  isAttentionRow
                    ? 'border-amber-500/45 dark:border-amber-400/35'
                    : isPausedRow
                      ? 'border-muted-foreground/25 dark:border-muted-foreground/20'
                      : 'border-border/80'
                )}
              >
                <div
                  className={cn(
                    'flex min-w-0 flex-1 items-start gap-3 rounded-l-lg p-3',
                    isAttentionRow
                      ? 'bg-amber-500/[0.06] dark:bg-amber-950/20'
                      : isPausedRow
                        ? 'bg-muted/20 dark:bg-muted/10'
                        : 'bg-muted/10'
                  )}
                >
                  <Link
                    to={row.href}
                    className={cn(
                      'flex min-w-0 flex-1 items-start gap-3 transition-colors',
                      isAttentionRow ? 'hover:bg-amber-500/[0.04] dark:hover:bg-amber-950/25' : 'hover:bg-muted/25'
                    )}
                  >
                    <div
                      className={cn(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-md border',
                        isPausedRow
                          ? 'border-muted-foreground/20 bg-muted/30'
                          : 'border-primary/20 bg-primary/10'
                      )}
                    >
                      <RowIcon
                        className={cn('h-4 w-4', isPausedRow ? 'text-muted-foreground' : 'text-primary')}
                        aria-hidden
                      />
                    </div>
                    <div className="min-w-0 flex-1 space-y-2">
                      <div>
                        <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/90">
                          Source
                        </div>
                        <div
                          className={cn(
                            'text-[10px] font-semibold uppercase tracking-wide',
                            isPausedRow ? 'text-muted-foreground' : 'text-primary'
                          )}
                        >
                          {row.pageName}
                        </div>
                      </div>
                      <div>
                        <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/90">
                          Topic
                        </div>
                        <div
                          className={cn(
                            'text-sm font-medium leading-snug',
                            isPausedRow ? 'text-muted-foreground' : 'text-foreground'
                          )}
                        >
                          {row.title}
                        </div>
                      </div>
                      <div>
                        <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/90">
                          Status
                        </div>
                        {(() => {
                          const raw = String(row.detail || '');
                          const nl = raw.indexOf('\n');
                          if (nl === -1) {
                            return (
                              <p
                                className={cn(
                                  'mt-0.5 line-clamp-4 text-xs font-medium leading-relaxed',
                                  isAttentionRow
                                    ? 'text-amber-800 dark:text-amber-300'
                                    : isPausedRow
                                      ? 'text-muted-foreground'
                                      : 'text-foreground'
                                )}
                              >
                                {raw}
                              </p>
                            );
                          }
                          const lead = raw.slice(0, nl).trim();
                          const tail = raw.slice(nl + 1).trim();
                          return (
                            <div className="mt-0.5 space-y-0.5">
                              <p
                                className={cn(
                                  'line-clamp-2 text-xs font-medium leading-relaxed',
                                  isAttentionRow
                                    ? 'text-amber-800 dark:text-amber-300'
                                    : isPausedRow
                                      ? 'text-muted-foreground'
                                      : 'text-foreground'
                                )}
                              >
                                {lead}
                              </p>
                              {tail ? (
                                <p className="line-clamp-3 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                                  {tail}
                                </p>
                              ) : null}
                            </div>
                          );
                        })()}
                      </div>
                      <PipelineProgressTrack
                        className={cn('pt-0.5', isPausedRow && 'opacity-50')}
                        indeterminate={Boolean(row.pipelineProgressIndeterminate)}
                        progressPercent={row.pipelineProgress}
                        progressAmber={progressAmber}
                        moduleStatuses={row.moduleStatuses}
                      />
                    </div>
                  </Link>
                </div>
                <div
                    className={cn(
                    'grid min-w-[4.5rem] shrink-0 self-stretch overflow-hidden rounded-r-lg border-l border-border',
                    showStop ? 'grid-rows-[3fr_1fr]' : 'grid-rows-[1fr]',
                    isAttentionRow
                      ? 'bg-amber-500/[0.06] dark:bg-amber-950/20'
                      : isPausedRow
                        ? 'bg-muted/20 dark:bg-muted/10'
                        : 'bg-muted/10'
                  )}
                >
                  <Link
                    to={row.href}
                    title={row.interrupted ? 'Interrupted — open destination to resume or clear' : undefined}
                    className={cn(
                      'flex min-h-0 flex-col items-center justify-center gap-1 px-2 py-2 text-center transition-colors',
                      isAttentionRow
                        ? 'hover:bg-amber-500/12 dark:hover:bg-amber-950/30'
                        : 'hover:bg-muted/25'
                    )}
                  >
                    {row.interrupted ? (
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400" aria-hidden />
                    ) : null}
                    <span className="text-[10px] font-medium text-muted-foreground">Open →</span>
                  </Link>
                  {showStop ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      title={
                        showPausedInstead
                          ? isPausedRow
                            ? 'Pipeline paused — click Discard to remove, or use Resume all.'
                            : 'Cooperative pause requested — click to force-stop and clear this entry.'
                          : undefined
                      }
                      className={cn(
                        'h-auto min-h-0 w-full flex-col gap-0.5 rounded-none border-0 border-t border-border px-2 py-1 text-[10px] font-semibold',
                        showPausedInstead
                          ? 'text-muted-foreground hover:bg-muted/30 hover:text-muted-foreground'
                          : 'text-destructive hover:bg-destructive/10 hover:text-destructive',
                        isAttentionRow && !showPausedInstead ? 'hover:bg-destructive/10 dark:bg-amber-950/25' : ''
                      )}
                      aria-label={
                        showPausedInstead
                          ? `Paused — click to ${isPausedRow ? 'discard' : 'force-stop'} ${row.pageName}`
                          : `${stopLabel}: ${row.pageName}`
                      }
                      onClick={async () => {
                        const r = await abortDashboardActivePipelineRow(row);
                        if (showPausedInstead && !isPausedRow && r.ok) {
                          resetDashboardPauseAllUi();
                        }
                        toast({
                          title: r.ok
                            ? baseStopLabel === 'Clear'
                              ? 'Cleared'
                              : baseStopLabel === 'Discard'
                                ? 'Discarded'
                                : 'Stopped'
                            : 'Cannot stop',
                          description: r.message || '',
                          variant: r.ok ? undefined : 'destructive',
                        });
                      }}
                    >
                      {showPausedInstead ? (
                        <Pause className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                      ) : (
                        <StopCircle className="h-3 w-3 shrink-0 text-red-600 dark:text-red-500" aria-hidden />
                      )}
                      {stopLabel}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [health, setHealth] = useState(null);
  const [healthErr, setHealthErr] = useState(null);
  const [latestRun, setLatestRun] = useState(null);
  const [stats, setStats] = useState({ runs: 0, datasets: 0, trainings: 0 });
  const [includeAppPrefsInExport, setIncludeAppPrefsInExport] = useState(false);
  const [recoveryPipelinesBusy, setRecoveryPipelinesBusy] = useState(false);
  const mindBackupFileRef = useRef(null);
  const recoveryPipelinesInFlightRef = useRef(false);

  const runDashboardPipelineRecovery = useCallback(async (kind) => {
    if (recoveryPipelinesInFlightRef.current) return;
    recoveryPipelinesInFlightRef.current = true;
    setRecoveryPipelinesBusy(true);
      const isResumeAll = kind === 'resume_all';
    toast({
      title: isResumeAll ? 'Resume all' : 'Rerun interrupted',
      description: isResumeAll
        ? 'Resuming saved graph checkpoints, paused scheduler graph tasks, and paused or interrupted curiosity/goal graph pursuits where possible.'
        : 'Resuming paused scheduler pipelines, waking due queued tasks, and rerunning interrupted curiosity/goal pursuits. Use Resume all for the interactive graph checkpoint.',
    });
    try {
      const r = await reloadInterruptedPipelineWorkFromDashboard({
        mode: isResumeAll ? 'resume_all' : 'rerun_interrupted',
      });
      const bits = [];
      if (r.curiosityMerged > 0) {
        bits.push(`${r.curiosityMerged} curiosity slot(s) merged from storage`);
      }
      if (r.goalMerged > 0) {
        bits.push(`${r.goalMerged} goal slot(s) merged from storage`);
      }
      const { graphStarted, graphReason } = r.graph;
      if (graphStarted && graphReason === 'started_from_checkpoint') {
        bits.push('Graph: resumed from cooperative checkpoint');
      } else if (graphStarted) {
        bits.push('Graph pipeline ran');
      } else if (graphReason === 'not_interrupted') {
        bits.push('Graph: none to resume');
      } else if (graphReason === 'already_running') {
        bits.push('Graph: already active');
      } else if (graphReason === 'pipeline_busy') {
        bits.push('Graph: interactive run already active');
      } else if (graphReason === 'no_recoverable_input') {
        bits.push('Graph: no saved input');
      } else if (graphReason === 'not_started') {
        bits.push('Graph: did not start');
      } else if (graphReason === 'skipped_rerun_interrupted_mode') {
        bits.push('Graph: skipped — use Resume all for interactive checkpoint');
      } else if (String(graphReason || '').startsWith('error:')) {
        bits.push(`Graph error: ${String(graphReason).replace(/^error:/, '').trim()}`);
      }
      const otherCk = Number(r.graph?.otherGraphCheckpointSessions ?? 0);
      if (otherCk > 0) {
        bits.push(
          `Graph: ${otherCk} other saved session(s) — run Resume all again to resume the next checkpoint`
        );
      }
      const sOk = r.scheduledPausedResumes?.filter((x) => x.ok).length ?? 0;
      const sFail = r.scheduledPausedResumes?.filter((x) => !x.ok).length ?? 0;
      if ((r.scheduledPausedResumes?.length ?? 0) > 0) {
        bits.push(`Scheduler paused graphs ${sOk} ok${sFail ? `, ${sFail} failed` : ''}`);
      }
      const cOk = r.curiosityReruns?.filter((x) => x.ok).length ?? 0;
      const cFail = r.curiosityReruns?.filter((x) => !x.ok).length ?? 0;
      if ((r.curiosityReruns?.length ?? 0) > 0) {
        bits.push(`Curiosity pursue ${cOk} ok${cFail ? `, ${cFail} failed` : ''}`);
      }
      const gOk = r.goalReruns?.filter((x) => x.ok).length ?? 0;
      const gFail = r.goalReruns?.filter((x) => !x.ok).length ?? 0;
      if ((r.goalReruns?.length ?? 0) > 0) {
        bits.push(`Goals pursue ${gOk} ok${gFail ? `, ${gFail} failed` : ''}`);
      }
      toast({
        title: isResumeAll ? 'Resume all' : 'Rerun interrupted pipelines',
        description:
          bits.join(' · ') ||
          (isResumeAll
            ? 'Nothing to resume was found (graph checkpoint, paused pursuits, or reload-interrupted slots).'
            : 'Nothing to rerun was found (scheduler paused/queued wake, or interrupted pursuits). Use Resume all for the graph.'),
      });
    } catch (e) {
      toast({
        title: isResumeAll ? 'Resume all failed' : 'Rerun interrupted pipelines failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      recoveryPipelinesInFlightRef.current = false;
      setRecoveryPipelinesBusy(false);
    }
  }, []);

  const handleMindExport = useCallback(async () => {
    try {
      const { blob, filename } = await buildMindArchiveBlob({ includeAppPrefs: includeAppPrefsInExport });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: 'Backup downloaded', description: filename });
    } catch (e) {
      toast({
        title: 'Export failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    }
  }, [includeAppPrefsInExport]);

  const handleMindImportPick = useCallback(() => {
    mindBackupFileRef.current?.click();
  }, []);

  const handleMindImportFile = useCallback((e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const ok = window.confirm(
      'This replaces IndexedDB mind data in this browser with the backup (KV + entity records; optional app prefs if present). Continue?'
    );
    if (!ok) return;
    const reader = new FileReader();
    reader.onload = () => {
      void (async () => {
        const text = String(reader.result ?? '');
        const result = await importMindArchive(text);
        if (!result.ok) {
          toast({ title: 'Import failed', description: result.error, variant: 'destructive' });
          return;
        }
        toast({
          title: 'Mind restored',
          description: `${result.keyCount} item(s) imported. Reloading…`,
        });
        window.setTimeout(() => window.location.reload(), 400);
      })();
    };
    reader.onerror = () => {
      toast({ title: 'Import failed', description: 'Could not read file.', variant: 'destructive' });
    };
    reader.readAsText(file);
  }, []);

  const handleWipeAllLocalData = useCallback(() => {
    const ok = window.confirm(
      'Erase ALL locally stored MyBrain data in this browser? This removes IndexedDB (KV + entities), Origin Private File System staging under mybrain/opfs, and any legacy localStorage keys (mybrain_*, yourbrain_*, my_brain_*, your_brain_*). This cannot be undone. Continue?'
    );
    if (!ok) return;
    void (async () => {
      const { removedKeys } = await wipeAllLocalMindData();
      toast({
        title: 'Local data erased',
        description: `${removedKeys.length} legacy localStorage key(s) removed; IndexedDB cleared. Reloading…`,
      });
      window.setTimeout(() => window.location.reload(), 400);
    })();
  }, []);

  const loadHealth = useCallback(async () => {
    const ac = new AbortController();
    const tid = window.setTimeout(() => ac.abort(), 12_000);
    try {
      const res = await fetch('/api/health', { signal: ac.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setHealth(data);
      setHealthErr(null);
    } catch (e) {
      setHealth(null);
      if (e?.name === 'AbortError') {
        setHealthErr(null);
      } else {
        setHealthErr(e?.message || 'Could not reach API');
      }
    } finally {
      window.clearTimeout(tid);
    }
  }, []);

  const loadLocalStats = useCallback(async () => {
    try {
      const [runs, datasets, trainings] = await Promise.all([
        PipelineRun.list('-created_date', 500),
        Dataset.list('-created_date', 200),
        TrainingRun.list('-created_date', 200),
      ]);
      setLatestRun(pickLatestPipelineRunWithVoiceModuleOutput(runs) || null);
      setStats({
        runs: runs.length,
        datasets: datasets.length,
        trainings: trainings.length,
      });
    } catch {
      /* local entity read failed — leave prior state */
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadHealth(), loadLocalStats()]);
  }, [loadHealth, loadLocalStats]);

  const connectivity = useSyncExternalStore(
    subscribeDashboardConnectivity,
    getDashboardConnectivitySnapshot,
    getDashboardConnectivitySnapshot
  );

  useEffect(() => {
    refreshAll();
    const id = setInterval(refreshAll, 10_000);
    const onVis = () => {
      if (document.visibilityState === 'visible') refreshAll();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refreshAll]);

  const llm = health?.llm;
  const inFlight = (llm?.inFlight ?? 0) > 0;

  const last = llm?.lastCall;
  const tryFirst = llm?.tryFirst;
  const providerChain = Array.isArray(llm?.providerIds) ? llm.providerIds.join(' → ') : '';
  const orderHint =
    llm?.localFirst === true
      ? 'Try-first: local → OpenRouter → Hugging Face (LLM_LOCAL_FIRST; use npm run dev:local for that stack).'
      : llm?.hfFirst === true
        ? 'Try-first: Hugging Face → OpenRouter → local (LLM_HF_FIRST — default npm run dev on port 5174).'
        : 'Provider order from .env (see .env.example).';

  const pipelineLive = connectivity.pipelineActive;
  const liveHop =
    connectivity.lastLlmModel && String(connectivity.lastLlmModel).trim()
      ? `${connectivity.lastLlmProvider || '?'} · ${formatActiveModelName(connectivity.lastLlmModel)}`
      : '';

  const systemOnline = !healthErr && (Boolean(health) || pipelineLive);

  const headerStatusLabel = healthErr
    ? 'API unreachable'
    : health
      ? 'System online'
      : pipelineLive
        ? 'Pipeline active'
        : 'Connecting…';

  /** Green card: /api/health lastCall when available; else last module_complete from the live graph stream. */
  const activeModelValue = healthErr
    ? 'API Offline'
    : health
      ? last?.model
        ? `${last.provider || '?'} · ${formatActiveModelName(last.model)}`
        : tryFirst?.model
          ? `${tryFirst.provider} · ${formatActiveModelName(tryFirst.model)}`
          : liveHop || 'Not configured'
      : liveHop || '…';

  const activeModelValueClass = healthErr
    ? 'text-red-400'
    : !health
      ? liveHop
        ? 'text-green-400'
        : 'text-muted-foreground'
      : activeModelValue === 'Not configured'
        ? 'text-amber-400/90'
        : last?.model
          ? 'text-green-400'
          : liveHop
            ? 'text-green-400'
            : 'text-amber-400/90';

  const activeModelSub = healthErr
    ? healthErr
    : !health
      ? liveHop
        ? 'From live graph pipeline SSE (health endpoint not loaded yet or timed out).'
        : ''
      : [
          providerChain ? `Chain: ${providerChain}` : null,
          orderHint,
          last?.at ? `Last success ${moment(last.at).fromNow()}` : null,
          last?.model || !tryFirst?.model ? null : `Next hop if unchanged: ${tryFirst.provider} · ${formatActiveModelName(tryFirst.model)}`,
        ]
          .filter(Boolean)
          .join(' · ');

  const narrative = latestRun ? narrativeFromRun(latestRun) : '';
  const finalVoiceDisplay = latestRun
    ? splitVoiceOutputBeliefRevisionsAppendix(getVoiceModuleOutputTextFromPipelineRun(latestRun)).displayText.trim()
    : '';

  return (
    <div className="min-h-screen bg-background">
      <div className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent"
          aria-hidden
        />

        <div className="relative px-4 pb-4 pt-6 sm:px-6 sm:pt-8">
          <div className="mx-auto max-w-7xl">
            <div className="mb-1 flex items-center gap-3">
              <div
                className={cn(
                  'h-2 w-2 rounded-full',
                  systemOnline ? 'animate-pulse bg-emerald-500' : 'bg-amber-500',
                  healthErr && 'bg-red-500'
                )}
              />
              <span className="font-mono text-xs uppercase tracking-widest text-primary">{headerStatusLabel}</span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">MyBrain</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              <span className="text-foreground/80">Six-layer</span> graph pipeline ({' '}
              <span className="text-foreground/80">{COGNITIVE_MODULES.length} modules</span>
              ), beliefs, memory, and world model with probabilistic integrations (adaptive temperature, embedding similarity,
              soft metacognition thresholds, stochastic cognitive policy, calibrated decision thresholds). Supervisors can rerun
              early layers; Integration emits{' '}
              <span className="font-mono text-[11px] text-foreground/75">INTEGRATION_JSON</span> before Language → Narrative →
              Voice. LLMs hit your local Express API: <span className="text-foreground/80">LM Studio</span> first, then
              OpenRouter, then <span className="text-foreground/80">Hugging Face</span> (keys in Settings or{' '}
              <code className="rounded bg-muted/80 px-1 text-[11px]">.env</code>). Mind data stays in the browser.
            </p>

            <div className="mt-8">
              <h2 className="mb-3 text-xs uppercase tracking-widest text-muted-foreground">Quick actions</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-6">
                <Link to="/graph-pipeline" className="block">
                  <Button
                    variant="outline"
                    className="flex h-auto w-full flex-col items-center gap-2 border-border py-4 transition-all hover:border-primary/40 hover:bg-primary/5"
                  >
                    <Play className="h-5 w-5 text-primary" />
                    <span className="text-xs font-medium">Run graph pipeline</span>
                  </Button>
                </Link>
                <Link to="/biography" className="block">
                  <Button
                    variant="outline"
                    className="flex h-auto w-full flex-col items-center gap-2 border-border py-4 transition-all hover:border-primary/30 hover:bg-muted/40"
                  >
                    <BookOpen className="h-5 w-5 text-amber-400" />
                    <span className="text-xs font-medium">Mind Biography</span>
                  </Button>
                </Link>
                <Link to="/personality" className="block">
                  <Button
                    variant="outline"
                    className="flex h-auto w-full flex-col items-center gap-2 border-border py-4 transition-all hover:border-primary/40 hover:bg-primary/5"
                  >
                    <Fingerprint className="h-5 w-5 text-blue-500 dark:text-blue-400" />
                    <span className="text-xs font-medium">Personality</span>
                  </Button>
                </Link>
                <Link to="/health" className="block">
                  <Button
                    variant="outline"
                    className="flex h-auto w-full flex-col items-center gap-2 border-border py-4 transition-all hover:border-primary/30 hover:bg-muted/40"
                  >
                    <HeartPulse className="h-5 w-5 text-rose-400" />
                    <span className="text-xs font-medium">Cognitive Health</span>
                  </Button>
                </Link>
                <Link to="/curiosity" className="block">
                  <Button
                    variant="outline"
                    className="flex h-auto w-full flex-col items-center gap-2 border-border py-4 transition-all hover:border-primary/40 hover:bg-primary/5"
                  >
                    <Search className="h-5 w-5 text-orange-500 dark:text-orange-400" />
                    <span className="text-xs font-medium">Curiosity Queue</span>
                  </Button>
                </Link>
                <Link to="/goals" className="block">
                  <Button
                    variant="outline"
                    className="flex h-auto w-full flex-col items-center gap-2 border-border py-4 transition-all hover:border-primary/30 hover:bg-muted/40"
                  >
                    <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden>
                      <Target className="h-5 w-5 text-green-600 dark:text-green-500" />
                      <span className="pointer-events-none absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500 ring-1 ring-background" />
                    </span>
                    <span className="text-xs font-medium">Goals</span>
                  </Button>
                </Link>
                <Link to="/live-analytics" className="block">
                  <Button
                    variant="outline"
                    className="flex h-auto w-full flex-col items-center gap-2 border-border py-4 transition-all hover:border-primary/40 hover:bg-primary/5"
                  >
                    <Radio className="h-5 w-5 text-sky-500 dark:text-sky-400" />
                    <span className="text-xs font-medium">Live Analytics</span>
                  </Button>
                </Link>
                <div className="block">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={recoveryPipelinesBusy}
                    aria-busy={recoveryPipelinesBusy}
                    aria-label="Rerun interrupted pipelines"
                    onClick={(e) => {
                      e.preventDefault();
                      void runDashboardPipelineRecovery('rerun_interrupted');
                    }}
                    title="Does not start the interactive graph — use Resume all for that. Resumes paused scheduler graph tasks, wakes due queued scheduler work, and reruns interrupted curiosity/goal pursuits."
                    className="flex h-auto w-full flex-col items-center gap-2 border-border py-4 transition-all hover:border-primary/30 hover:bg-muted/40"
                  >
                    <RefreshCw
                      className={cn(
                        'h-5 w-5 text-indigo-500 dark:text-indigo-400',
                        recoveryPipelinesBusy && 'animate-spin'
                      )}
                      aria-hidden
                    />
                    <span className="text-xs font-medium">Rerun interrupted</span>
                  </Button>
                </div>
                <div className="block">
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="Export mind backup"
                    title="Download a JSON backup of local mind data. Uses the “Include app URL prefs” option in Mind backup below."
                    onClick={() => void handleMindExport()}
                    className="flex h-auto w-full flex-col items-center gap-2 border-border py-4 transition-all hover:border-primary/40 hover:bg-primary/5"
                  >
                    <Download className="h-5 w-5 text-red-500 dark:text-red-400" aria-hidden />
                    <span className="text-xs font-medium">Export backup</span>
                  </Button>
                </div>
                <div className="block">
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="Import mind backup"
                    title="Restore from a JSON backup file (replaces local IndexedDB data after you confirm)"
                    onClick={handleMindImportPick}
                    className="flex h-auto w-full flex-col items-center gap-2 border-border py-4 transition-all hover:border-primary/30 hover:bg-muted/40"
                  >
                    <Upload className="h-5 w-5 text-teal-500 dark:text-teal-400" aria-hidden />
                    <span className="text-xs font-medium">Import backup</span>
                  </Button>
                </div>
              </div>
            </div>

            <DashboardActiveWorkSection
              onResumeAllPipelines={() => void runDashboardPipelineRecovery('resume_all')}
              resumeAllPipelinesBusy={recoveryPipelinesBusy}
            />
          </div>
        </div>

        <div className="mx-auto max-w-7xl px-4 pb-2 sm:px-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatusCard
              icon={Brain}
              label="Active model"
              value={activeModelValue}
              subtext={activeModelSub}
              valueClassName={activeModelValueClass}
              secondaryValue={healthErr ? 'Local Server' : undefined}
              secondaryValueClassName={healthErr ? 'text-green-400' : undefined}
              className={cn(inFlight && 'ring-1 ring-primary/25')}
            />
            <StatusCard
              icon={Activity}
              label="Pipeline runs"
              value={stats.runs}
              subtext="Saved graph & stream runs (local)"
            />
            <StatusCard
              icon={Database}
              label="Memory"
              value="Browser + API"
              subtext="Long-term rows & shared memory in IndexedDB; pipeline recalls LTM/world model."
            />
            <StatusCard
              icon={FlaskConical}
              label="Datasets · training"
              value={`${stats.datasets} · ${stats.trainings}`}
              subtext="RLHF / training workflow artifacts"
            />
          </div>
        </div>

        <div className="relative mx-auto mb-2 h-[min(520px,56vh)] min-h-[320px] max-w-7xl overflow-hidden rounded-2xl border border-border bg-card/50 px-4 sm:px-6">
          <NeuralNetworkViz className="min-h-0" />
          <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-[3] flex items-center justify-between">
            <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-background/85 px-3 py-1.5 backdrop-blur-sm">
              <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              <span className="font-mono text-[11px] text-muted-foreground">
                {COGNITIVE_MODULES.length} modules · six layers · dual supervisors + GWT
              </span>
            </div>
            {inFlight ? (
              <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 backdrop-blur-sm">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                <span className="text-[11px] text-primary">LLM call in flight…</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 pb-6 sm:px-6">
        <h2 className="mb-3 text-xs uppercase tracking-widest text-muted-foreground">Mind backup</h2>
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="mb-4 text-sm text-muted-foreground">
            Export or import a JSON backup of local mind data (memories, beliefs, biography, world model, pipeline
            settings, and related <code className="rounded bg-muted px-1 text-xs">mybrain_*</code> keys). The file may
            contain personal content—store it safely. Access tokens are never included in exports.
          </p>
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={includeAppPrefsInExport}
                onChange={(ev) => setIncludeAppPrefsInExport(ev.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              <span>
                Include app URL prefs (<code className="text-xs">my_brain_*</code>,{' '}
                <code className="text-xs">your_brain_user</code>) — never tokens
              </span>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="gap-2" onClick={handleMindExport}>
              <Download className="h-4 w-4" />
              Export backup
            </Button>
            <Button type="button" variant="outline" className="gap-2" onClick={handleMindImportPick}>
              <Upload className="h-4 w-4" />
              Import backup
            </Button>
            <Button
              type="button"
              variant="outline"
              className="gap-2 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={handleWipeAllLocalData}
            >
              <Trash2 className="h-4 w-4" />
              Erase all local data
            </Button>
            <input
              ref={mindBackupFileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleMindImportFile}
            />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 pb-8 sm:px-6">
        <h2 className="mb-3 text-xs uppercase tracking-widest text-muted-foreground">Latest pipeline output</h2>
        <div className="rounded-xl border border-border bg-card p-5">
          {finalVoiceDisplay ? (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Final voice
              </p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{finalVoiceDisplay}</p>
              {narrative ? (
                <div className="mt-5 border-t border-border pt-4">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Internal narrative
                  </p>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{narrative}</p>
                </div>
              ) : null}
              <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>Run id: {String(latestRun.id || '').slice(0, 12)}…</span>
                <span>·</span>
                <span>{moment(latestRun.created_date).fromNow()}</span>
                {latestRun.model_used ? (
                  <>
                    <span>·</span>
                    <span>Model: {latestRun.model_used}</span>
                  </>
                ) : null}
              </div>
            </div>
          ) : stats.runs > 0 ? (
            <div className="py-8 text-center">
              <Brain className="mx-auto mb-2 h-8 w-8 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">
                No completed Voice line to show yet — the newest saved runs are paused checkpoints. Resume or finish a run in{' '}
                <Link to="/graph-pipeline" className="font-medium text-primary underline-offset-2 hover:underline">
                  Graph Pipeline
                </Link>{' '}
                to update this card.
              </p>
            </div>
          ) : (
            <div className="py-8 text-center">
              <Brain className="mx-auto mb-2 h-8 w-8 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">
                No pipeline runs yet. Start the backend (<code className="rounded bg-muted px-1 text-xs">npm run dev</code>)
                and run the graph pipeline once.
              </p>
              <Link to="/graph-pipeline" className="mt-4 inline-block">
                <Button variant="outline" size="sm" className="gap-2">
                  <Play className="h-3.5 w-3.5" />
                  Run first pipeline
                </Button>
              </Link>
            </div>
          )}
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 pb-10 sm:px-6">
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Getting started</h3>
          <ul className="space-y-1.5 text-sm text-muted-foreground">
            <li>
              Use <strong className="text-foreground/90">Graph Pipeline</strong> (SSE transcript + optional execution graph) for
              full-stack runs.
            </li>
            <li>
              Configure <code className="rounded bg-muted/80 px-1 text-xs">LOCAL_LLM_BASE_URL</code> and{' '}
              <code className="rounded bg-muted/80 px-1 text-xs">LOCAL_LLM_MODELS</code> in <code className="text-xs">.env</code>{' '}
              (see <strong className="text-foreground/90">Settings</strong> and <code className="text-xs">.env.example</code>).
            </li>
            <li>
              After runs, open <strong className="text-foreground/90">Belief Map</strong>{' '}
              (including <span className="font-mono text-[11px]">BELIEF_REVISIONS</span> reinforcements),{' '}
              <strong className="text-foreground/90">World Model</strong>, and{' '}
              <strong className="text-foreground/90">Self & consolidation</strong> to review what persisted.
            </li>
            <li>
              Use <strong className="text-foreground/90">AI Training Lab</strong> for a separate LLM workspace: paste an
              observability snapshot of this app, chat with <code className="rounded bg-muted/80 px-1 text-xs">/api/llm</code>, and
              rely on <strong className="text-foreground/90">IndexedDB</strong> so the session survives tab switches and reloads
              (see <strong className="text-foreground/90">User Manual</strong> → Site index).
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
