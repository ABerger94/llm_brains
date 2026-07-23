import { Fragment, useMemo, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  BookOpen,
  Brain,
  ChevronDown,
  ChevronUp,
  Clock,
  Fingerprint,
  GitBranch,
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
import MindSnapshotCollapsibleSection from '../components/pipeline/MindSnapshotCollapsibleSection';
import { GlobalWorkspaceSection } from '../components/workspace/GlobalWorkspacePanel';
import PageShell from '../components/PageShell';

const MODULE_CLIP = 12_000;
const LOG_TAIL = 24;

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

/** @param {{ m: { activePipelines: number, processingModules: number, nonEmptyModuleOutputs: number, stanceAlignmentPercent: number|null }, accent: 'a'|'b' }} props */
function LiveMetricsFourTiles({ m, accent }) {
  const stance =
    m.stanceAlignmentPercent != null ? `${m.stanceAlignmentPercent}%` : '—';
  const ring =
    accent === 'a'
      ? 'border-blue-500/25 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.12)]'
      : 'border-red-500/25 shadow-[inset_0_0_0_1px_rgba(239,68,68,0.12)]';
  return (
    <div className={cn('grid grid-cols-2 gap-4 rounded-xl border bg-card/80 p-3 md:grid-cols-4', ring)}>
      <LiveMetricTile label="Active pipelines" value={m.activePipelines} colorClass="text-sky-400" />
      <LiveMetricTile label="Modules processing" value={m.processingModules} colorClass="text-amber-400" />
      <LiveMetricTile
        label="Non-empty module outputs"
        value={m.nonEmptyModuleOutputs}
        colorClass="text-emerald-400"
      />
      <LiveMetricTile label="Stance alignment" value={stance} colorClass="text-violet-400" />
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
      className={cn(
        'group/pipe overflow-hidden rounded-2xl border bg-card [&_summary::-webkit-details-marker]:hidden',
        row.playgroundSystemAccent === 'a' && 'border-blue-500/40 shadow-[inset_4px_0_0_0_rgba(59,130,246,0.55)]',
        row.playgroundSystemAccent === 'b' && 'border-red-500/40 shadow-[inset_4px_0_0_0_rgba(239,68,68,0.5)]',
        !row.playgroundSystemAccent && 'border-border'
      )}
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
                  {row.playgroundSystemAccent === 'a' ? (
                    <span className="ml-2 rounded border border-blue-500/35 bg-blue-500/10 px-1.5 py-0 text-[9px] font-semibold text-blue-700 dark:text-blue-300">
                      Primary
                    </span>
                  ) : null}
                  {row.playgroundSystemAccent === 'b' ? (
                    <span className="ml-2 rounded border border-red-500/35 bg-red-500/10 px-1.5 py-0 text-[9px] font-semibold text-red-700 dark:text-red-300">
                      Mirror
                    </span>
                  ) : null}
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
  if (tier === 'partial') return 'border-violet-500/25 bg-violet-500/5';
  return 'border-border/60 bg-muted/10';
}

/**
 * Recent emergence heuristics from one {@link computeLiveMindSnapshot} result.
 * @param {{ derived: ReturnType<typeof computeLiveMindSnapshot>, open: boolean, onToggle: (fn: (v: boolean) => boolean) => void }} props
 */
function EmergenceEventsSnapshotSection({ derived, open, onToggle }) {
  return (
    <MindSnapshotCollapsibleSection
      accent="pink"
      open={open}
      onToggle={onToggle}
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
        <strong className="text-foreground/90">Live heuristics</strong> on Voice, Narrative, Identity, and DMN text for this
        scope — same signals as post-pipeline emergence logging, but not the persisted Emergence Log. Pending review lives on{' '}
        <Link to="/emergence" className="font-medium text-pink-300/90 underline-offset-2 hover:underline">
          Emergence
        </Link>
        .
      </p>
      {derived.emergenceMarkers.length === 0 && derived.emergenceEvidence.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
          No heuristic markers hit in these outputs yet.
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
                    <pre className="mt-1 max-h-[min(40svh,22rem)] overflow-y-auto whitespace-pre-wrap break-words font-sans text-[10px] leading-relaxed text-muted-foreground/95">
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
  );
}

/**
 * Beliefs, curiosity, and goals from one {@link computeLiveMindSnapshot} result (two-column + full-width goals).
 */
function BeliefsCuriosityGoalsSnapshotGrid({
  derived,
  beliefsOpen,
  setBeliefsOpen,
  curiosityOpen,
  setCuriosityOpen,
  goalsOpen,
  setGoalsOpen,
}) {
  return (
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
  );
}

/**
 * Per-system mind snapshot for System Chat dual graph (primary vs mirror KV).
 * @param {{ label: string, accent: 'a' | 'b', derived: ReturnType<typeof computeLiveMindSnapshot> }} props
 */
function PlaygroundMindColumn({ label, accent, derived }) {
  const [stanceOpen, setStanceOpen] = useState(true);
  const [gwOpen, setGwOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [emergenceOpen, setEmergenceOpen] = useState(false);
  const [beliefsOpen, setBeliefsOpen] = useState(false);
  const [curiosityOpen, setCuriosityOpen] = useState(false);
  const [goalsOpen, setGoalsOpen] = useState(false);
  const border =
    accent === 'a'
      ? 'border-blue-500/35 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.12)]'
      : 'border-red-500/35 shadow-[inset_0_0_0_1px_rgba(239,68,68,0.12)]';
  return (
    <div className={cn('min-w-0 space-y-3 rounded-xl border bg-card/80 p-3', border)}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground/90">{label}</div>
      <p className="text-[10px] text-muted-foreground md:whitespace-nowrap md:overflow-x-auto">
        {accent === 'a' ? (
          <>
            Merged from <strong className="text-foreground/90">all primary-profile active pipelines</strong> (graph sessions,
            curiosity, goals, scheduler) plus shared memory.
          </>
        ) : (
          <>
            Merged from <strong className="text-foreground/90">mirror-profile pipelines</strong> (System B graph sessions,
            curiosity, goals, scheduler) and shared memory.
          </>
        )}
      </p>
      <MindSnapshotCollapsibleSection
        accent="sky"
        open={stanceOpen}
        onToggle={setStanceOpen}
        icon={Activity}
        iconClassName="text-sky-400"
        title="Stance vs prediction"
        count={null}
      >
        <div className={cn('rounded-lg border p-3 sm:p-4', stabilityAccent(derived.stability.tier))}>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Cross-turn audit, Planning vs primary, or Integration/Voice vs Planning
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground">{derived.stability.headline}</div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{derived.stability.detail}</p>
        </div>
      </MindSnapshotCollapsibleSection>
      {derived.globalWorkspace ? (
        <GlobalWorkspaceSection gw={derived.globalWorkspace} open={gwOpen} onToggle={setGwOpen} />
      ) : null}
      <MindSnapshotCollapsibleSection
        accent="sky"
        open={identityOpen}
        onToggle={setIdentityOpen}
        icon={Fingerprint}
        iconClassName="text-sky-400"
        title="Identity log"
        count={derived.identityLogs.length}
      >
        {derived.identityLogs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
            No identity deltas detected for this system&apos;s live outputs yet.
          </div>
        ) : (
          <div className="space-y-2">
            {derived.identityLogs.map((log, i) => (
              <div key={i} className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-2 text-[11px]">
                <div className="text-[10px] font-semibold text-muted-foreground">{log.label}</div>
                <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[10px] text-foreground/85">
                  {log.excerpt}
                </pre>
              </div>
            ))}
          </div>
        )}
      </MindSnapshotCollapsibleSection>
      <EmergenceEventsSnapshotSection derived={derived} open={emergenceOpen} onToggle={setEmergenceOpen} />
      <BeliefsCuriosityGoalsSnapshotGrid
        derived={derived}
        beliefsOpen={beliefsOpen}
        setBeliefsOpen={setBeliefsOpen}
        curiosityOpen={curiosityOpen}
        setCuriosityOpen={setCuriosityOpen}
        goalsOpen={goalsOpen}
        setGoalsOpen={setGoalsOpen}
      />
    </div>
  );
}

function LiveMindSnapshotPanel({ rows, sources, graphLastSharedMemory, playgroundDualMind }) {
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

  /** Merged emergence + beliefs/curiosity/goals: in dual mode these live in {@link PlaygroundMindColumn} only. */
  const showMergedEmergenceAndSignalGrid = !playgroundDualMind;

  const dualStructuredAny = playgroundDualMind
    ? playgroundDualMind.systemA.hasAny || playgroundDualMind.systemB.hasAny
    : false;
  const showStructuredEmptyHint = playgroundDualMind ? !dualStructuredAny : !derived.hasAny;

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
        {playgroundDualMind ? (
          <p className="mt-2 text-[10px] text-muted-foreground">
            System B activity detected: <strong className="text-foreground/90">stance, global workspace, identity, beliefs, emergence,
            curiosity, and goals</strong> are split <strong className="text-foreground/90">per system</strong> in the columns below.
            Primary-profile pipelines merge into System A; mirror-profile pipelines (including System B curiosity, goals, and
            scheduler tasks) appear under System B.
          </p>
        ) : null}
      </div>

      {playgroundDualMind ? (
        <div className="grid gap-4 md:grid-cols-2">
          <PlaygroundMindColumn label="System A (primary mind)" accent="a" derived={playgroundDualMind.systemA} />
          <PlaygroundMindColumn label="System B (mirror mind)" accent="b" derived={playgroundDualMind.systemB} />
        </div>
      ) : null}

      {!playgroundDualMind ? (
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
              Cross-turn audit, Planning vs primary turn, or Integration/Voice vs Planning when shared memory omits fields
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
      ) : null}

      {!playgroundDualMind && derived.globalWorkspace ? (
        <GlobalWorkspaceSection gw={derived.globalWorkspace} open={gwOpen} onToggle={setGwOpen} />
      ) : null}

      {!playgroundDualMind ? (
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
      ) : null}

      {showMergedEmergenceAndSignalGrid ? (
        <>
          <EmergenceEventsSnapshotSection
            derived={derived}
            open={emergenceLiveOpen}
            onToggle={setEmergenceLiveOpen}
          />
          <BeliefsCuriosityGoalsSnapshotGrid
            derived={derived}
            beliefsOpen={beliefsOpen}
            setBeliefsOpen={setBeliefsOpen}
            curiosityOpen={curiosityOpen}
            setCuriosityOpen={setCuriosityOpen}
            goalsOpen={goalsOpen}
            setGoalsOpen={setGoalsOpen}
          />
        </>
      ) : null}

      {showStructuredEmptyHint ? (
        <p className="text-[11px] text-muted-foreground">
          No structured belief, curiosity, goal, or emergence markers detected in outputs yet — early in the run, or modules
          have not emitted machine-readable tails.
        </p>
      ) : null}

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
  const { rows, sources, metrics, metricsBySystem, graphLastSharedMemory, playgroundDualMind } = useSyncExternalStore(
    subscribeLiveActivePipelineAnalytics,
    getLiveActivePipelineAnalyticsSnapshot,
    getLiveActivePipelineAnalyticsSnapshot
  );

  const activePipelineEntries = useMemo(() => {
    const paired = rows.map((row, i) => ({ row, source: sources[i], origIdx: i }));
    if (!playgroundDualMind) return paired;
    return [...paired].sort((a, b) => {
      const rank = (p) => (p.row.playgroundSystemAccent === 'b' ? 1 : 0);
      const d = rank(a) - rank(b);
      if (d !== 0) return d;
      return a.origIdx - b.origIdx;
    });
  }, [rows, sources, playgroundDualMind]);

  return (
    <PageShell
      icon={Radio}
      title="Live Analytics"
      description="Mind snapshot parses beliefs, emergence heuristics, identity deltas, curiosity, goals, and stance vs prediction (cross-turn audit when available) from live pipeline outputs in this tab; cards below show full module traces. Persisted metrics live on Cognitive Health and Emergence."
    >
      <div className="mx-auto max-w-6xl space-y-6">
        {metricsBySystem ? (
          <div className="space-y-4">
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded border border-blue-500/35 bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">
                  System A
                </span>
                <span className="text-xs font-medium text-muted-foreground">Primary mind — merged active pipelines</span>
              </div>
              <LiveMetricsFourTiles m={metricsBySystem.systemA} accent="a" />
            </div>
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded border border-red-500/35 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700 dark:text-red-300">
                  System B
                </span>
                <span className="text-xs font-medium text-muted-foreground">Mirror mind — System B graph sessions &amp; mirror tasks</span>
              </div>
              <LiveMetricsFourTiles m={metricsBySystem.systemB} accent="b" />
            </div>
          </div>
        ) : (
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
        )}

        <LiveMindSnapshotPanel
          rows={rows}
          sources={sources}
          graphLastSharedMemory={graphLastSharedMemory}
          playgroundDualMind={playgroundDualMind}
        />

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
              {activePipelineEntries.map(({ row, source, origIdx }, i) => {
                const prevAccent = i > 0 ? activePipelineEntries[i - 1].row.playgroundSystemAccent : undefined;
                const showGroupHeading =
                  Boolean(playgroundDualMind) &&
                  (i === 0 || prevAccent !== row.playgroundSystemAccent);
                return (
                  <Fragment key={`${row.key}-${origIdx}`}>
                    {showGroupHeading ? (
                      <div className="border-b border-border/60 pb-2">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          {row.playgroundSystemAccent === 'b' ? 'System B (mirror)' : 'System A (primary)'}
                        </h3>
                        <p className="mt-0.5 max-w-2xl text-[10px] text-muted-foreground">
                          {row.playgroundSystemAccent === 'b'
                            ? 'Mirror graph session (playground-dual-b); cards use a red accent.'
                            : 'Primary-profile pipelines (including other graph tabs, curiosity, goals, scheduler); cards use a blue accent.'}
                        </p>
                      </div>
                    ) : null}
                    <PipelineLiveCard row={row} source={source} />
                  </Fragment>
                );
              })}
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
