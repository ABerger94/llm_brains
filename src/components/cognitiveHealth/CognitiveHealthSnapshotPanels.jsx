import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  CartesianGrid,
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '../../lib/utils';
import {
  HEALTH_CHART,
  HEALTH_GROWTH_RUN_ARTIFACT_GRACE_MS,
  PIPELINE_BIOGRAPHY_SNAPSHOT_EVERY_N_RUNS,
} from '../../lib/cognitiveHealthDerived';

/** Series order and colors match the LineChart in Growth over pipeline runs. */
const GROWTH_CHART_LEGEND_ITEMS = [
  { label: 'Beliefs (cumulative)', color: HEALTH_CHART.cyan },
  { label: 'Curiosity (cumulative)', color: HEALTH_CHART.amber },
  { label: 'Goals (cumulative)', color: HEALTH_CHART.goals },
  { label: 'Memories (cumulative)', color: HEALTH_CHART.indigo },
  { label: 'Contradiction resolutions (cumulative)', color: HEALTH_CHART.emerald },
  { label: 'Identity (biography snapshots)', color: HEALTH_CHART.sky },
  { label: 'Emergence (non-rejected)', color: HEALTH_CHART.pink },
];

function Panel({ className, children }) {
  return <div className={cn('min-w-0 rounded-2xl border border-border bg-card p-4', className)}>{children}</div>;
}

function EmptyState({ title, description }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-6 text-center">
      <div className="font-medium">{title}</div>
      <div className="mt-1 text-sm text-muted-foreground">{description}</div>
    </div>
  );
}

function HealthMetricTile({ label, value, format, trend, colorClass = 'text-primary' }) {
  const display = format ? format(value) : value;
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-4">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className={cn('text-2xl font-bold', colorClass)}>{display}</div>
      {trend !== undefined ? (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
          {trend > 0 ? (
            <TrendingUp className="h-3 w-3 text-emerald-400" />
          ) : trend < 0 ? (
            <TrendingDown className="h-3 w-3 text-destructive" />
          ) : (
            <Minus className="h-3 w-3 opacity-50" />
          )}
          <span>{trend > 0 ? 'up vs prior week' : trend < 0 ? 'down vs prior week' : 'stable week'}</span>
        </div>
      ) : null}
    </div>
  );
}

function StatCard({ label, value, hint }) {
  return (
    <Panel>
      <div className="text-xs uppercase tracking-[0.22em] text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
      {hint ? <div className="mt-1 break-words text-xs text-muted-foreground">{hint}</div> : null}
    </Panel>
  );
}

/** @param {{ derived: object | null, loading: boolean }} props */
export default function CognitiveHealthSnapshotPanels({ derived, loading }) {
  if (loading && !derived) {
    return (
      <div className="flex justify-center py-16">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      </div>
    );
  }

  if (!loading && !derived) {
    return (
      <EmptyState title="No data yet" description="Run the pipeline and populate stores to see metrics." />
    );
  }

  if (!derived) return null;

  return (
    <div className="min-w-0 space-y-6">
      <div className="grid min-w-0 grid-cols-2 gap-4 md:grid-cols-3">
        <HealthMetricTile
          label="Total beliefs"
          value={derived.totalBeliefs}
          colorClass="text-emerald-400"
          trend={derived.beliefTrend}
        />
        <HealthMetricTile
          label="Avg confidence"
          value={derived.avgConfidence}
          format={(v) => `${Math.round(v * 100)}%`}
          colorClass="text-primary"
          trend={0}
        />
        <HealthMetricTile
          label="Contradiction res. rate"
          value={derived.contradictionResolutionRate}
          format={(v) => (v == null ? '—' : `${Math.round(Number(v) * 100)}%`)}
          colorClass={
            derived.contradictionResolutionRate == null
              ? 'text-muted-foreground'
              : derived.contradictionResolutionRate > 0.5
                ? 'text-emerald-400'
                : 'text-amber-400'
          }
          trend={0}
        />
        <HealthMetricTile
          label="Curiosity items"
          value={derived.curiosityTotal}
          colorClass="text-amber-400"
          trend={derived.curiosityTrend}
        />
        <HealthMetricTile
          label="Goal items"
          value={derived.goalTotal}
          colorClass="text-violet-300 dark:text-violet-400"
          trend={derived.goalTrend}
        />
        <HealthMetricTile
          label="Belief volatility (σ conf.)"
          value={derived.beliefVolatility}
          format={(v) => v.toFixed(3)}
          colorClass="text-violet-400"
          trend={0}
        />
        <HealthMetricTile
          label="Identity stability"
          value={derived.identityStability}
          format={(v) => `${Math.round(v * 100)}%`}
          colorClass="text-sky-400"
          trend={0}
        />
        <HealthMetricTile
          label="Emergence events"
          value={derived.emergenceCount}
          colorClass="text-pink-400"
          trend={derived.emergenceTrend}
        />
        <HealthMetricTile
          label="Long-term memories"
          value={derived.memoryCount}
          colorClass="text-indigo-500 dark:text-indigo-400"
          trend={derived.memoryTrend}
        />
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Pipeline runs"
          value={derived.runCount}
          hint="All saved PipelineRun rows (graph + stream); other pages may show a capped list"
        />
        <StatCard
          label="Open + pursuing (curiosity)"
          value={derived.openOrPursuing}
          hint={`${derived.curiosityOpen} open · ${derived.curiosityPursuing} pursuing · ${derived.curiosityDormant} dormant · ${derived.resolvedCuriosity} resolved — matches Curiosity Queue rules`}
        />
        <StatCard
          label="Open + pursuing (goals)"
          value={derived.goalOpenOrPursuing}
          hint={`${derived.goalOpen} open · ${derived.goalPursuing} pursuing · ${derived.goalDormant} dormant · ${derived.goalResolved} resolved — matches Goals stack`}
        />
        <StatCard label="RLHF feedback" value={derived.feedbackBalance} hint="Thumbs up / thumbs down" />
        <StatCard label="Dream runs" value={derived.dreamCount} hint="Dreaming mode syntheses" />
        <StatCard
          label="Active / tense beliefs"
          value={`${derived.activeBeliefs} / ${derived.contradictedBeliefs}`}
          hint={`${derived.resolvedBeliefs} resolved${derived.deprecatedBeliefs ? ` · ${derived.deprecatedBeliefs} deprecated` : ''}`}
        />
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel className="p-4">
          <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cognitive profile</h3>
          <div className="h-[260px] w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={derived.radarData}>
                <PolarGrid stroke={HEALTH_CHART.grid} />
                <PolarAngleAxis dataKey="subject" tick={{ fontSize: 10, fill: HEALTH_CHART.axis }} />
                <Radar
                  dataKey="value"
                  stroke={HEALTH_CHART.cyan}
                  fill={HEALTH_CHART.cyan}
                  fillOpacity={0.2}
                  strokeWidth={2}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">
            Normalized 0–100 from local counts (full store). Curiosity and Goals axes use open+pursuing backlog plus total
            items. Contradiction resolution (% of beliefs marked contradicted or resolved that are resolved) appears only
            when that set is non-empty. Identity uses keyword overlap between the two newest biographies.
          </p>
        </Panel>

        <Panel className="p-4">
          <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Growth over pipeline runs
          </h3>
          {derived.growthData.length === 0 ? (
            <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
              No saved runs yet — cumulative beliefs, curiosity, goals, memory, contradiction resolutions, identity
              snapshots, and emergence events will chart here.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="h-[260px] w-full min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={derived.growthData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={HEALTH_CHART.grid} />
                    <XAxis
                      dataKey="label"
                      stroke={HEALTH_CHART.axis}
                      fontSize={10}
                      tickMargin={4}
                      interval={
                        derived.growthData.length > 24
                          ? Math.max(0, Math.ceil(derived.growthData.length / 14) - 1)
                          : 0
                      }
                      angle={derived.growthData.length > 18 ? -32 : 0}
                      textAnchor={derived.growthData.length > 18 ? 'end' : 'middle'}
                      height={derived.growthData.length > 18 ? 52 : 30}
                    />
                    <YAxis stroke={HEALTH_CHART.axis} fontSize={10} width={32} allowDecimals={false} />
                    <Tooltip
                      labelFormatter={(label, payload) => {
                        const row = payload?.[0]?.payload;
                        if (row?.runCreatedAt) {
                          const d = new Date(row.runCreatedAt);
                          if (!Number.isNaN(d.getTime())) {
                            return d.toLocaleString(undefined, {
                              weekday: 'short',
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                            });
                          }
                        }
                        return label;
                      }}
                      contentStyle={{
                        backgroundColor: HEALTH_CHART.tooltipBg,
                        border: `1px solid ${HEALTH_CHART.tooltipBorder}`,
                        borderRadius: 8,
                        fontSize: 11,
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="beliefs"
                      name="Beliefs (cumulative)"
                      stroke={HEALTH_CHART.cyan}
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="curiosity"
                      name="Curiosity (cumulative)"
                      stroke={HEALTH_CHART.amber}
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="goals"
                      name="Goals (cumulative)"
                      stroke={HEALTH_CHART.goals}
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="memories"
                      name="Memories (cumulative)"
                      stroke={HEALTH_CHART.indigo}
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="contradictionResolution"
                      name="Contradiction resolutions (cumulative)"
                      stroke={HEALTH_CHART.emerald}
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="identity"
                      name="Identity (biography snapshots)"
                      stroke={HEALTH_CHART.sky}
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="emergence"
                      name="Emergence (non-rejected)"
                      stroke={HEALTH_CHART.pink}
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div
                className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-border/60 pt-3 text-[10px] text-muted-foreground sm:justify-start"
                role="list"
                aria-label="Growth chart series"
              >
                {GROWTH_CHART_LEGEND_ITEMS.map(({ label, color }) => (
                  <div key={label} className="flex items-center gap-1.5" role="listitem">
                    <span
                      className="h-0.5 w-5 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                      aria-hidden
                    />
                    <span>{label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <p className="mt-2 text-[10px] text-muted-foreground">
            One point per non-checkpoint pipeline run (cooperative mid-graph checkpoints are excluded). Axis shows date;
            same-day runs use time. Hover for full timestamp. Per run: counts on or before that run&apos;s time plus{' '}
            {Math.round(HEALTH_GROWTH_RUN_ARTIFACT_GRACE_MS / 60_000)} min so beliefs and other artifacts saved right after
            the run row still count. The emerald line is the{' '}
            <strong>cumulative count</strong> of
            beliefs marked <span className="font-mono text-foreground/70">resolved</span> whose{' '}
            <span className="font-mono text-foreground/70">updated_date</span> (or{' '}
            <span className="font-mono text-foreground/70">created_date</span> if missing) is on or before that run — not
            the same as the headline rate (a ratio over contradicted+resolved beliefs). Goals counts goal stack items by{' '}
            <span className="font-mono text-foreground/70">created_date</span>. Identity uses Mind Biography rows; emergence
            uses pending + approved events only (same as metrics above). A trailing <span className="font-medium text-foreground/80">Now</span>{' '}
            point is added when any cumulative count (including biography snapshots) is higher than at the last run — e.g.
            manual biography after your newest pipeline run.
          </p>
          <p className="mt-2 text-[10px] text-muted-foreground">
            <Link to="/biography" className="text-primary underline-offset-2 hover:underline">
              Mind Biography
            </Link>{' '}
            (Generate) and scheduled{' '}
            <span className="font-mono text-foreground/70">biography_update</span> tasks add new version rows. Ordinary
            pipeline runs merge into the latest row; after{' '}
            <span className="font-medium text-foreground/80">{PIPELINE_BIOGRAPHY_SNAPSHOT_EVERY_N_RUNS}</span> saved
            non-checkpoint runs since that row was created, an extra snapshot row is stored for this chart.
          </p>
        </Panel>
      </div>
    </div>
  );
}
