import { useCallback, useEffect, useState } from 'react';
import moment from 'moment';
import { Link } from 'react-router-dom';
import { Loader2, Orbit, RefreshCw } from 'lucide-react';
import { Button, Textarea } from '../components/ui';
import { SelfLedgerRevision } from '../lib/data';
import { loadDmnCarryoverTextForPhase } from '../lib/mindDmnContext';
import { useMindStorageRefresh } from '../lib/mindStorageEvents';
import { cn } from '../lib/utils';

function Panel({ className, children }) {
  return <div className={cn('rounded-2xl border border-border bg-card p-4', className)}>{children}</div>;
}

const DMN_REASON = 'dmn_internal_narrative';

export default function DmnReflectionsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [carryoverPreview, setCarryoverPreview] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await SelfLedgerRevision.list('-created_date', 120);
      const dmn = list.filter((r) => r.reason === DMN_REASON);
      setRows(dmn);
      const carry = await loadDmnCarryoverTextForPhase('drift');
      setCarryoverPreview(carry || null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useMindStorageRefresh(load);

  return (
    <div className="min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
              <Orbit className="h-7 w-7 text-violet-400" />
              DMN Reflections
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Default mode network–style passes: inner narrative, continuity, and embodiment when there is no live user
              turn. Each run is stored in the self-ledger as{' '}
              <span className="font-mono text-foreground/80">{DMN_REASON}</span> and can be injected as{' '}
              <span className="font-mono text-foreground/80">dmnCarryover</span> on{' '}
              <span className="text-foreground/90">drift</span> and <span className="text-foreground/90">sleep</span>{' '}
              pipeline phases.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 gap-2"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        <Panel>
          <div className="text-sm font-semibold text-foreground">Queue more reflections</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Schedule <span className="font-mono text-foreground/80">dmn_reflection</span> under Self &amp; identity tasks, or
            run consolidation / drift sessions from Graph Pipeline — reflections append here when recorded.
          </p>
          <Link
            to="/scheduler"
            className="mt-3 inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Open Scheduler →
          </Link>
        </Panel>

        <Panel>
          <div className="text-sm font-semibold text-foreground">Current drift carryover preview</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Text the pipeline would attach on the next <span className="font-mono">drift</span> run (latest DMN excerpt,
            else Mind Biography).
          </p>
          {loading ? (
            <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : carryoverPreview ? (
            <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 text-[11px] leading-relaxed text-muted-foreground">
              {carryoverPreview}
            </pre>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              None yet — complete a DMN reflection or add Mind Biography text.
            </p>
          )}
        </Panel>

        <Panel>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-sm font-semibold text-foreground">Reflection history</div>
            <span className="text-xs text-muted-foreground">{rows.length} saved</span>
          </div>
          {loading ? (
            <div className="mt-8 flex justify-center py-12 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin opacity-50" />
            </div>
          ) : rows.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No DMN reflections yet. Queue <span className="font-mono text-foreground/80">dmn_reflection</span> on the{' '}
              <Link to="/scheduler" className="text-primary underline-offset-4 hover:underline">
                Scheduler
              </Link>{' '}
              or see the compact list on{' '}
              <Link to="/mind-self" className="text-primary underline-offset-4 hover:underline">
                Self &amp; consolidation
              </Link>
              .
            </p>
          ) : (
            <div className="mt-4 space-y-4">
              {rows.map((row) => (
                <div key={row.id} className="rounded-xl border border-border/80 bg-muted/10 p-4">
                  <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="rounded bg-violet-500/15 px-1.5 py-0.5 font-mono text-violet-200">
                      {row.reason}
                    </span>
                    <span>{row.phase || 'drift'}</span>
                    {row.pipeline_run_id ? (
                      <span className="font-mono">run …{String(row.pipeline_run_id).slice(-6)}</span>
                    ) : null}
                    <span className="ml-auto">
                      {row.created_date ? moment(row.created_date).format('lll') : ''}
                      {row.created_date ? ` · ${moment(row.created_date).fromNow()}` : ''}
                    </span>
                  </div>
                  {row.summary ? <p className="mt-2 text-sm font-medium text-foreground">{row.summary}</p> : null}
                  {row.identity_excerpt ? (
                    <Textarea
                      readOnly
                      value={row.identity_excerpt}
                      className="mt-3 min-h-[140px] resize-y font-sans text-[12px] leading-relaxed"
                    />
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">No narrative body stored for this row.</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
