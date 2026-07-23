import { useCallback, useEffect, useState } from 'react';
import moment from 'moment';
import { Link } from 'react-router-dom';
import { Loader2, Orbit, RefreshCw } from 'lucide-react';
import { Button, Textarea } from '../components/ui';
import { loadDmnCarryoverTextForPhase } from '../lib/mindDmnContext';
import { useMindStorageRefresh } from '../lib/mindStorageEvents';
import { cn } from '../lib/utils';
import PageDescriptionCollapsible from '../components/PageDescriptionCollapsible';
import { useMindScope, useScopedEntities } from '../context/MindScopeContext';
import MindScopeTabs from '../components/MindScopeTabs';
import {
  MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR,
  MIND_STORAGE_PROFILE_PRIMARY,
  setActiveMindEntityProfile,
} from '../lib/mindEntityContext';

function Panel({ className, children }) {
  return <div className={cn('rounded-2xl border border-border bg-card p-4', className)}>{children}</div>;
}

const DMN_REASON = 'dmn_internal_narrative';

export default function DmnReflectionsPage() {
  const { isMirror } = useMindScope();
  const { SelfLedgerRevision } = useScopedEntities();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [carryoverPreview, setCarryoverPreview] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (isMirror) {
        setActiveMindEntityProfile(MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR);
      } else {
        setActiveMindEntityProfile(MIND_STORAGE_PROFILE_PRIMARY);
      }
      try {
        const list = await SelfLedgerRevision.list('-created_date', 120);
        const dmn = list.filter((r) => r.reason === DMN_REASON);
        setRows(dmn);
        const carry = await loadDmnCarryoverTextForPhase('drift');
        setCarryoverPreview(carry || null);
      } finally {
        setActiveMindEntityProfile(MIND_STORAGE_PROFILE_PRIMARY);
      }
    } finally {
      setLoading(false);
    }
  }, [SelfLedgerRevision, isMirror]);

  useEffect(() => {
    void load();
  }, [load]);

  useMindStorageRefresh(load);

  return (
    <div className="w-full min-h-0 p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <MindScopeTabs />
        </div>
        {isMirror ? (
          <p className="rounded-lg border border-border/80 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            System B: DMN rows shown here are from the mirror self-ledger (System Chat / mirror graph runs).
          </p>
        ) : null}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
              <Orbit className="h-7 w-7 text-violet-400" />
              DMN Reflections
            </h1>
            <PageDescriptionCollapsible className="mt-1">
              Default mode network–style passes: inner narrative, continuity, and embodiment when there is no live user
              turn. Each run is stored in the self-ledger as{' '}
              <span className="font-mono text-foreground/80">{DMN_REASON}</span> and can be injected as{' '}
              <span className="font-mono text-foreground/80">dmnCarryover</span> on{' '}
              <span className="text-foreground/90">drift</span> and <span className="text-foreground/90">sleep</span>{' '}
              pipeline phases.
            </PageDescriptionCollapsible>
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
          <div className="text-sm font-semibold">Queue more reflections</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Schedule <span className="font-mono text-foreground/80">dmn_reflection</span> under Self &amp; identity tasks, or
            run consolidation / drift sessions from Graph Pipeline — reflections append here when recorded.
          </p>
          <Link
            to="/scheduler"
            className="mt-3 inline-flex text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            Open Scheduler →
          </Link>
        </Panel>

        <Panel>
          <div className="text-sm font-semibold">Drift-phase carryover preview</div>
          <p className="mt-1 text-xs text-muted-foreground">
            What the pipeline would inject as <span className="font-mono text-foreground/80">dmnCarryover</span> on the next
            drift run (latest DMN ledger excerpt, else biography summary).
          </p>
          {carryoverPreview ? (
            <Textarea readOnly value={carryoverPreview} className="mt-3 min-h-[100px] resize-none text-xs" />
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No carryover text yet — add a DMN reflection or biography.</p>
          )}
        </Panel>

        <Panel>
          <div className="text-sm font-semibold">Saved DMN reflections</div>
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary/40" />
            </div>
          ) : rows.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No DMN reflections in the ledger yet.</p>
          ) : (
            <ul className="mt-4 space-y-4">
              {rows.map((row) => (
                <li key={row.id} className="rounded-lg border border-border/80 bg-muted/10 p-4 text-sm">
                  <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                    <span>{row.created_date ? moment(row.created_date).fromNow() : ''}</span>
                    <span>·</span>
                    <span>{row.phase || 'drift'}</span>
                  </div>
                  {row.summary ? <p className="mt-2 font-medium text-foreground">{row.summary}</p> : null}
                  {row.identity_excerpt ? (
                    <Textarea readOnly value={row.identity_excerpt} className="mt-2 min-h-[120px] resize-none text-xs" />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
