import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import moment from 'moment';
import {
  Activity,
  AlertTriangle,
  BookOpen,
  Brain,
  CheckCircle,
  ChevronDown,
  Clock,
  Cpu,
  Database,
  Fingerprint,
  GitBranch,
  HeartPulse,
  Play,
  FlaskConical,
  Loader2,
  Network,
  Download,
  Eye,
  EyeOff,
  Radio,
  RefreshCw,
  ScanSearch,
  Search,
  StopCircle,
  Target,
  Upload,
  Trash2,
  Pause,
  FolderOpen,
} from 'lucide-react';
import NeuralNetworkViz from '../components/NeuralNetworkViz';
import { PipelineProgressTrack } from '../components/consciousness/PipelineProgressTrack';
import { COGNITIVE_MODULES } from '../lib/cognitiveModules';
import { PipelineRun, Dataset, TrainingRun } from '../lib/data';
import { Button, Input, toast } from '../components/ui';
import { buildMindArchiveBlob, importMindArchive, wipeAllLocalMindData } from '../lib/mindBackup';
import { shareOrDownloadBlob } from '../lib/triggerBlobDownload';
import { cn } from '../lib/utils';
import { DASHBOARD_HEADING, DASHBOARD_HEADING_PARTS, PRODUCT_NAME } from '../lib/productBranding';
import { getDashboardActiveWorkSnapshot, subscribeDashboardActiveWork } from '../lib/dashboardActiveWork';
import {
  getDashboardConnectivitySnapshot,
  subscribeDashboardConnectivity,
} from '../lib/dashboardConnectivitySnapshot';
import { abortDashboardActivePipelineRow } from '../lib/dashboardAbortActivePipeline';
import { useDashboardPauseAllSettlement } from '../lib/useDashboardPauseAllSettlement';
import { resetDashboardPauseAllUi } from '../lib/dashboardPauseAllAckStore';
import {
  loadSavedPausedPipelineStateFromDashboard,
  reloadInterruptedPipelineWorkFromDashboard,
} from '../lib/reloadInterruptedPipelineWork';
import { resumeDashboardActivePipelineRow } from '../lib/dashboardResumeActivePipeline';
import { healGraphRegistryWhenPersistSaysIdle } from '../lib/graphSessionStaleRunningHeal';
import {
  getVoiceModuleOutputTextFromPipelineRun,
  pickLatestPipelineRunWithVoiceModuleOutput,
} from '../lib/pipelineRunCheckpoint';
import { splitVoiceOutputBeliefRevisionsAppendix } from '../../shared/beliefRevisionsVoice.mjs';
import BeliefMapCanvas from '../components/beliefMap/BeliefMapCanvas';
import { BeliefStore, MirrorBeliefStore } from '../lib/data';
import { splitAggregateBeliefRowsInStore } from '../lib/mindPersistence';
import { useMindStorageRefresh } from '../lib/mindStorageEvents';
import {
  fetchMindSnapshotMeta,
  getMindSnapshotLocalHints,
  getMindSnapshotSyncToken,
  pullMindSnapshotFromServer,
  pushMindSnapshotToServer,
  serverSnapshotLooksNewerThanRecorded,
  setMindSnapshotSyncToken,
} from '../lib/mindSnapshotSync';

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

function DashboardActiveWorkSection({ onLoadSavedPipelines, loadSavedPipelinesBusy }) {
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
    loadSavedPipelinesBusy,
  });

  const [resumeRowBusy, setResumeRowBusy] = useState(false);

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
          'border-muted-foreground/35 bg-muted/45 saturate-[0.85] dark:border-muted-foreground/30 dark:bg-muted/30 dark:saturate-[0.9]',
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
            <Radio className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
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
            disabled={pauseAllBusy || loadSavedPipelinesBusy || resumeRowBusy}
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
                'border-emerald-600/80 bg-emerald-500/10 text-emerald-900 hover:bg-emerald-500/[0.18] dark:border-emerald-500/55 dark:bg-emerald-950/40 dark:text-emerald-100 dark:hover:bg-emerald-950/55',
              !isWaitingSettle &&
                !isCompleteFlash &&
                allPaused &&
                'border-emerald-600/80 bg-emerald-500/[0.2] font-semibold text-emerald-950 shadow-[0_0_18px_-2px_rgba(16,185,129,0.55)] ring-2 ring-emerald-500/35 hover:bg-emerald-500/[0.28] dark:border-emerald-400/75 dark:bg-emerald-950/45 dark:text-emerald-50 dark:shadow-[0_0_22px_-2px_rgba(52,211,153,0.5)] dark:ring-emerald-400/30 dark:hover:bg-emerald-950/55'
            )}
            disabled={pauseAllBusy || loadSavedPipelinesBusy || resumeRowBusy}
            title={resumeButtonTitle}
            onClick={() => {
              if (typeof onLoadSavedPipelines === 'function') onLoadSavedPipelines();
            }}
          >
            <FolderOpen className="h-3 w-3 shrink-0" aria-hidden />
            Load saved
          </Button>
          <span className="text-[10px] text-muted-foreground">
            Pause: cooperative (finishes the current module), notifies all open tabs, and holds new scheduled work until you
            resume. Load saved: merges pursuit state from storage and refreshes this list so paused pipelines appear. Use
            Resume on each card to continue from the last saved checkpoint. Rerun interrupted (overview below): pursuits only
            — no interactive graph or scheduler flush.
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
              Use Load saved to surface paused work from storage, then Resume on each card to continue from checkpoints.
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
            const systemAccent = row.playgroundSystemAccent;
            const RowIcon = activeWorkRowIcon(row.variant);
            const progressAmber = isAttentionRow;
            const showStop = row.variant !== 'global';
            const baseStopLabel =
              row.key === 'graph-pipeline-interrupted'
                ? 'Clear'
                : row.key === 'graph-pipeline-checkpoint'
                  ? 'Discard'
                  : 'Stop';
            const isSettlementPausedLabel =
              !isAttentionRow && !isPausedRow && pauseAllSucceededAck && baseStopLabel === 'Stop';
            const showPausedInstead = isPausedRow || isSettlementPausedLabel;
            const stopLabel = showPausedInstead ? 'Paused' : baseStopLabel;
            const showResumeForPausedCheckpoint = isPausedRow && showStop && !isAttentionRow;

            return (
              <li
                key={row.key}
                className={cn(
                  'flex min-h-0 overflow-hidden rounded-lg border',
                  isAttentionRow
                    ? 'border-amber-500/45 dark:border-amber-400/35'
                    : isPausedRow
                      ? systemAccent === 'b'
                        ? 'border-muted-foreground/25 shadow-[inset_4px_0_0_0_rgba(239,68,68,0.45)] dark:border-muted-foreground/20'
                        : systemAccent === 'a'
                          ? 'border-muted-foreground/25 shadow-[inset_4px_0_0_0_rgba(59,130,246,0.45)] dark:border-muted-foreground/20'
                          : 'border-muted-foreground/25 dark:border-muted-foreground/20'
                      : systemAccent === 'a'
                        ? 'border-blue-500/40 shadow-[inset_4px_0_0_0_rgba(59,130,246,0.55)]'
                        : systemAccent === 'b'
                          ? 'border-red-500/40 shadow-[inset_4px_0_0_0_rgba(239,68,68,0.5)]'
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
                  {showStop && showResumeForPausedCheckpoint ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pauseAllBusy || loadSavedPipelinesBusy || resumeRowBusy}
                      title="Resume this pipeline from the last saved checkpoint (clears the scheduled-work hold)."
                      className="h-auto min-h-0 w-full flex-col gap-0.5 rounded-none border-0 border-t border-border px-2 py-1 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-500/10 hover:text-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950/35 dark:hover:text-emerald-300"
                      aria-label={`Resume saved checkpoint: ${row.pageName}`}
                      onClick={async () => {
                        if (resumeRowBusy) return;
                        setResumeRowBusy(true);
                        try {
                          const r = await resumeDashboardActivePipelineRow(row);
                          toast({
                            title: r.ok ? 'Resuming' : 'Cannot resume',
                            description: r.message || '',
                            variant: r.ok ? undefined : 'destructive',
                          });
                        } finally {
                          setResumeRowBusy(false);
                        }
                      }}
                    >
                      <Play className="h-3 w-3 shrink-0" aria-hidden />
                      Resume
                    </Button>
                  ) : showStop ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      title={
                        showPausedInstead
                          ? isSettlementPausedLabel
                            ? 'Cooperative pause requested — click to force-stop and clear this entry.'
                            : 'Pipeline paused — open the destination to discard the checkpoint if needed.'
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
                          ? `Paused — click to ${isSettlementPausedLabel ? 'force-stop' : 'discard or stop'} ${row.pageName}`
                          : `${stopLabel}: ${row.pageName}`
                      }
                      onClick={async () => {
                        const r = await abortDashboardActivePipelineRow(row);
                        if (showPausedInstead && isSettlementPausedLabel && r.ok) {
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
  const [loadSavedPipelinesBusy, setLoadSavedPipelinesBusy] = useState(false);
  const [dashboardOverviewOpen, setDashboardOverviewOpen] = useState(false);
  const [dashboardMindViz, setDashboardMindViz] = useState(() => {
    if (typeof window === 'undefined') return 'modules';
    try {
      return window.localStorage.getItem('dashboardMindViz') === 'beliefs' ? 'beliefs' : 'modules';
    } catch {
      return 'modules';
    }
  });
  const [dashboardBeliefs, setDashboardBeliefs] = useState([]);
  /** Which mind’s beliefs feed the dashboard map (Belief Map page uses /beliefs vs /beliefs/mirror). */
  const [dashboardBeliefScope, setDashboardBeliefScope] = useState(() => {
    if (typeof window === 'undefined') return 'primary';
    try {
      return window.localStorage.getItem('dashboardBeliefScope') === 'mirror' ? 'mirror' : 'primary';
    } catch {
      return 'primary';
    }
  });
  const mindBackupFileRef = useRef(null);
  const recoveryPipelinesInFlightRef = useRef(false);
  const loadSavedPipelinesInFlightRef = useRef(false);
  const [snapshotTokenInput, setSnapshotTokenInput] = useState(() =>
    typeof window !== 'undefined' ? getMindSnapshotSyncToken() : ''
  );
  const [snapshotMeta, setSnapshotMeta] = useState(null);
  const [snapshotMetaErr, setSnapshotMetaErr] = useState(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  /** Pull/Push in progress: human-readable line (Pull phases: download → decode → parse → save). */
  const [snapshotPullProgress, setSnapshotPullProgress] = useState(null);
  const [snapshotMetaLoading, setSnapshotMetaLoading] = useState(false);
  const [snapshotTokenVisible, setSnapshotTokenVisible] = useState(false);

  const refreshSnapshotMeta = useCallback(async () => {
    const t = getMindSnapshotSyncToken().trim();
    if (!t) {
      setSnapshotMeta(null);
      setSnapshotMetaErr(null);
      return;
    }
    setSnapshotMetaLoading(true);
    try {
      setSnapshotMetaErr(null);
      const m = await fetchMindSnapshotMeta();
      setSnapshotMeta(m);
    } catch (e) {
      setSnapshotMeta(null);
      setSnapshotMetaErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSnapshotMetaLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSnapshotMeta();
  }, [refreshSnapshotMeta]);

  const loadDashboardBeliefs = useCallback(async () => {
    try {
      const store = dashboardBeliefScope === 'mirror' ? MirrorBeliefStore : BeliefStore;
      await splitAggregateBeliefRowsInStore(400, store, { deleteUnparsedModuleBlobs: false });
      setDashboardBeliefs(await store.listAll('-created_date'));
    } catch {
      /* IndexedDB unavailable or migration */
    }
  }, [dashboardBeliefScope]);

  useEffect(() => {
    void loadDashboardBeliefs();
  }, [loadDashboardBeliefs]);

  useMindStorageRefresh(loadDashboardBeliefs);

  const runLoadSavedPausedPipelines = useCallback(async () => {
    if (loadSavedPipelinesInFlightRef.current) return;
    loadSavedPipelinesInFlightRef.current = true;
    setLoadSavedPipelinesBusy(true);
    toast({
      title: 'Load saved',
      description: 'Merging saved pursuit state from storage and refreshing the active pipeline list.',
    });
    try {
      const r = await loadSavedPausedPipelineStateFromDashboard();
      const bits = [];
      if (r.curiosityMerged > 0) {
        bits.push(`${r.curiosityMerged} curiosity slot(s) merged from storage`);
      }
      if (r.goalMerged > 0) {
        bits.push(`${r.goalMerged} goal slot(s) merged from storage`);
      }
      toast({
        title: 'Load saved',
        description:
          bits.join(' · ') ||
          'No new pursuit slots were merged from storage. Paused pipelines already in memory, or nothing saved yet.',
      });
    } catch (e) {
      toast({
        title: 'Load saved failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      loadSavedPipelinesInFlightRef.current = false;
      setLoadSavedPipelinesBusy(false);
    }
  }, []);

  const runDashboardPipelineRecovery = useCallback(async () => {
    if (recoveryPipelinesInFlightRef.current) return;
    recoveryPipelinesInFlightRef.current = true;
    setRecoveryPipelinesBusy(true);
    toast({
      title: 'Rerun interrupted',
      description:
        'Curiosity/goal pursuits only: continues from saved module checkpoints when possible (not from Perception). No interactive graph, no scheduler paused jobs, no due-queue flush — use Load saved and Resume on each card for those.',
    });
    try {
      const r = await reloadInterruptedPipelineWorkFromDashboard({
        mode: 'rerun_interrupted',
      });
      const bits = [];
      if (r.curiosityMerged > 0) {
        bits.push(`${r.curiosityMerged} curiosity slot(s) merged from storage`);
      }
      if (r.goalMerged > 0) {
        bits.push(`${r.goalMerged} goal slot(s) merged from storage`);
      }
      const { graphStarted, graphReason } = r.graph;
      if (graphStarted && graphReason === 'started_from_checkpoint_multi') {
        const n = Number(r.graph?.cooperativeCheckpointLegs ?? 0);
        bits.push(
          n > 1
            ? `Graph: resumed ${n} saved cooperative checkpoints (interactive sessions, one after another)`
            : 'Graph: resumed from cooperative checkpoint'
        );
      } else if (graphStarted && graphReason === 'started_from_checkpoint') {
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
        bits.push('Graph: skipped — use Load saved + Resume on the graph row for interactive checkpoint');
      } else if (String(graphReason || '').startsWith('error:')) {
        bits.push(`Graph error: ${String(graphReason).replace(/^error:/, '').trim()}`);
      }
      const otherCk = Number(r.graph?.otherGraphCheckpointSessions ?? 0);
      if (otherCk > 0) {
        bits.push(
          `Graph: ${otherCk} other saved session(s) — use Resume on each saved graph row when ready`
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
        title: 'Rerun interrupted pipelines',
        description:
          bits.join(' · ') ||
          'Nothing to rerun was found (interrupted curiosity/goal pursuits). Use Load saved + Resume for graph and scheduler.',
      });
    } catch (e) {
      toast({
        title: 'Rerun interrupted pipelines failed',
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
      const result = await buildMindArchiveBlob({ includeAppPrefs: includeAppPrefsInExport });
      if (result.kind === 'file') {
        toast({ title: 'Backup saved', description: result.filename });
        return;
      }
      const mode = await shareOrDownloadBlob(result.blob, result.filename);
      if (mode === 'cancelled') return;
      toast({
        title: mode === 'shared' ? 'Backup shared' : 'Backup downloaded',
        description:
          mode === 'shared' ? 'Choose Save to Files or another app in the share sheet.' : result.filename,
      });
    } catch (e) {
      if (e && typeof e === 'object' && e.name === 'AbortError') {
        return;
      }
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
        const buf = reader.result;
        if (!buf || !(buf instanceof ArrayBuffer)) {
          toast({ title: 'Import failed', description: 'Could not read file.', variant: 'destructive' });
          return;
        }
        const result = await importMindArchive(buf);
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
    reader.readAsArrayBuffer(file);
  }, []);

  const handleWipeAllLocalData = useCallback(() => {
    const ok = window.confirm(
      `Erase ALL locally stored ${PRODUCT_NAME} data in this browser? This removes IndexedDB (KV + entities), Origin Private File System staging under mybrain/opfs, and any legacy localStorage keys (mybrain_*, yourbrain_*, my_brain_*, your_brain_*). This cannot be undone. Continue?`
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

  const handleSnapshotSaveToken = useCallback(() => {
    setMindSnapshotSyncToken(snapshotTokenInput);
    toast({ title: 'Token saved', description: 'Stored in this browser for snapshot API calls.' });
    void refreshSnapshotMeta();
  }, [snapshotTokenInput, refreshSnapshotMeta]);

  const handleSnapshotPush = useCallback(async () => {
    const t = getMindSnapshotSyncToken().trim();
    if (!t) {
      toast({ title: 'Token required', description: 'Enter the same token as MIND_SNAPSHOT_SYNC_TOKEN on the PC.', variant: 'destructive' });
      return;
    }
    const ok = window.confirm(
      'Overwrite the server snapshot with this browser’s current mind data? (Other devices can pull it.)'
    );
    if (!ok) return;
    setSnapshotBusy(true);
    try {
      const r = await pushMindSnapshotToServer();
      if (!r.ok) {
        toast({ title: 'Push failed', description: r.error, variant: 'destructive' });
        return;
      }
      toast({
        title: 'Snapshot pushed',
        description: r.updatedAt ? `Server updated ${r.updatedAt}` : 'Server updated.',
      });
      await refreshSnapshotMeta();
    } finally {
      setSnapshotBusy(false);
    }
  }, [refreshSnapshotMeta]);

  const handleSnapshotPull = useCallback(async () => {
    const t = getMindSnapshotSyncToken().trim();
    if (!t) {
      toast({ title: 'Token required', description: 'Enter the same token as MIND_SNAPSHOT_SYNC_TOKEN on the PC.', variant: 'destructive' });
      return;
    }
    const confirmPull = window.confirm(
      'Replace IndexedDB mind data in this browser with the server snapshot? This is the same as importing a backup file.'
    );
    if (!confirmPull) return;
    setSnapshotBusy(true);
    setSnapshotPullProgress('Connecting…');
    const sizeHint = snapshotMeta?.sizeBytes != null ? Number(snapshotMeta.sizeBytes) : null;
    try {
      const r = await pullMindSnapshotFromServer({
        onProgress: (phase, detail) => {
          if (phase === 'downloading') {
            const total = detail?.totalBytes;
            const bytes = detail?.bytes ?? 0;
            if (typeof total === 'number' && total > 0) {
              const pct = Math.min(100, Math.round((bytes / total) * 100));
              const mbTotal = (total / (1024 * 1024)).toFixed(1);
              const mbGot = (bytes / (1024 * 1024)).toFixed(1);
              setSnapshotPullProgress(`Downloading ${pct}% (${mbGot} / ${mbTotal} MB)…`);
            } else {
              const hint =
                typeof sizeHint === 'number' && sizeHint > 0
                  ? ` (~${Math.max(1, Math.round(sizeHint / (1024 * 1024)))} MB)`
                  : '';
              setSnapshotPullProgress(`Downloading snapshot${hint}…`);
            }
            return;
          }
          if (phase === 'decoding') {
            setSnapshotPullProgress('Decompressing / reading backup…');
            return;
          }
          if (phase === 'parsing') {
            const n = detail?.lines;
            setSnapshotPullProgress(
              typeof n === 'number' && n > 0
                ? `Parsing backup (${n.toLocaleString()} lines processed)…`
                : 'Parsing backup…'
            );
            return;
          }
          if (phase === 'saving') {
            setSnapshotPullProgress('Saving to this device…');
          }
        },
      });
      if (!r.ok) {
        toast({ title: 'Pull failed', description: r.error, variant: 'destructive' });
        return;
      }
      toast({
        title: 'Mind restored from server',
        description: `${r.keyCount} item(s) imported. Reloading…`,
      });
      window.setTimeout(() => window.location.reload(), 400);
    } finally {
      setSnapshotBusy(false);
      setSnapshotPullProgress(null);
    }
  }, [snapshotMeta]);

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
      const LATEST_RUN_SCAN = 200;
      const [runCount, datasetCount, trainingCount, runsForLatest] = await Promise.all([
        PipelineRun.count(),
        Dataset.count(),
        TrainingRun.count(),
        PipelineRun.list('-created_date', LATEST_RUN_SCAN),
      ]);
      setLatestRun(pickLatestPipelineRunWithVoiceModuleOutput(runsForLatest) || null);
      setStats({
        runs: runCount,
        datasets: datasetCount,
        trainings: trainingCount,
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
    healGraphRegistryWhenPersistSaysIdle();
    refreshAll();
    const id = setInterval(refreshAll, 10_000);
    const onVis = () => {
      // Avoid heavy IndexedDB reads (PipelineRun.list, counts) on every tab return — background
      // tabs already run refreshAll on the 10s timer; visibility here only re-pings the API.
      if (document.visibilityState === 'visible') void loadHealth();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [loadHealth, refreshAll]);

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
    <div className="flex w-full min-h-0 flex-1 flex-col bg-background">
      {/*
        shrink-0: in a height-constrained flex column (AppLayout main), overflow-hidden lets this flex item’s
        automatic min-height go to 0 — keep the hero + latest output + mind viz in this wrapper; backup/sync sit below.
      */}
      <div className="relative shrink-0 overflow-hidden">
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
            <h1 className="text-3xl font-bold tracking-tight" aria-label={DASHBOARD_HEADING}>
              {DASHBOARD_HEADING_PARTS.map((part) => (
                <span key={part.text} className={part.className}>
                  {part.text}
                </span>
              ))}
            </h1>
            <div className="mt-1 max-w-2xl">
              <button
                type="button"
                id="dashboard-overview-toggle"
                aria-expanded={dashboardOverviewOpen}
                aria-controls="dashboard-overview-panel"
                onClick={() => setDashboardOverviewOpen((o) => !o)}
                className="flex w-full max-w-full items-start gap-2 rounded-md py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground sm:items-center"
              >
                <ChevronDown
                  className={cn(
                    'mt-0.5 h-4 w-4 shrink-0 transition-transform duration-200 sm:mt-0',
                    dashboardOverviewOpen && 'rotate-180'
                  )}
                  aria-hidden
                />
                <span>
                  {dashboardOverviewOpen
                    ? 'Hide overview'
                    : 'Overview — six-layer pipeline, beliefs & memory, local LLMs, data in the browser'}
                </span>
              </button>
              {dashboardOverviewOpen ? (
                <div
                  id="dashboard-overview-panel"
                  role="region"
                  aria-labelledby="dashboard-overview-toggle"
                  className="mt-2 text-sm text-muted-foreground"
                >
                  <p>
                    <span className="text-foreground/80">Six-layer</span> graph pipeline ({' '}
                    <span className="text-foreground/80">{COGNITIVE_MODULES.length} modules</span>
                    ), beliefs, memory, and world model with probabilistic integrations (adaptive temperature, embedding
                    similarity, soft metacognition thresholds, stochastic cognitive policy, calibrated decision thresholds).
                    Supervisors can rerun early layers; Integration emits{' '}
                    <span className="font-mono text-[11px] text-foreground/75">INTEGRATION_JSON</span> before Language →
                    Narrative → Voice. LLMs hit your local Express API:{' '}
                    <span className="text-foreground/80">LM Studio</span> first, then OpenRouter, then{' '}
                    <span className="text-foreground/80">Hugging Face</span> (keys in Settings or{' '}
                    <code className="rounded bg-muted/80 px-1 text-[11px]">.env</code>). Mind data stays in the browser.
                  </p>
                </div>
              ) : null}
            </div>

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
                <Link to="/scheduler" className="block">
                  <Button
                    variant="outline"
                    className="flex h-auto w-full flex-col items-center gap-2 border-border py-4 transition-all hover:border-primary/40 hover:bg-primary/5"
                  >
                    <Clock className="h-5 w-5 text-violet-500 dark:text-violet-400" />
                    <span className="text-xs font-medium">Scheduler</span>
                  </Button>
                </Link>
                <Link to="/beliefs" className="block">
                  <Button
                    variant="outline"
                    className="flex h-auto w-full flex-col items-center gap-2 border-border py-4 transition-all hover:border-primary/30 hover:bg-muted/40"
                  >
                    <Network className="h-5 w-5 text-fuchsia-500 dark:text-fuchsia-400" />
                    <span className="text-xs font-medium">Belief map</span>
                  </Button>
                </Link>
                <div className="block">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={snapshotBusy}
                    aria-busy={snapshotBusy}
                    aria-label="Push mind snapshot to server"
                    title="Upload this browser's mind data to the Express host (requires sync token in Snapshot sync below)."
                    onClick={() => void handleSnapshotPush()}
                    className="flex h-auto w-full flex-col items-center gap-2 border-border py-4 transition-all hover:border-primary/40 hover:bg-primary/5"
                  >
                    {snapshotBusy ? (
                      <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden />
                    ) : (
                      <Upload className="h-5 w-5 text-emerald-500 dark:text-emerald-400" aria-hidden />
                    )}
                    <span className="text-xs font-medium">Push to server</span>
                  </Button>
                </div>
                <div className="block">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={recoveryPipelinesBusy}
                    aria-busy={recoveryPipelinesBusy}
                    aria-label="Rerun interrupted pipelines"
                    onClick={(e) => {
                      e.preventDefault();
                      void runDashboardPipelineRecovery();
                    }}
                    title="Pursuits only: continues from the last saved pipeline checkpoint when available. Does not start the interactive graph, resume paused scheduler tasks, or flush the due queue — use Load saved and Resume on each card for those."
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
                    disabled={snapshotBusy}
                    aria-busy={snapshotBusy}
                    aria-label="Pull mind snapshot from server"
                    title="Replace this browser's mind data with the server copy (requires sync token; confirms before import)."
                    onClick={() => void handleSnapshotPull()}
                    className="flex h-auto w-full flex-col items-center gap-2 border-border py-4 transition-all hover:border-primary/30 hover:bg-muted/40"
                  >
                    {snapshotBusy ? (
                      <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden />
                    ) : (
                      <Download className="h-5 w-5 text-violet-500 dark:text-violet-400" aria-hidden />
                    )}
                    <span className="text-xs font-medium">Pull from server</span>
                  </Button>
                </div>
              </div>
            </div>

            <DashboardActiveWorkSection
              onLoadSavedPipelines={() => void runLoadSavedPausedPipelines()}
              loadSavedPipelinesBusy={loadSavedPipelinesBusy}
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

        <div className="mx-auto w-full max-w-7xl shrink-0 px-4 pb-4 sm:px-6">
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

        <div className="relative mx-auto mb-2 flex h-[min(520px,56svh)] min-h-[min(280px,50svh)] max-w-7xl flex-col overflow-hidden rounded-2xl border border-border bg-card lg:bg-card/50 px-4 sm:px-6">
          <div className="relative min-h-0 flex-1 py-2">
            {dashboardMindViz === 'modules' ? (
              <NeuralNetworkViz className="h-full min-h-0" />
            ) : (
              <BeliefMapCanvas
                variant="dashboard"
                beliefs={dashboardBeliefs}
                filterStatus="all"
                expandedId={null}
                onExpandedIdChange={() => {}}
                className="h-full min-h-0 rounded-xl border border-border bg-card"
                mapWrapClassName="min-h-0 flex-1 !max-lg:max-h-none"
              />
            )}
          </div>
          <div className="pointer-events-none relative z-[3] flex flex-wrap items-center justify-between gap-2 pb-3 pt-1">
            <div className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 rounded-lg border border-border bg-background/85 p-0.5 backdrop-blur-sm">
                <Button
                  type="button"
                  variant={dashboardMindViz === 'modules' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 gap-1 px-2 text-[10px]"
                  onClick={() => {
                    setDashboardMindViz('modules');
                    try {
                      window.localStorage.setItem('dashboardMindViz', 'modules');
                    } catch {
                      /* ignore */
                    }
                  }}
                >
                  <Cpu className="h-3 w-3 shrink-0" aria-hidden />
                  Modules
                </Button>
                <Button
                  type="button"
                  variant={dashboardMindViz === 'beliefs' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 gap-1 px-2 text-[10px]"
                  onClick={() => {
                    setDashboardMindViz('beliefs');
                    try {
                      window.localStorage.setItem('dashboardMindViz', 'beliefs');
                    } catch {
                      /* ignore */
                    }
                    void loadDashboardBeliefs();
                  }}
                >
                  <Network className="h-3 w-3 shrink-0" aria-hidden />
                  Beliefs map
                </Button>
              </div>
              {dashboardMindViz === 'beliefs' ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <div className="flex items-center gap-0.5 rounded-lg border border-border bg-background/85 p-0.5 backdrop-blur-sm">
                    <Button
                      type="button"
                      variant={dashboardBeliefScope === 'primary' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-7 gap-1 px-2 text-[10px]"
                      title="Primary mind belief store"
                      onClick={() => {
                        setDashboardBeliefScope('primary');
                        try {
                          window.localStorage.setItem('dashboardBeliefScope', 'primary');
                        } catch {
                          /* ignore */
                        }
                      }}
                    >
                      System A
                    </Button>
                    <Button
                      type="button"
                      variant={dashboardBeliefScope === 'mirror' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-7 gap-1 px-2 text-[10px]"
                      title="Playground mirror (System B) belief store"
                      onClick={() => {
                        setDashboardBeliefScope('mirror');
                        try {
                          window.localStorage.setItem('dashboardBeliefScope', 'mirror');
                        } catch {
                          /* ignore */
                        }
                      }}
                    >
                      System B
                    </Button>
                  </div>
                  <Link
                    to={dashboardBeliefScope === 'mirror' ? '/beliefs/mirror' : '/beliefs'}
                    className="text-[10px] font-medium text-primary underline-offset-2 hover:underline"
                  >
                    Open full Belief Map
                  </Link>
                </div>
              ) : null}
            </div>
            <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-2">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-background/85 px-3 py-1.5 backdrop-blur-sm">
                <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                <span className="font-mono text-[11px] text-muted-foreground">
                  {dashboardMindViz === 'modules' ? (
                    <>
                      {COGNITIVE_MODULES.length} modules · six layers · dual supervisors + GWT
                    </>
                  ) : (
                    <>
                      {dashboardBeliefs.length} beliefs ·{' '}
                      {dashboardBeliefScope === 'mirror' ? 'System B mirror · ' : 'Primary · '}
                      grid / radial (toolbar)
                    </>
                  )}
                </span>
              </div>
              {inFlight ? (
                <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 backdrop-blur-sm">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                  <span className="text-[11px] text-primary">LLM call in flight…</span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-7xl shrink-0 px-4 pb-6 sm:px-6">
        <h2 className="mb-3 text-xs uppercase tracking-widest text-muted-foreground">Snapshot sync (server)</h2>
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="mb-4 text-sm text-muted-foreground">
            Share one mind backup between this browser and another device (e.g. phone) via the Express host. Set{' '}
            <code className="rounded bg-muted px-1 text-xs">MIND_SNAPSHOT_SYNC_TOKEN</code> in the PC&apos;s{' '}
            <code className="rounded bg-muted px-1 text-xs">.env</code> and restart the backend. Same token here;
            then Push overwrites the server copy, Pull replaces this browser&apos;s data with the server copy. With a
            saved token, this browser also <span className="font-medium text-foreground/90">auto-pushes every 10 minutes</span>{' '}
            while the tab stays open.
          </p>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Sync token (Bearer)</label>
              <div className="flex gap-2">
                <Input
                  type={snapshotTokenVisible ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={snapshotTokenInput}
                  onChange={(e) => setSnapshotTokenInput(e.target.value)}
                  placeholder="Paste token from .env"
                  className="min-w-0 flex-1 font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5"
                  aria-pressed={snapshotTokenVisible}
                  aria-label={snapshotTokenVisible ? 'Hide token' : 'Show token'}
                  onClick={() => setSnapshotTokenVisible((v) => !v)}
                >
                  {snapshotTokenVisible ? (
                    <EyeOff className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <Eye className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {snapshotTokenVisible ? 'Hide' : 'Show'}
                </Button>
              </div>
            </div>
            <Button type="button" variant="secondary" className="shrink-0" onClick={handleSnapshotSaveToken}>
              Save token
            </Button>
            <Button
              type="button"
              variant="outline"
              className="shrink-0 gap-1"
              disabled={snapshotBusy || snapshotMetaLoading}
              onClick={() => void refreshSnapshotMeta()}
            >
              {snapshotMetaLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh status
            </Button>
          </div>
          <div className="mb-4 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {snapshotMetaErr ? (
              <span className="text-destructive">{snapshotMetaErr}</span>
            ) : snapshotMeta && snapshotMeta.exists ? (
              <span>
                Server snapshot: {snapshotMeta.sizeBytes != null ? `${Number(snapshotMeta.sizeBytes).toLocaleString()} bytes` : '—'}
                {snapshotMeta.updatedAt ? ` · updated ${snapshotMeta.updatedAt}` : ''}
                {serverSnapshotLooksNewerThanRecorded(snapshotMeta) ? (
                  <span className="ml-1 font-medium text-amber-600 dark:text-amber-400">
                    — newer than last pull/push on this device; consider Pull.
                  </span>
                ) : null}
              </span>
            ) : getMindSnapshotSyncToken().trim() ? (
              <span>No snapshot on server yet — Push from a device with data.</span>
            ) : (
              <span>Enter and save a token to see server status.</span>
            )}
            {(() => {
              const h = getMindSnapshotLocalHints();
              if (!h.lastRemoteUpdatedAt && !h.lastPushedAt) return null;
              return (
                <div className="mt-1 text-[11px] opacity-90">
                  {h.lastPushedAt ? `Last push recorded (this browser): ${h.lastPushedAt}` : null}
                  {h.lastPushedAt && h.lastRemoteUpdatedAt ? ' · ' : null}
                  {h.lastRemoteUpdatedAt ? `Last recorded remote: ${h.lastRemoteUpdatedAt}` : null}
                </div>
              );
            })()}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="gap-2" disabled={snapshotBusy} onClick={() => void handleSnapshotPush()}>
              {snapshotBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Push to server
            </Button>
            <Button type="button" variant="outline" className="gap-2" disabled={snapshotBusy} onClick={() => void handleSnapshotPull()}>
              {snapshotBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Pull from server
            </Button>
          </div>
          {snapshotBusy && snapshotPullProgress ? (
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground" role="status" aria-live="polite">
              {snapshotPullProgress}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mx-auto w-full max-w-7xl shrink-0 px-4 pb-6 sm:px-6">
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
              accept="application/json,.json,.json.gz,application/gzip"
              className="hidden"
              onChange={handleMindImportFile}
            />
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-7xl shrink-0 px-4 pb-10 sm:px-6">
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
