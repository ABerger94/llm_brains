import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MirrorBeliefStore } from '../lib/data';
import { Button } from '../components/ui/button';

const PAGE_SIZE = 20;

export default function PlaygroundMirrorBeliefsPage() {
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const all = await MirrorBeliefStore.list('-created_date', 500);
        if (!cancelled) setRows(Array.isArray(all) ? all : []);
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const start = page * PAGE_SIZE;
  const slice = rows.slice(start, start + PAGE_SIZE);
  const maxPage = Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1);

  return (
    <div className="flex w-full min-h-0 flex-1 flex-col bg-background p-4 sm:p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-bold text-foreground">Mirror beliefs</h1>
          <Link to="/playground" className="text-sm text-primary underline-offset-4 hover:underline">
            Back to System Chat
          </Link>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          Belief rows for the dual-graph playground mirror mind only — separate from your primary belief store.
        </p>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-muted-foreground">{rows.length} belief(s)</p>
            <ul className="space-y-2">
              {slice.map((b) => (
                <li key={b.id} className="rounded-lg border border-border bg-card p-3 text-sm shadow-sm">
                  <div className="font-medium leading-snug text-foreground">{b.statement}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {String(b.category || '')} · {String(b.status || '')}
                  </div>
                </li>
              ))}
            </ul>
            {rows.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">No mirror beliefs yet — run System B in System Chat.</p>
            ) : null}
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                Previous
              </Button>
              <span className="text-xs tabular-nums text-muted-foreground">
                Page {page + 1} of {maxPage + 1}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page >= maxPage}
                onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
