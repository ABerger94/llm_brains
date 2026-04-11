import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import moment from 'moment';
import { ArrowLeft, HelpCircle, Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { Button } from '../components/ui';
import { CuriosityItem } from '../lib/data';
import { useMindStorageRefresh } from '../lib/mindStorageEvents';
import { cn } from '../lib/utils';
import {
  curiosityAnswerBody,
  curiosityThreadItems,
  effectiveCuriosityRootId,
  truncateDialogueSnippet,
} from '../lib/dialogueTranscript';

const LIST_CAP = 500;

function PageShell({ icon: Icon, title, description, actions, children }) {
  return (
    <div className="min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15">
                <Icon className="h-5 w-5 text-primary" />
              </div>
              <h1 className="text-2xl font-bold">{title}</h1>
            </div>
            {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

export default function DialogueCuriosityThreadPage() {
  const { curiosityId: rawId } = useParams();
  const curiosityId = useMemo(() => String(rawId || '').trim(), [rawId]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [thread, setThread] = useState([]);
  const [rootId, setRootId] = useState('');
  const [seedMissing, setSeedMissing] = useState(false);

  const load = useCallback(async () => {
    if (!curiosityId) return;
    setLoading(true);
    setError(null);
    try {
      const seed = await CuriosityItem.retrieve(curiosityId);
      if (!seed) {
        setThread([]);
        setRootId('');
        setSeedMissing(true);
        return;
      }
      setSeedMissing(false);
      const rid = effectiveCuriosityRootId(seed);
      setRootId(rid);
      const all = await CuriosityItem.list('-created_date', LIST_CAP);
      setThread(curiosityThreadItems(rid, all));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setThread([]);
      setRootId('');
      setSeedMissing(false);
    } finally {
      setLoading(false);
    }
  }, [curiosityId]);

  useEffect(() => {
    void load();
  }, [load]);

  useMindStorageRefresh(load);

  const enc = encodeURIComponent(curiosityId);
  const hrefDetail = `/dialogue/curiosity/${enc}`;

  if (!curiosityId) {
    return (
      <PageShell icon={HelpCircle} title="Thread" description={null} actions={null}>
        <p className="text-sm text-muted-foreground">Missing id.</p>
      </PageShell>
    );
  }

  return (
    <PageShell
      icon={HelpCircle}
      title="Question thread"
      description={
        rootId
          ? `Related questions in this pursuit cluster (root ${rootId.length > 20 ? `${rootId.slice(0, 8)}…` : rootId}).`
          : 'Related questions in this pursuit cluster.'
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={hrefDetail}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium ring-offset-background transition-colors',
              'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
            )}
          >
            <ArrowLeft className="h-4 w-4" />
            Back to question
          </Link>
          <Link
            to="/dialogue"
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium ring-offset-background transition-colors',
              'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
            )}
          >
            Dialogue index
          </Link>
          <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      }
    >
      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>
      ) : null}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : seedMissing ? (
        <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-8 text-center">
          <p className="font-medium">Question not found</p>
          <p className="mt-1 text-sm text-muted-foreground">This id is not in local curiosity storage.</p>
          <Link
            to="/dialogue"
            className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            <MessageSquare className="h-4 w-4" />
            Dialogue index
          </Link>
        </div>
      ) : thread.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-8 text-center">
          <p className="font-medium">Nothing in this thread</p>
          <p className="mt-1 text-sm text-muted-foreground">No related items matched this cluster.</p>
          <Link
            to="/dialogue"
            className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            <MessageSquare className="h-4 w-4" />
            Dialogue index
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {thread.map((c) => {
            const q = String(c.question || '').trim() || '—';
            const ans = truncateDialogueSnippet(curiosityAnswerBody(c), 360);
            const st = String(c.status || 'open');
            const oid = encodeURIComponent(String(c.id));
            return (
              <div key={c.id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase text-sky-600 dark:text-sky-400">Depth {Number(c.pursuit_depth ?? 0)}</span>
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[10px] font-medium',
                      st === 'resolved' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {st}
                  </span>
                  {c.created_date ? (
                    <span className="text-[10px] text-muted-foreground">{moment(c.created_date).format('lll')}</span>
                  ) : null}
                </div>
                <p className="mt-2 text-sm font-medium leading-snug text-foreground">{q}</p>
                {ans ? <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{ans}</p> : null}
                {String(c.id) !== curiosityId ? (
                  <Link
                    to={`/dialogue/curiosity/${oid}`}
                    className="mt-3 inline-block text-xs font-medium text-primary underline-offset-2 hover:underline"
                  >
                    Open this question
                  </Link>
                ) : (
                  <p className="mt-3 text-[11px] text-muted-foreground">Current question</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
