import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import moment from 'moment';
import { GitBranch, HelpCircle, Loader2, MessageSquare, RefreshCw, Target } from 'lucide-react';
import { Button } from '../components/ui';
import PageShell from '../components/PageShell';
import { ConversationMessage, CuriosityItem, GoalItem } from '../lib/data';
import { useMindStorageRefresh } from '../lib/mindStorageEvents';
import { cn } from '../lib/utils';
import {
  getGraphPipelineSessionRegistry,
  subscribeGraphPipelineRegistry,
} from '../lib/graphPipelineSessionRegistry';
import { DEFAULT_GRAPH_SESSION_ID } from '../lib/graphPipelineSessionScope';
import {
  groupMessagesBySession,
  summarizeSessionsForDialogueIndex,
  labelForDialogueSession,
  recentCuriosityWithAnswers,
  recentGoalsWithAnswers,
  truncateDialogueSnippet,
} from '../lib/dialogueTranscript';

const MESSAGE_CAP = 1200;
const ENTITY_CAP = 300;

export default function DialogueTranscriptIndexPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [summaries, setSummaries] = useState([]);
  const [recentCurios, setRecentCurios] = useState([]);
  const [recentGoals, setRecentGoals] = useState([]);

  const registry = useSyncExternalStore(
    subscribeGraphPipelineRegistry,
    getGraphPipelineSessionRegistry,
    getGraphPipelineSessionRegistry
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rows, curios, goals] = await Promise.all([
        ConversationMessage.list('-created_date', MESSAGE_CAP),
        CuriosityItem.list('-created_date', ENTITY_CAP),
        GoalItem.list('-created_date', ENTITY_CAP),
      ]);
      const bySession = groupMessagesBySession(rows);
      setSummaries(summarizeSessionsForDialogueIndex(bySession));
      setRecentCurios(recentCuriosityWithAnswers(curios, 8));
      setRecentGoals(recentGoalsWithAnswers(goals, 8));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSummaries([]);
      setRecentCurios([]);
      setRecentGoals([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useMindStorageRefresh(load);

  return (
    <PageShell
      icon={MessageSquare}
      title="Dialogue"
      description="Your inputs and Voice (assistant) replies per graph pipeline session — same session ids as Graph Pipeline. Below: recent questions and goals with answers; open a transcript for session-scoped pursuits."
      actions={
        <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          Refresh
        </Button>
      }
    >
      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>
      ) : null}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-8">
          {summaries.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-8 text-center">
              <p className="font-medium">No conversation sessions yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Run the graph pipeline with a user message, or use a scheduled task that logs conversation rows. Messages without
                a session tag are grouped under <span className="font-mono text-foreground/80">default</span>.
              </p>
              <Link
                to="/graph-pipeline"
                className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary underline-offset-2 hover:underline"
              >
                <GitBranch className="h-4 w-4" />
                Open Graph Pipeline
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
          {summaries.map((s) => {
            const label = labelForDialogueSession(s.sessionId, registry);
            const enc = encodeURIComponent(s.sessionId);
            const hrefDialogue = `/dialogue/${enc}`;
            const hrefGp = `/graph-pipeline/${enc}`;
            return (
              <div
                key={s.sessionId}
                className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="font-medium text-foreground">{label}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {s.userCount} user turn{s.userCount === 1 ? '' : 's'} · {s.pairCount} pair{s.pairCount === 1 ? '' : 's'} ·{' '}
                    last activity {moment(s.lastActivity).fromNow()}
                    {s.sessionId === DEFAULT_GRAPH_SESSION_ID ? (
                      <span className="ml-1 font-mono text-[10px] text-foreground/60">(default)</span>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={hrefDialogue}
                    className={cn(
                      'inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium ring-offset-background transition-colors',
                      'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                    )}
                  >
                    View transcript
                  </Link>
                  <Link
                    to={hrefGp}
                    className={cn(
                      'inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground ring-offset-background transition-colors',
                      'hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                    )}
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                    Graph Pipeline
                  </Link>
                </div>
              </div>
            );
          })}
            </div>
          )}

          <div className="space-y-3">
              <h2 className="text-sm font-semibold text-foreground">Recent questions & goals (answers)</h2>
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                  <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2">
                    <HelpCircle className="h-4 w-4 text-sky-600 dark:text-sky-400" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Questions
                    </span>
                    <Link
                      to="/curiosity"
                      className="ml-auto text-[11px] font-medium text-primary underline-offset-2 hover:underline"
                    >
                      Open queue
                    </Link>
                  </div>
                  <div className="divide-y divide-border/60">
                    {recentCurios.length === 0 ? (
                      <div className="px-4 py-3 text-sm text-muted-foreground">No answered questions in memory yet.</div>
                    ) : (
                      recentCurios.map((c) => {
                        const q = String(c.question || '').trim() || '—';
                        const ans =
                          String(c.resolution || '').trim() ||
                          truncateDialogueSnippet(String(c.pursuit_thread || '').trim(), 400);
                        const href = `/dialogue/curiosity/${encodeURIComponent(String(c.id))}`;
                        return (
                          <Link
                            key={c.id}
                            to={href}
                            className="block px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                          >
                            <p className="text-sm font-medium leading-snug text-foreground">{q}</p>
                            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground line-clamp-4">{ans}</p>
                          </Link>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                  <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2">
                    <Target className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Goals</span>
                    <Link
                      to="/goals"
                      className="ml-auto text-[11px] font-medium text-primary underline-offset-2 hover:underline"
                    >
                      Open stack
                    </Link>
                  </div>
                  <div className="divide-y divide-border/60">
                    {recentGoals.length === 0 ? (
                      <div className="px-4 py-3 text-sm text-muted-foreground">No answered goals in memory yet.</div>
                    ) : (
                      recentGoals.map((g) => {
                        const stmt = String(g.goal_statement || '').trim() || '—';
                        const ans =
                          String(g.resolution || '').trim() ||
                          truncateDialogueSnippet(String(g.pursuit_thread || '').trim(), 400);
                        const href = `/dialogue/goal/${encodeURIComponent(String(g.id))}`;
                        return (
                          <Link
                            key={g.id}
                            to={href}
                            className="block px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                          >
                            <p className="text-sm font-medium leading-snug text-foreground">{stmt}</p>
                            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground line-clamp-4">{ans}</p>
                          </Link>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
        </div>
      )}
    </PageShell>
  );
}
