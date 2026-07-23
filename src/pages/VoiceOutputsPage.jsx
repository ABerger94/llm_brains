import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import moment from 'moment';
import { ChevronDown, Loader2, MessageSquare, Mic, RefreshCw } from 'lucide-react';
import { Button } from '../components/ui';
import PageShell from '../components/PageShell';
import MindScopeTabs from '../components/MindScopeTabs';
import { useMindScope, useScopedEntities } from '../context/MindScopeContext';
import { MIND_STORAGE_CHANGED } from '../lib/mindStorageEvents';
import { cn } from '../lib/utils';
import { graphPipelineWorkspaceHref } from '../lib/graphSessionMindProfile';

/** Desktop: fetch more rows; mobile keeps IndexedDB + DOM small to avoid WebKit OOM / jank. */
const LIST_CAP_DESKTOP = 400;
const LIST_CAP_MOBILE = 120;
const MAX_SESSION_GROUPS_MOBILE = 4;
const MAX_MESSAGES_PER_SESSION_MOBILE = 72;
const MAX_OTHER_CARDS_MOBILE = 32;
const SNIPPET_DESKTOP = 4000;
const SNIPPET_MOBILE = 1800;
const NONE_KEY = '__none__';

function narrowViewport() {
  if (typeof window === 'undefined') return false;
  try {
    return window.matchMedia('(max-width: 768px)').matches;
  } catch {
    return false;
  }
}

/** Desktop: sections start expanded; mobile collapsed to limit first-paint DOM (WebKit). */
function initialSectionOpen() {
  if (typeof window === 'undefined') return true;
  try {
    return !window.matchMedia('(max-width: 768px)').matches;
  } catch {
    return true;
  }
}

function truncate(s, n = SNIPPET_DESKTOP) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

function dateMs(d) {
  const t = Date.parse(d || '');
  return Number.isFinite(t) ? t : 0;
}

function shortSessionLabel(sid) {
  if (!sid) return 'No session id';
  const s = String(sid);
  return s.length > 28 ? `${s.slice(0, 12)}…${s.slice(-6)}` : s;
}

function normCollapse(s) {
  return String(s || '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** If pursuit thread duplicates resolution, skip extra bubble. */
function pursuitThreadExtra(resolution, pursuitThread) {
  const res = normCollapse(resolution);
  const th = normCollapse(pursuitThread);
  if (!th) return '';
  if (!res) return pursuitThread;
  if (th === res) return '';
  if (th.startsWith(res) || res.startsWith(th)) return '';
  return pursuitThread;
}

/**
 * @param {string} role
 */
function roleLabel(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'assistant') return 'Voice';
  if (r === 'user') return 'Input';
  if (r === 'system') return 'System';
  return r ? r : 'Message';
}

function ChatBubble({ align, label, children, stamp }) {
  const isRight = align === 'right';
  return (
    <div className={cn('flex w-full', isRight ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[min(100%,28rem)] rounded-xl px-3 py-2.5 shadow-sm',
          isRight && 'bg-primary/15 text-foreground',
          !isRight && 'border border-border bg-card text-foreground'
        )}
      >
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
          {stamp ? (
            <span className="text-[10px] tabular-nums text-muted-foreground">{stamp}</span>
          ) : (
            <span />
          )}
        </div>
        <pre className="m-0 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground/95">{children}</pre>
      </div>
    </div>
  );
}

export default function VoiceOutputsPage() {
  const { isMirror } = useMindScope();
  const { ConversationMessage, PipelineRun, CuriosityItem, GoalItem } = useScopedEntities();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  /** @type {Array<{ sessionKey: string, sessionId: string | null, messages: Array<{ id: string, role: string, content: string, at: number }>, latestAt: number }>} */
  const [chatGroups, setChatGroups] = useState([]);
  /** @type {Array<{ id: string, at: number, runInput: string, finalOut: string, sid: string | null, hrefWorkspace: string }>} */
  const [pipelineRunCards, setPipelineRunCards] = useState([]);
  /** @type {Array<{ id: string, at: number, question: string, voicePrimary: string, threadExtra: string, hrefQueue: string }>} */
  const [curiosityCards, setCuriosityCards] = useState([]);
  /** @type {Array<{ id: string, at: number, statement: string, voicePrimary: string, threadExtra: string, hrefQueue: string }>} */
  const [goalCards, setGoalCards] = useState([]);

  const chatEndRef = useRef(null);
  const loadRef = useRef(async () => {});

  const curBase = isMirror ? '/curiosity/mirror' : '/curiosity';
  const goalBase = isMirror ? '/goals/mirror' : '/goals';

  const [runsSectionOpen, setRunsSectionOpen] = useState(initialSectionOpen);
  const [curiositySectionOpen, setCuriositySectionOpen] = useState(initialSectionOpen);
  const [goalsSectionOpen, setGoalsSectionOpen] = useState(initialSectionOpen);

  const textLimit = narrowViewport() ? SNIPPET_MOBILE : SNIPPET_DESKTOP;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const narrow = narrowViewport();
    const listCap = narrow ? LIST_CAP_MOBILE : LIST_CAP_DESKTOP;
    try {
      const [msgs, runs, curios, goals] = await Promise.all([
        ConversationMessage.list('-created_date', listCap),
        PipelineRun.list('-created_date', listCap),
        CuriosityItem.list('-created_date', listCap),
        GoalItem.list('-created_date', listCap),
      ]);

      /** @type {Map<string, Array<{ id: string, role: string, content: string, at: number, created_date: string }>>} */
      const bySession = new Map();

      for (const m of msgs || []) {
        const body = String(m.content || '').trim();
        if (!body) continue;
        const sidRaw = m.graph_session_id != null && String(m.graph_session_id).trim() ? String(m.graph_session_id).trim() : null;
        const key = sidRaw ?? NONE_KEY;
        const row = {
          id: String(m.id || ''),
          role: String(m.role || ''),
          content: body,
          at: dateMs(m.created_date),
          created_date: String(m.created_date || ''),
        };
        if (!bySession.has(key)) bySession.set(key, []);
        bySession.get(key).push(row);
      }

      for (const arr of bySession.values()) {
        arr.sort((a, b) => a.at - b.at);
      }

      const groups = [];
      for (const [key, messages] of bySession) {
        if (messages.length === 0) continue;
        const sessionId = key === NONE_KEY ? null : key;
        const latestAt = Math.max(...messages.map((x) => x.at));
        groups.push({ sessionKey: key, sessionId, messages, latestAt });
      }
      groups.sort((a, b) => b.latestAt - a.latestAt);

      if (narrow) {
        const slim = groups.slice(0, MAX_SESSION_GROUPS_MOBILE).map((g) => {
          const { messages, ...rest } = g;
          const msg =
            messages.length > MAX_MESSAGES_PER_SESSION_MOBILE
              ? messages.slice(-MAX_MESSAGES_PER_SESSION_MOBILE)
              : messages;
          return { ...rest, messages: msg };
        });
        setChatGroups(slim);
      } else {
        setChatGroups(groups);
      }

      const prCards = [];
      for (const r of runs || []) {
        const finalOut = String(r.final_output || '').trim();
        const runIn = String(r.input ?? r.input_text ?? '').trim();
        if (!finalOut && !runIn) continue;
        if (finalOut === '(no Voice output)' && !runIn) continue;
        const sid = r.graph_session_id != null && String(r.graph_session_id).trim() ? String(r.graph_session_id).trim() : null;
        prCards.push({
          id: String(r.id || ''),
          at: dateMs(r.created_date),
          runInput: runIn || '(empty)',
          finalOut: finalOut && finalOut !== '(no Voice output)' ? finalOut : '',
          sid,
          hrefWorkspace: sid ? graphPipelineWorkspaceHref(sid) : '/graph-pipeline',
        });
      }
      prCards.sort((a, b) => b.at - a.at);
      setPipelineRunCards(narrow ? prCards.slice(0, MAX_OTHER_CARDS_MOBILE) : prCards);

      const cu = [];
      for (const c of curios || []) {
        const question = String(c.question || '').trim();
        const resolution = String(c.resolution || '').trim();
        const thRaw = String(c.pursuit_thread || '').trim();
        const voicePrimary = resolution || thRaw;
        const threadExtra = resolution && thRaw ? pursuitThreadExtra(resolution, thRaw) : '';
        if (!question && !voicePrimary) continue;
        const id = String(c.id || '').trim();
        if (!id) continue;
        cu.push({
          id,
          at: dateMs(c.updated_date || c.created_date),
          question: question || '(no question)',
          voicePrimary,
          threadExtra,
          hrefQueue: `${curBase}?focus=${encodeURIComponent(id)}`,
        });
      }
      cu.sort((a, b) => b.at - a.at);
      setCuriosityCards(narrow ? cu.slice(0, MAX_OTHER_CARDS_MOBILE) : cu);

      const go = [];
      for (const g of goals || []) {
        const statement = String(g.goal_statement || '').trim();
        const resolution = String(g.resolution || '').trim();
        const thRaw = String(g.pursuit_thread || '').trim();
        const voicePrimary = resolution || thRaw;
        const threadExtra = resolution && thRaw ? pursuitThreadExtra(resolution, thRaw) : '';
        if (!statement && !voicePrimary) continue;
        const id = String(g.id || '').trim();
        if (!id) continue;
        go.push({
          id,
          at: dateMs(g.updated_date || g.created_date),
          statement: statement || '(no goal statement)',
          voicePrimary,
          threadExtra,
          hrefQueue: `${goalBase}?focus=${encodeURIComponent(id)}`,
        });
      }
      go.sort((a, b) => b.at - a.at);
      setGoalCards(narrow ? go.slice(0, MAX_OTHER_CARDS_MOBILE) : go);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setChatGroups([]);
      setPipelineRunCards([]);
      setCuriosityCards([]);
      setGoalCards([]);
    } finally {
      setLoading(false);
    }
  }, [ConversationMessage, PipelineRun, CuriosityItem, GoalItem, curBase, goalBase]);

  loadRef.current = load;

  useEffect(() => {
    void load();
  }, [load]);

  /** Debounce: pipeline emits many writes; full reload each time can freeze mobile WebKit. */
  useEffect(() => {
    let t = 0;
    const onMind = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        void Promise.resolve(loadRef.current()).catch((e) => console.warn('[Voice] refresh', e));
      }, 500);
    };
    window.addEventListener(MIND_STORAGE_CHANGED, onMind);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener(MIND_STORAGE_CHANGED, onMind);
    };
  }, []);

  useEffect(() => {
    if (loading || chatGroups.length === 0) return;
    const smooth = typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;
    const id = window.requestAnimationFrame(() => {
      try {
        chatEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' });
      } catch {
        /* iOS nested scroll: scrollIntoView can throw */
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [loading, chatGroups]);

  const hasChat = chatGroups.some((g) => g.messages.length > 0);
  const hasOther = pipelineRunCards.length > 0 || curiosityCards.length > 0 || goalCards.length > 0;
  const hasAnything = hasChat || hasOther;

  const stamp = (at) => (at ? moment(at).format('lll') : '—');

  return (
    <PageShell
      icon={Mic}
      title="Voice"
      description="Pipeline graph chat (Input / Voice), then saved run I/O, curiosity pursuits, and goals — each as input vs output. Links open the Curiosity or Goals queue with that row focused. Primary vs System B use separate stores."
      actions={
        <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          Refresh
        </Button>
      }
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <MindScopeTabs />
          {isMirror ? (
            <span className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
              System B mirror store
            </span>
          ) : null}
        </div>

        {error ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>
        ) : null}

        {loading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
            <p className="text-sm">Loading Voice…</p>
          </div>
        ) : !hasAnything ? (
          <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-8 text-center">
            <MessageSquare className="mx-auto h-10 w-10 text-muted-foreground opacity-50" aria-hidden />
            <p className="mt-3 font-medium text-foreground">No saved Voice yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Chat in Graph Pipeline, save runs, or pursue curiosity/goals — content appears here.
            </p>
            <Link
              to="/graph-pipeline"
              className="mt-4 inline-flex text-sm font-medium text-primary underline-offset-2 hover:underline"
            >
              Open Graph Pipeline
            </Link>
          </div>
        ) : (
          <>
            {hasChat ? (
              <section className="space-y-8" aria-label="Pipeline chat log">
                {chatGroups.map((group, gi) => {
                  const href = group.sessionId ? graphPipelineWorkspaceHref(group.sessionId) : '/graph-pipeline';
                  return (
                    <div key={group.sessionKey} className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 pb-2">
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Graph session</p>
                          <p className="font-mono text-xs text-foreground/90">{shortSessionLabel(group.sessionId)}</p>
                        </div>
                        <Link to={href} className="text-xs font-medium text-primary underline-offset-2 hover:underline">
                          Open workspace
                        </Link>
                      </div>

                      <div
                        className={cn(
                          'max-h-[min(70svh,560px)] space-y-3 overflow-y-auto rounded-xl border border-border/80 bg-muted/15 p-3 sm:p-4',
                          '[-webkit-overflow-scrolling:touch]'
                        )}
                      >
                        {group.messages.map((msg) => {
                          const isUser = String(msg.role || '').toLowerCase() === 'user';
                          const isAssistant = String(msg.role || '').toLowerCase() === 'assistant';
                          return (
                            <div
                              key={msg.id}
                              className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}
                            >
                              <div
                                className={cn(
                                  'max-w-[min(100%,28rem)] rounded-xl px-3 py-2.5 shadow-sm',
                                  isUser && 'bg-primary/15 text-foreground',
                                  isAssistant && 'border border-border bg-card text-foreground',
                                  !isUser && !isAssistant && 'border border-dashed border-border bg-muted/30 text-foreground'
                                )}
                              >
                                <div className="mb-1 flex items-center justify-between gap-3">
                                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    {roleLabel(msg.role)}
                                  </span>
                                  <span className="text-[10px] tabular-nums text-muted-foreground">
                                    {msg.at ? moment(msg.at).format('lll') : '—'}
                                  </span>
                                </div>
                                <pre className="m-0 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground/95">
                                  {truncate(msg.content, Math.min(8000, textLimit * 2))}
                                </pre>
                              </div>
                            </div>
                          );
                        })}
                        {gi === chatGroups.length - 1 ? (
                          <div ref={chatEndRef} className="h-px w-full shrink-0" aria-hidden />
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </section>
            ) : (
              <p className="rounded-lg border border-dashed border-border bg-muted/10 px-4 py-3 text-sm text-muted-foreground">
                No pipeline chat rows in this store yet. Runs and pursuits may still appear below.
              </p>
            )}

            {hasOther ? (
              <div className="space-y-4">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Other saved Voice</h2>

                {curiosityCards.length > 0 ? (
                  <details
                    className="group rounded-xl border border-border bg-card/40"
                    open={curiositySectionOpen}
                    onToggle={(e) => setCuriositySectionOpen(e.currentTarget.open)}
                  >
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-foreground marker:content-none [&::-webkit-details-marker]:hidden">
                      <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
                      Curiosity pursuits ({curiosityCards.length})
                    </summary>
                    <div className="space-y-6 border-t border-border/60 px-4 py-4">
                      {curiosityCards.map((row) => (
                        <div key={row.id} className="space-y-3 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.06] p-3 sm:p-4">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
                            <span className="font-semibold uppercase tracking-wider text-cyan-800 dark:text-cyan-300">
                              Curiosity
                            </span>
                            <span className="tabular-nums">{stamp(row.at)}</span>
                          </div>
                          <div
                            className={cn(
                              'max-h-[min(52svh,380px)] space-y-3 overflow-y-auto rounded-lg border border-border/60 bg-background/50 p-3',
                              '[-webkit-overflow-scrolling:touch]'
                            )}
                          >
                            <ChatBubble align="right" label="Question" stamp={stamp(row.at)}>
                              {truncate(row.question, textLimit)}
                            </ChatBubble>
                            <ChatBubble align="left" label="Resolution (Voice)" stamp={stamp(row.at)}>
                              {row.voicePrimary ? truncate(row.voicePrimary, textLimit) : '—'}
                            </ChatBubble>
                            {row.threadExtra ? (
                              <ChatBubble align="left" label="Pursuit thread" stamp={stamp(row.at)}>
                                {truncate(row.threadExtra, textLimit)}
                              </ChatBubble>
                            ) : null}
                          </div>
                          <Link
                            to={row.hrefQueue}
                            className="inline-block text-xs font-medium text-primary underline-offset-2 hover:underline"
                          >
                            Open in Curiosity queue
                          </Link>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}

                {goalCards.length > 0 ? (
                  <details
                    className="group rounded-xl border border-border bg-card/40"
                    open={goalsSectionOpen}
                    onToggle={(e) => setGoalsSectionOpen(e.currentTarget.open)}
                  >
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-foreground marker:content-none [&::-webkit-details-marker]:hidden">
                      <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
                      Goals ({goalCards.length})
                    </summary>
                    <div className="space-y-6 border-t border-border/60 px-4 py-4">
                      {goalCards.map((row) => (
                        <div key={row.id} className="space-y-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3 sm:p-4">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
                            <span className="font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">Goal</span>
                            <span className="tabular-nums">{stamp(row.at)}</span>
                          </div>
                          <div
                            className={cn(
                              'max-h-[min(52svh,380px)] space-y-3 overflow-y-auto rounded-lg border border-border/60 bg-background/50 p-3',
                              '[-webkit-overflow-scrolling:touch]'
                            )}
                          >
                            <ChatBubble align="right" label="Goal" stamp={stamp(row.at)}>
                              {truncate(row.statement, textLimit)}
                            </ChatBubble>
                            <ChatBubble align="left" label="Resolution (Voice)" stamp={stamp(row.at)}>
                              {row.voicePrimary ? truncate(row.voicePrimary, textLimit) : '—'}
                            </ChatBubble>
                            {row.threadExtra ? (
                              <ChatBubble align="left" label="Pursuit thread" stamp={stamp(row.at)}>
                                {truncate(row.threadExtra, textLimit)}
                              </ChatBubble>
                            ) : null}
                          </div>
                          <Link
                            to={row.hrefQueue}
                            className="inline-block text-xs font-medium text-primary underline-offset-2 hover:underline"
                          >
                            Open in Goals queue
                          </Link>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}

                {pipelineRunCards.length > 0 ? (
                  <details
                    className="group rounded-xl border border-border bg-card/40"
                    open={runsSectionOpen}
                    onToggle={(e) => setRunsSectionOpen(e.currentTarget.open)}
                  >
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-foreground marker:content-none [&::-webkit-details-marker]:hidden">
                      <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
                      Pipeline runs ({pipelineRunCards.length})
                    </summary>
                    <div className="space-y-6 border-t border-border/60 px-4 py-4">
                      {pipelineRunCards.map((row) => (
                        <div key={row.id} className="space-y-3 rounded-xl border border-violet-500/20 bg-violet-500/[0.06] p-3 sm:p-4">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
                            <span className="font-semibold uppercase tracking-wider text-violet-800 dark:text-violet-300">
                              Saved run
                            </span>
                            <span className="tabular-nums">{stamp(row.at)}</span>
                          </div>
                          <div
                            className={cn(
                              'max-h-[min(52svh,380px)] space-y-3 overflow-y-auto rounded-lg border border-border/60 bg-background/50 p-3',
                              '[-webkit-overflow-scrolling:touch]'
                            )}
                          >
                            <ChatBubble align="right" label="Input" stamp={stamp(row.at)}>
                              {truncate(row.runInput, textLimit)}
                            </ChatBubble>
                            <ChatBubble align="left" label="Voice (final)" stamp={stamp(row.at)}>
                              {row.finalOut ? truncate(row.finalOut, textLimit) : '—'}
                            </ChatBubble>
                          </div>
                          <div className="flex flex-wrap gap-3">
                            <Link
                              to={row.hrefWorkspace}
                              className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                            >
                              Open graph workspace{row.sid ? ` · ${shortSessionLabel(row.sid)}` : ''}
                            </Link>
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </PageShell>
  );
}
