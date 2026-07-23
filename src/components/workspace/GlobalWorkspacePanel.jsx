import { AlertTriangle, Layers } from 'lucide-react';
import { cn } from '../../lib/utils';
import MindSnapshotCollapsibleSection from '../pipeline/MindSnapshotCollapsibleSection';

export function unityColor(unity) {
  if (unity === 'unified') return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  if (unity === 'split') return 'border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300';
  return 'border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300';
}

export function ConfidenceBar({ value, className }) {
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

/** Rich display for normalized globalWorkspace DTO from computeLiveMindSnapshot. */
export function GlobalWorkspaceSection({ gw, open, onToggle, title = 'Global Workspace (Integration)' }) {
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
      title={title}
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
          INTEGRATION_JSON was not parseable — the server reconstructed this workspace from upstream modules. Data may be
          incomplete.
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
                  <li key={i} className="border-l-2 border-sky-500/30 pl-2">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {gw.conflicts.length > 0 ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Conflicts</div>
              <ul className="space-y-1 text-[11px] text-foreground/85">
                {gw.conflicts.map((c, i) => (
                  <li key={i} className="border-l-2 border-rose-500/30 pl-2">
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {gw.openQuestions.length > 0 ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Open questions</div>
              <ul className="space-y-1 text-[11px] text-foreground/85">
                {gw.openQuestions.map((q, i) => (
                  <li key={i} className="border-l-2 border-amber-500/30 pl-2">
                    {q}
                  </li>
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
