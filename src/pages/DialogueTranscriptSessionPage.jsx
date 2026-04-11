import { useCallback, useEffect, useState, useSyncExternalStore, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import moment from 'moment';
import { ArrowLeft, GitBranch, Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { Button } from '../components/ui';
import { ConversationMessage } from '../lib/data';
import { useMindStorageRefresh } from '../lib/mindStorageEvents';
import { cn } from '../lib/utils';
import {
  getGraphPipelineSessionRegistry,
  subscribeGraphPipelineRegistry,
} from '../lib/graphPipelineSessionRegistry';
import { filterConversationRowsForGraphSession } from '../lib/graphPipelineConversation';
import {
  pairUserVoiceForSession,
  labelForDialogueSession,
} from '../lib/dialogueTranscript';

const MESSAGE_CAP = 1200;

function PageShell({ icon: Icon, title, description, actions, children }) {
  return (
    <div className="min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15">
                <Icon className="h-5 w-5 text-primary" />
              </div>
              <h1 className="text-2xl font-bold">{title}</h1>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

export default function DialogueTranscriptSessionPage() {
  const { sessionId: rawSessionId } = useParams();
  const sessionId = useMemo(() => {
    try {
      return decodeURIComponent(String(rawSessionId || '').trim());
    } catch {
      return String(rawSessionId || '').trim();
    }
  }, [rawSessionId]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pairs, setPairs] = useState([]);

  const registry = useSyncExternalStore(
    subscribeGraphPipelineRegistry,
    getGraphPipelineSessionRegistry,
    getGraphPipelineSessionRegistry
  );

  const sessionLabel = useMemo(() => labelForDialogueSession(sessionId, registry), [sessionId, registry]);

  const hasSessionContent = pairs.length > 0;

  const enc = encodeURIComponent(sessionId);
  const hrefGp = `/graph-pipeline/${enc}`;

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const rows = await ConversationMessage.list('-created_date', MESSAGE_CAP);
      const inSession = filterConversationRowsForGraphSession(rows, sessionId);
      setPairs(pairUserVoiceForSession(inSession));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPairs([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useMindStorageRefresh(load);

  return (
    <PageShell
      icon={MessageSquare}
      title={sessionLabel}
      description="Your conversation turns with Voice for this graph pipeline session."
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
            All sessions
          </Link>
          <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </Button>
          <Link
            to={hrefGp}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground ring-offset-background transition-colors',
              'hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
            )}
          >
            <GitBranch className="h-4 w-4" />
            Open Graph Pipeline
          </Link>
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
      ) : !hasSessionContent ? (
        <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-8 text-center">
          <p className="font-medium">Nothing recorded for this session yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            No conversation rows or linked pursuits tagged with this graph session id.
          </p>
          <Link
            to={hrefGp}
            className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            <GitBranch className="h-4 w-4" />
            Open Graph Pipeline
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Conversation turns</div>

          {pairs.map((p, idx) => (
            <div
              key={`${p.userId}-${idx}`}
              className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
            >
              <div className="border-b border-border bg-muted/40 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Turn {idx + 1}{' '}
                <span className="font-normal normal-case text-muted-foreground/80">
                  · user {moment(p.userCreated).format('lll')}
                </span>
              </div>
              <div className="space-y-0">
                <div className="border-b border-border/60 px-4 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">You</div>
                  <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{p.userText || '—'}</div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
                    Voice
                  </div>
                  <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                    {p.voiceText != null && p.voiceText !== '' ? (
                      p.voiceText
                    ) : (
                      <span className="italic text-muted-foreground">(no Voice row for this turn)</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </PageShell>
  );
}
