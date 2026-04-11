import { useMemo, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  BookOpen,
  Brain,
  ChevronDown,
  ChevronUp,
  Clock,
  Fingerprint,
  GitBranch,
  Layers,
  Radio,
  Search,
  Target,
  Zap,
} from 'lucide-react';
import { clipTextComplete } from '../../shared/textClip.mjs';
import { cn } from '../lib/utils';
import { computeCuriosityPipelineMinimapSnapshot } from '../lib/curiosityPipelineSseUi';
import {
  getLiveActivePipelineAnalyticsSnapshot,
  subscribeLiveActivePipelineAnalytics,
} from '../lib/liveActivePipelineAnalytics';
import { computeLiveMindSnapshot } from '../lib/liveMindSnapshotDerived';
import { PipelineProgressTrack } from '../components/consciousness/PipelineProgressTrack';
import { PipelineStageMinimap } from '../components/consciousness/PipelineStageMinimap';
import ModuleOutputsCollapsibleList from '../components/pipeline/ModuleOutputsCollapsibleList';
import {
  derivePipelineExecutionStatus,
  PIPELINE_MINIMAP_STRIP_LABEL,
} from '../lib/activePipelineStatusLabels';
import PipelineExecutionLogStatusLine from '../components/pipeline/PipelineExecutionLogStatusLine';

const MODULE_CLIP = 12_000;
const LOG_TAIL = 24;

function PageShell({ icon: Icon, title, description, actions, children }) {
  return (
    <div className="min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15">
                <Icon className="h-5 w-5 text-primary" />
              </div>
              <h1 className="text-2xl font-bold">{title}</h1>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

function EmptyState({ title, description, children }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-6 text-center">
      <div className="font-medium">{title}</div>
      <div className="mt-1 text-sm text-muted-foreground">{description}</div>
      {children ? <div className="mt-4 flex flex-wrap justify-center gap-2">{children}</div> : null}
    </div>
  );
}

function LiveMetricTile({ label, value, colorClass = 'text-primary' }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className={cn('text-2xl font-bold', colorClass)}>{value}</div>
    </div>
  );
}

function VoiceFinalSection({ finalOutput, className }) {
  if (!finalOutput || !String(finalOutput).trim()) return null;
  return (
    <div className={cn('space-y-2', className)}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Voice / final</div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed">
        {clipTextComplete(String(finalOutput), MODULE_CLIP, { ellipsis: true })}
      </pre>
    </div>
  );
}

function PipelineLiveCard({ row, source }) {
  const [cardOpen, setCardOpen] = useState(false);
  const minimap = computeCuriosityPipelineMinimapSnapshot(
    source.moduleStatuses,
    Boolean(source.isProcessing) && !row.interrupted
  );
  const progressAmber = Boolean(row.interrupted);
  const log = Array.isArray(source.executionLog) ? source.executionLog.slice(-LOG_TAIL) : [];
  const isRunning = Boolean(source.isProcessing) && !row.interrupted;
  const execStatus = derivePipelineExecutionStatus({
    runError: source.runError,
    isRunning,
    executionLog: log,
  });
  const showExecutionLogSection =
    log.length > 0 || execStatus.showProcessing || Boolean(execStatus.errorText);

  return (
    <details
      className="group/pipe overflow-hidden rounded-2xl border border-border bg-card [&_summary::-webkit-details-marker]:hidden"
      open={cardOpen}
      onToggle={(e) => setCardOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer list-none p-4 marker:content-none hover:bg-muted/20">
        <div className="flex flex-wrap items-start gap-3">
          <ChevronDown
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open/pipe:rotate-180"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {row.pageName}
                  {source.kind === 'scheduler' && source.taskId ? (
                    <span className="ml-2 font-mono text-[9px] opacity-70">···{String(source.taskId).slice(-8)}</span>
                  ) : null}
                </div>
                <div className="mt-1 text-sm font-semibold text-foreground">{row.title}</div>
                {(() => {
                  const raw = String(row.detail || '');
                  const nl = raw.indexOf('\n');
                  const leadClass = cn(
                    'text-xs font-medium',
                    row.interrupted ? 'text-amber-800 dark:text-amber-300' : 'text-primary'
                  );
                  if (nl === -1) {
                    return raw.trim() ? <p className={cn('mt-1', leadClass)}>{raw}</p> : null;
                  }
                  const lead = raw.slice(0, nl).trim();
                  const tail = raw.slice(nl + 1).trim();
                  return (
                    <div className="mt-1 space-y-0.5">
                      {lead ? <p className={leadClass}>{lead}</p> : null}
                      {tail ? (
                        <p className="whitespace-pre-line text-xs leading-relaxed text-muted-foreground">{tail}</p>
                      ) : null}
                    </div>
                  );
                })()}
              </div>
              {row.interrupted ? (
                <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
                  Interrupted
                </span>
              ) : null}
            </div>
            <PipelineProgressTrack
              className="pt-0.5"
              indeterminate={Boolean(row.pipelineProgressIndeterminate)}
              progressPercent={row.pipelineProgress}
              progressAmber={progressAmber}
              moduleStatuses={source.moduleStatuses}
            />
          </div>
        </div>
      </summary>
      <PipelineStageMinimap
        snapshot={minimap}
        stripLabel={PIPELINE_MINIMAP_STRIP_LABEL}
        ariaLabel={`Pipeline stages for ${row.title}`}
      />
      <div className="space-y-2 border-t border-border/50 p-4">
        <ModuleOutputsCollapsibleList
          moduleStatuses={source.moduleStatuses}
          moduleOutputs={source.moduleOutputs}
          maxChars={MODULE_CLIP}
        />
      </div>
      {source.finalOutput ? (
        <div className="border-t border-border/50 p-4">
          <VoiceFinalSection finalOutput={source.finalOutput} />
        </div>
      ) : null}
      {source.loopCount > 0 ? (
        <div className="border-t border-border/50 px-4 py-2 text-[10px] text-muted-foreground">
          Supervisor reruns used: {source.loopCount}
        </div>
      ) : null}
      {showExecutionLogSection ? (
        <div className="border-t border-border/50 p-4">
          <PipelineExecutionLogStatusLine
            runError={source.runError}
            isRunning={isRunning}
            executionLog={log}
          />
          {log.length > 0 ? (
            <>
              <div
                className={cn(
                  'mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground',
                  execStatus.showProcessing || execStatus.errorText ? 'mt-2' : ''
                )}
              >
                Recent execution log ({log.length})
              </div>
              <ul className="max-h-48 space-y-1.5 overflow-y-auto text-[10px] text-muted-foreground">
                {log.map((e, i) => (
                  <li key={`${e.time ?? i}-${i}`} className="border-l-2 border-border/50 pl-2">
                    <span className="font-mono text-[9px] opacity-70">
                      {e.time ? new Date(e.time).toLocaleTimeString() : ''}
                    </span>{' '}
                    {e.msg}
                    {e.detail ? (
                      <pre className="mt-0.5 whitespace-pre-wrap break-words font-sans text-[9px] text-foreground/70">
                        {clipTextComplete(String(e.detail), 2000, { ellipsis: true })}
                      </pre>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

/**
 * Same chrome as Cognitive Health identity log / recent emergence: bordered card, collapsible header row, optional footer.
 * @param {'sky' | 'pink'} accent
 */
function MindSnapshotCollapsibleSection({
  accent = 'sky',
  open,
  onToggle,
  icon: Icon,
  iconClassName,
  title,
  count,
  headerRight = null,
  children,
}) {
  const border =
    accent === 'pink'
      ? 'border-pink-500/20'
      : 'border-sky-500/20';
  return (
    <div className={cn('rounded-xl border bg-card p-4', border)}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onToggle((prev) => !prev)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-1 pr-2 text-left transition-colors hover:bg-muted/40',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'
          )}
        >
          {open ? (
            <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <Icon className={cn('h-4 w-4 shrink-0', iconClassName)} aria-hidden />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
          {count != null ? (
            <span className="ml-1 text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
              ({count})
            </span>
          ) : null}
        </button>
        {headerRight}
      </div>
      {open ? <div className="mt-0">{children}</div> : null}
    </div>
  );
}

function beliefKindLabel(kind) {
  if (kind === 'reinforced') return 'Reinforced';
  if (kind === 'weakened') return 'Weakened';
  if (kind === 'removed') return 'Removed';
  if (kind === 'resolved') return 'Resolved';
  if (kind === 'epistemic_claim') return 'Claim';
  if (kind === 'status_reinforced') return 'Status: reinforced';
  if (kind === 'status_new') return 'Status: new';
  if (kind === 'status_updated') return 'Status: updated';
  return kind;
}

function stabilityAccent(tier) {
  if (tier === 'aligned') return 'border-emerald-500/30 bg-emerald-500/5';
  if (tier === 'moderate') return 'border-amber-500/30 bg-amber-500/5';
  if (tier === 'drift') return 'border-rose-500/25 bg-rose-500/5';
  if (tier === 'identity_activity') return 'border-sky-500/25 bg-sky-500/5';
  return 'border-border/60 bg-muted/10';
}

function unityColor(unity) {
  if (unity === 'unified') return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  if (unity === 'split') return 'border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300';
  return 'border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300';
}

function ConfidenceBar({ value, className }) {
  const pct = typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : null;
  if (pct == null) return null;
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border/50">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            pct >= 65 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-rose-500'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

function GlobalWorkspaceSection({ gw, open, onToggle }) {
  const hypothesisCount = gw.hypotheses?.length || 0;
  const threadCount = gw.epistemicThreads?.length || 0;
  const totalCount = gw.broadcastWinners.length + hypothesisCount + threadCount;

  return (
    <MindSnapshotCollapsibleSection
      accent="sky"
      open={open}
      onToggle={onToggle}
      icon={Layers}
      iconClassName="text-violet-400"
      title="Global Workspace (Integration)"
      count={totalCount || null}
      headerRight={
        gw.isFallback ? (
          <span className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            Fallback
          </span>
        ) : null
      }
    >
      {gw.isFallback ? (
        <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
          INTEGRATION_JSON was not parseable — the server reconstructed this workspace from upstream modules. Data may be incomplete.
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className={cn('rounded-md border px-2.5 py-1 text-[11px] font-semibold', unityColor(gw.phenomenalUnity))}>
          Unity: {gw.phenomenalUnity}
        </div>
        {gw.integrationConfidence != null ? (
          <div className="min-w-[8rem] flex-1">
            <div className="mb-0.5 text-[10px] text-muted-foreground">Confidence</div>
            <ConfidenceBar value={gw.integrationConfidence} />
          </div>
        ) : null}
        {gw.iitProxy?.causalTightness != null ? (
          <div className="min-w-[7rem]">
            <div className="mb-0.5 text-[10px] text-muted-foreground">IIT proxy</div>
            <ConfidenceBar value={gw.iitProxy.causalTightness} />
          </div>
        ) : null}
      </div>

      {gw.unityRationale && !gw.isFallback ? (
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">{gw.unityRationale}</p>
      ) : null}

      {gw.broadcastWinners.length > 0 ? (
        <div className="mb-3">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Broadcast winners
          </div>
          <div className="flex flex-wrap gap-1.5">
            {gw.broadcastWinners.map((w) => (
              <span
                key={w}
                className="rounded-md bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300"
              >
                {w}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {hypothesisCount > 0 ? (
        <div className="mb-3">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Hypotheses ({hypothesisCount})
          </div>
          <div className="space-y-2">
            {gw.hypotheses.map((h, i) => (
              <div key={h.id || i} className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3 text-xs">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-semibold text-foreground/90">{h.label}</span>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    w={typeof h.weight === 'number' ? h.weight.toFixed(2) : '?'}
                  </span>
                </div>
                <ConfidenceBar value={h.weight} className="mb-2" />
                {h.evidence_for ? (
                  <p className="text-[10px] text-muted-foreground">
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">For:</span> {h.evidence_for}
                  </p>
                ) : null}
                {h.evidence_against ? (
                  <p className="text-[10px] text-muted-foreground">
                    <span className="font-medium text-rose-600 dark:text-rose-400">Against:</span> {h.evidence_against}
                  </p>
                ) : null}
                {h.would_flip_if ? (
                  <p className="mt-1 text-[10px] italic text-muted-foreground/80">Flips if: {h.would_flip_if}</p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {gw.salience.length > 0 || gw.conflicts.length > 0 || gw.openQuestions.length > 0 ? (
        <div className="mb-3 grid gap-3 md:grid-cols-3">
          {gw.salience.length > 0 ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Salience</div>
              <ul className="space-y-1 text-[11px] text-foreground/85">
                {gw.salience.map((s, i) => (
                  <li key={i} className="border-l-2 border-sky-500/30 pl-2">{s}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {gw.conflicts.length > 0 ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Conflicts</div>
              <ul className="space-y-1 text-[11px] text-foreground/85">
                {gw.conflicts.map((c, i) => (
                  <li key={i} className="border-l-2 border-rose-500/30 pl-2">{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {gw.openQuestions.length > 0 ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Open questions</div>
              <ul className="space-y-1 text-[11px] text-foreground/85">
                {gw.openQuestions.map((q, i) => (
                  <li key={i} className="border-l-2 border-amber-500/30 pl-2">{q}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {threadCount > 0 ? (
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Epistemic threads ({threadCount})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {gw.epistemicThreads.map((t, i) => {
              const kindColor =
                t.kind === 'user'
                  ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
                  : t.kind === 'mind'
                    ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
                    : t.kind === 'shared'
                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                      : 'bg-muted text-muted-foreground';
              return (
                <span key={i} className={cn('rounded-md px-2 py-0.5 text-[10px]', kindColor)}>
                  <span className="font-medium">{t.kind}:</span> {t.thread}
                </span>
              );
            })}
          </div>
        </div>
      ) : null}

      {gw.provisionalStance ? (
        <div className="mt-3 border-t border-border/40 pt-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Provisional stance
          </div>
          <p className="text-[11px] leading-relaxed text-foreground/85">{gw.provisionalStance}</p>
        </div>
      ) : null}
    </MindSnapshotCollapsibleSection>
  );
}

function LiveMindSnapshotPanel({ rows, sources, graphLastSharedMemory }) {
  const [stabilitySectionOpen, setStabilitySectionOpen] = useState(false);
  const [gwOpen, setGwOpen] = useState(false);
  const [beliefsOpen, setBeliefsOpen] = useState(false);
  const [curiosityOpen, setCuriosityOpen] = useState(false);
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [identityLogOpen, setIdentityLogOpen] = useState(false);
  const [emergenceLiveOpen, setEmergenceLiveOpen] = useState(false);
  const derived = useMemo(
    () => computeLiveMindSnapshot(sources, graphLastSharedMemory),
    [sources, graphLastSharedMemory]
  );

  if (!derived.sourcesUsed && rows.length === 0) {
    return (
      <div id="mind-snapshot" className="scroll-mt-4">
        <div className="rounded-xl border border-sky-500/20 bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <Brain className="h-4 w-4 shrink-0 text-sky-400" aria-hidden />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Mind snapshot</h3>
          </div>
          <p className="mb-3 max-w-2xl text-[10px] text-muted-foreground">
            Structured signals (beliefs, emergence heuristics, identity deltas, curiosity, goals, stance vs prediction) parsed from
            live module outputs in this tab. Run a pipeline to populate stores; the graph’s last shared-memory snapshot is used
            for stance comparison when available.
          </p>
          <EmptyState
            title="No pipeline data yet"
            description="Nothing in the active-work list and no residual graph module outputs — start a run to feed this panel."
          >
            <ButtonLink to="/graph-pipeline" icon={GitBranch}>
              Graph Pipeline
            </ButtonLink>
            <ButtonLink to="/scheduler" icon={Clock}>
              Scheduler
            </ButtonLink>
          </EmptyState>
        </div>
      </div>
    );
  }

  return (
    <div id="mind-snapshot" className="scroll-mt-4 space-y-4">
      <div className="rounded-xl border border-sky-500/20 bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Brain className="h-4 w-4 shrink-0 text-sky-400" aria-hidden />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Mind snapshot</h3>
        </div>
        <p className="mb-2 max-w-2xl text-[10px] text-muted-foreground">
          Parsed from <strong className="text-foreground/90">active pipeline module outputs</strong> (Belief Store, Curiosity,
          Goal Generation, Identity, Narrative, Voice) plus the graph tab’s <strong className="text-foreground/90">last shared memory</strong>{' '}
          for stance alignment. Not the Cognitive Health ledger — nothing here is persisted until normal pipeline sync runs.
        </p>
        <p className="text-[11px] text-muted-foreground">
          Sources merged: <span className="font-mono text-foreground/80">{derived.sourcesUsed}</span> pipeline
          {derived.sourcesUsed === 1 ? '' : 's'}
          {rows.length === 0 ? ' (idle graph store)' : ''}.
        </p>
      </div>

      <MindSnapshotCollapsibleSection
        accent="sky"
        open={stabilitySectionOpen}
        onToggle={setStabilitySectionOpen}
        icon={Activity}
        iconClassName="text-sky-400"
        title="Stance vs prediction"
        count={null}
      >
        <div className={cn('rounded-lg border p-3 sm:p-4', stabilityAccent(derived.stability.tier))}>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Cross-turn audit or Planning vs primary turn; identity cues from modules
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground">{derived.stability.headline}</div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{derived.stability.detail}</p>
          {derived.stability.derivedPreview ? (
            <p className="mt-2 border-t border-border/40 pt-2 text-[10px] leading-relaxed text-muted-foreground">
              Narrative delta preview: {derived.stability.derivedPreview}
              {derived.stability.derivedPreview.length >= 280 ? '…' : ''}
            </p>
          ) : null}
        </div>
      </MindSnapshotCollapsibleSection>

      {derived.globalWorkspace ? (
        <GlobalWorkspaceSection gw={derived.globalWorkspace} open={gwOpen} onToggle={setGwOpen} />
      ) : null}

      <MindSnapshotCollapsibleSection
        accent="sky"
        open={identityLogOpen}
        onToggle={setIdentityLogOpen}
        icon={Fingerprint}
        iconClassName="text-sky-400"
        title="Identity log"
        count={derived.identityLogs.length}
        headerRight={
          <Link
            to="/biography"
            className="text-[11px] font-medium text-sky-400/90 hover:text-sky-300 hover:underline"
          >
            Mind Biography →
          </Link>
        }
      >
        <p className="mb-3 text-[10px] text-muted-foreground">
          Live parse from this tab’s pipeline outputs — Narrative <strong className="text-foreground/90">WHAT CHANGED</strong>,{' '}
          <strong className="text-foreground/90">SELF_MODEL_DELTA</strong> / <strong className="text-foreground/90">TRAIT_DELTA</strong>, and
          harvested keywords. For persisted biography snapshots and emergence-linked identity shifts, use Cognitive Health.
        </p>
        {derived.identityLogs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
            No identity deltas or narrative change section detected in merged outputs yet.
          </div>
        ) : (
          <div className="space-y-2">
            {derived.identityLogs.map((log, i) => (
              <div
                key={`${log.label}-${i}`}
                className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3 text-xs"
              >
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{log.label}</div>
                <pre className="whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-foreground/85">
                  {log.excerpt}
                </pre>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 text-[10px] text-muted-foreground">
          <Link to="/health" className="font-medium text-sky-300/90 hover:text-sky-200 hover:underline">
            Cognitive Health (persisted identity log) →
          </Link>
          <span className="mx-2 opacity-40">·</span>
          <span>
            Stance vs prediction (above) uses cross-turn audit or Planning JSON vs this leg’s primary turn — not Mind Biography
            rows.
          </span>
        </div>
      </MindSnapshotCollapsibleSection>

      <MindSnapshotCollapsibleSection
        accent="pink"
        open={emergenceLiveOpen}
        onToggle={setEmergenceLiveOpen}
        icon={Zap}
        iconClassName="text-pink-400"
        title="Recent emergence events"
        count={derived.emergenceMarkers.length + derived.emergenceEvidence.length}
        headerRight={
          <Link
            to="/emergence"
            className="text-[11px] font-medium text-pink-300/90 hover:text-pink-200 hover:underline"
          >
            Log →
          </Link>
        }
      >
        <p className="mb-3 text-[10px] text-muted-foreground">
          <strong className="text-foreground/90">Live heuristics</strong> on Voice, Narrative, Identity, and DMN text in this tab — same signals as
          post-pipeline emergence logging, but not the persisted Emergence Log. Pending review lives on{' '}
          <Link to="/emergence" className="font-medium text-pink-300/90 underline-offset-2 hover:underline">
            Emergence
          </Link>
          .
        </p>
        {derived.emergenceMarkers.length === 0 && derived.emergenceEvidence.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
            No heuristic markers hit in merged outputs yet.
          </div>
        ) : (
          <div className="space-y-2">
            {derived.emergenceMarkers.length > 0 ? (
              <div className="rounded-lg border border-pink-500/20 bg-pink-500/5 p-3 text-xs">
                <div className="mb-2 font-medium text-pink-300">Heuristic markers</div>
                <div className="flex flex-wrap gap-1.5">
                  {derived.emergenceMarkers.map((m) => (
                    <span
                      key={m}
                      className="rounded-md bg-pink-500/15 px-1.5 py-0.5 text-[10px] text-pink-200/90"
                    >
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {derived.emergenceEvidence.length > 0 ? (
              <div className="rounded-lg border border-pink-500/20 bg-pink-500/5 p-3 text-xs">
                <div className="mb-2 font-medium text-pink-300">Evidence by flag</div>
                <ul className="space-y-2 border-l-2 border-pink-500/25 pl-2">
                  {derived.emergenceEvidence.slice(0, 12).map((ev, i) => (
                    <li key={`${ev.marker}-${i}`} className="text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground/90">{ev.marker}</span>
                      {ev.source ? <span className="text-muted-foreground"> · {ev.source}</span> : null}
                      <pre className="mt-1 max-h-[min(40vh,22rem)] overflow-y-auto whitespace-pre-wrap break-words font-sans text-[10px] leading-relaxed text-muted-foreground/95">
                        {ev.quote}
                      </pre>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
        <div className="mt-3 text-[10px] text-muted-foreground">
          <Link to="/emergence" className="font-medium text-pink-300/90 hover:text-pink-200 hover:underline">
            Emergence Log →
          </Link>
          <span className="mx-2 opacity-40">·</span>
          <span>Full review and approve/reject on the Emergence page.</span>
        </div>
      </MindSnapshotCollapsibleSection>

      {!derived.hasAny ? (
        <p className="text-[11px] text-muted-foreground">
          No structured belief, curiosity, goal, or emergence markers detected in outputs yet — early in the run, or modules
          have not emitted machine-readable tails.
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <MindSnapshotCollapsibleSection
          accent="sky"
          open={beliefsOpen}
          onToggle={setBeliefsOpen}
          icon={BookOpen}
          iconClassName="text-sky-400"
          title="Beliefs (this leg)"
          count={derived.beliefSignals.length}
        >
          <p className="mb-3 text-[10px] text-muted-foreground">
            BELIEF_REVISIONS, EPISTEMIC_CLAIMS, and STATUS lines from Belief Store output.
          </p>
          {derived.beliefSignals.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
              No reinforcement / revision / claim lines parsed from Belief Store outputs.
            </div>
          ) : (
            <ul className="max-h-56 space-y-2 overflow-y-auto text-[11px]">
              {derived.beliefSignals.map((b, i) => (
                <li
                  key={`${b.kind}-${i}`}
                  className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2"
                >
                  <span className="font-semibold text-primary">{beliefKindLabel(b.kind)}</span>
                  {b.ref ? (
                    <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[10px] text-foreground/85">{b.ref}</pre>
                  ) : null}
                  {b.text ? (
                    <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[10px] text-foreground/85">{b.text}</pre>
                  ) : null}
                  {b.claimKind ? (
                    <span className="mt-1 block text-[9px] text-muted-foreground">Kind: {b.claimKind}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </MindSnapshotCollapsibleSection>

        <MindSnapshotCollapsibleSection
          accent="sky"
          open={curiosityOpen}
          onToggle={setCuriosityOpen}
          icon={Search}
          iconClassName="text-sky-400"
          title="Curiosity (module)"
          count={derived.curiosityItems.length}
        >
          <p className="mb-3 text-[10px] text-muted-foreground">
            MAIN_QUESTION, URGENCY, and FOLLOWUP_CURIOSITIES from Curiosity output.
          </p>
          {derived.curiosityItems.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
              No MAIN_QUESTION or follow-up JSON parsed.
            </div>
          ) : (
            <ul className="max-h-56 space-y-2 overflow-y-auto text-[11px]">
              {derived.curiosityItems.map((c, i) => (
                <li
                  key={`${c.type}-${i}`}
                  className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2"
                >
                  <span className="text-[10px] font-semibold text-primary">{c.type === 'main' ? 'Main' : 'Follow-up'}</span>
                  {c.urgency != null ? (
                    <span className="ml-2 text-[9px] text-muted-foreground">urgency {c.urgency.toFixed(2)}</span>
                  ) : null}
                  {c.priority != null ? (
                    <span className="ml-2 text-[9px] text-muted-foreground">priority {Number(c.priority).toFixed(2)}</span>
                  ) : null}
                  <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[10px] text-foreground/85">{c.text}</pre>
                </li>
              ))}
            </ul>
          )}
        </MindSnapshotCollapsibleSection>

        <div className="md:col-span-2">
          <MindSnapshotCollapsibleSection
            accent="sky"
            open={goalsOpen}
            onToggle={setGoalsOpen}
            icon={Target}
            iconClassName="text-sky-400"
            title="Goals (Goal Generation)"
            count={derived.goalItems.length}
          >
            <p className="mb-3 text-[10px] text-muted-foreground">
              Bullets under THIS_TURN / LONGER_TERM / NEW plus GOAL_URGENCY when present.
            </p>
            {derived.goalItems.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                No goal bullets parsed from Goal Generation output.
              </div>
            ) : (
              <ul className="max-h-56 space-y-2 overflow-y-auto text-[11px]">
                {derived.goalItems.map((g, i) => (
                  <li
                    key={`${g.section}-${i}`}
                    className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2"
                  >
                    <span className="text-[10px] font-semibold text-muted-foreground">{g.section.replace(/_/g, ' ')}</span>
                    {g.urgency != null ? (
                      <span className="ml-2 text-[9px] text-muted-foreground">GOAL_URGENCY {g.urgency.toFixed(2)}</span>
                    ) : null}
                    <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[10px] text-foreground/85">{g.text}</pre>
                  </li>
                ))}
              </ul>
            )}
          </MindSnapshotCollapsibleSection>
        </div>
      </div>

      <p className="text-[10px] text-muted-foreground">
        Persisted emergence review:{' '}
        <Link to="/emergence" className="font-medium text-pink-300/90 underline-offset-2 hover:underline">
          Emergence
        </Link>
        . Long-horizon health:{' '}
        <Link to="/health" className="font-medium text-sky-300/90 underline-offset-2 hover:underline">
          Cognitive Health
        </Link>
        .
      </p>
    </div>
  );
}

export default function LiveAnalyticsPage() {
  const { rows, sources, metrics, graphLastSharedMemory } = useSyncExternalStore(
    subscribeLiveActivePipelineAnalytics,
    getLiveActivePipelineAnalyticsSnapshot,
    getLiveActivePipelineAnalyticsSnapshot
  );

  return (
    <PageShell
      icon={Radio}
      title="Live Analytics"
      description="Mind snapshot parses beliefs, emergence heuristics, identity deltas, curiosity, goals, and stance vs prediction (cross-turn audit when available) from live pipeline outputs in this tab; cards below show full module traces. Persisted metrics live on Cognitive Health and Emergence."
    >
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <LiveMetricTile label="Active pipelines" value={metrics.activePipelines} colorClass="text-sky-400" />
          <LiveMetricTile label="Modules processing" value={metrics.processingModules} colorClass="text-amber-400" />
          <LiveMetricTile
            label="Non-empty module outputs"
            value={metrics.nonEmptyModuleOutputs}
            colorClass="text-emerald-400"
          />
          <LiveMetricTile
            label="Stance alignment"
            value={metrics.stanceAlignmentPercent != null ? `${metrics.stanceAlignmentPercent}%` : '—'}
            colorClass="text-violet-400"
          />
        </div>

        <LiveMindSnapshotPanel rows={rows} sources={sources} graphLastSharedMemory={graphLastSharedMemory} />

        <div className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Active pipelines</h2>
            <Link
              to="/health"
              className="text-[11px] font-medium text-primary underline-offset-2 hover:underline"
            >
              Cognitive Health (persisted metrics)
            </Link>
          </div>
          {rows.length === 0 ? (
            <EmptyState
              title="No active pipelines"
              description="Start a run from Graph Pipeline, the scheduler, or pursue a curiosity/goal to see live module output here."
            >
              <ButtonLink to="/graph-pipeline" icon={GitBranch}>
                Graph Pipeline
              </ButtonLink>
              <ButtonLink to="/scheduler" icon={Clock}>
                Scheduler
              </ButtonLink>
            </EmptyState>
          ) : (
            <div className="space-y-6">
              {rows.map((row, i) => (
                <PipelineLiveCard key={row.key} row={row} source={sources[i]} />
              ))}
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}

function ButtonLink({ to, icon: Icon, children }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-primary hover:bg-muted/40"
    >
      {Icon ? <Icon className="h-4 w-4 opacity-70" /> : null}
      {children}
    </Link>
  );
}
