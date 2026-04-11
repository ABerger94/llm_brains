import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import moment from 'moment';
import { ArrowLeft, GitBranch, Loader2, MessageSquare, RefreshCw, Target, Users } from 'lucide-react';
import { Button } from '../components/ui';
import { GoalItem } from '../lib/data';
import { useMindStorageRefresh } from '../lib/mindStorageEvents';
import { cn } from '../lib/utils';
import { goalAnswerBody } from '../lib/dialogueTranscript';

const ANSWER_MAX = 48_000;

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

export default function DialogueGoalDetailPage() {
  const { goalId: rawId } = useParams();
  const goalId = useMemo(() => String(rawId || '').trim(), [rawId]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [item, setItem] = useState(null);

  const load = useCallback(async () => {
    if (!goalId) return;
    setLoading(true);
    setError(null);
    try {
      const row = await GoalItem.retrieve(goalId);
      setItem(row || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItem(null);
    } finally {
      setLoading(false);
    }
  }, [goalId]);

  useEffect(() => {
    void load();
  }, [load]);

  useMindStorageRefresh(load);

  const enc = encodeURIComponent(goalId);
  const hrefThread = `/dialogue/goal/${enc}/thread`;
  const hrefGoals = `/goals?focus=${enc}`;

  const answer = item ? goalAnswerBody(item) : '';
  const answerDisplay = answer.length > ANSWER_MAX ? `${answer.slice(0, ANSWER_MAX)}…` : answer;

  if (!goalId) {
    return (
      <PageShell icon={Target} title="Goal" description={null} actions={null}>
        <p className="text-sm text-muted-foreground">Missing id.</p>
      </PageShell>
    );
  }

  return (
    <PageShell
      icon={Target}
      title="Goal"
      description="Full statement and progress from your goal stack."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/dialogue"
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium ring-offset-background transition-colors',
              'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
            )}
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Dialogue
          </Link>
          <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </Button>
          {item ? (
            <Link
              to={hrefThread}
              className={cn(
                'inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground ring-offset-background transition-colors',
                'hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
              )}
            >
              <Users className="h-4 w-4" />
              View thread
            </Link>
          ) : null}
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
      ) : !item ? (
        <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-8 text-center">
          <p className="font-medium">Goal not found</p>
          <p className="mt-1 text-sm text-muted-foreground">This id is not in local goal storage.</p>
          <Link
            to="/dialogue"
            className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            <MessageSquare className="h-4 w-4" />
            Dialogue index
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Goal</div>
            <p className="mt-2 whitespace-pre-wrap text-sm font-medium leading-relaxed text-foreground">
              {String(item.goal_statement || '').trim() || '—'}
            </p>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 font-medium',
                  String(item.status || 'open') === 'resolved'
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {String(item.status || 'open')}
              </span>
              {item.updated_date ? (
                <span>Updated {moment(item.updated_date).format('lll')}</span>
              ) : item.created_date ? (
                <span>Created {moment(item.created_date).format('lll')}</span>
              ) : null}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-400">
              Progress / answer
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {answerDisplay ? answerDisplay : <span className="italic text-muted-foreground">(no resolution yet)</span>}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              to={hrefGoals}
              className={cn(
                'inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium ring-offset-background transition-colors',
                'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
              )}
            >
              <GitBranch className="h-4 w-4" />
              Open in Goals
            </Link>
          </div>
        </div>
      )}
    </PageShell>
  );
}
