import { useCallback, useEffect, useMemo, useState, memo } from 'react';
import { Link } from 'react-router-dom';
import moment from 'moment';
import { FileSearch, Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { Button, Input, Label } from '../components/ui';
import { PipelineRun, ConversationMessage } from '../lib/data';
import { useMindStorageRefresh } from '../lib/mindStorageEvents';
import { cn } from '../lib/utils';
import {
  buildConversationMessageDisplayDocument,
  buildPipelineRunDisplayDocument,
  blobMatchesAllTerms,
  parseSearchTerms,
  segmentFullTextWithHighlights,
} from '../lib/pipelineOutputSearch';

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

function Panel({ className, children }) {
  return <div className={cn('rounded-2xl border border-border bg-card p-4', className)}>{children}</div>;
}

function EmptyState({ title, description }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-6 text-center">
      <div className="font-medium">{title}</div>
      <div className="mt-1 text-sm text-muted-foreground">{description}</div>
    </div>
  );
}

function formatRelative(value) {
  return value ? moment(value).fromNow() : '';
}

const FullContextPanel = memo(function FullContextPanel({ text, termsLower }) {
  const segments = useMemo(() => segmentFullTextWithHighlights(text, termsLower), [text, termsLower]);
  return (
    <div className="mt-3 max-h-[min(75vh,960px)] overflow-auto rounded-lg border border-border bg-muted/30 p-3">
      <pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90">
        {segments.map((s, i) =>
          s.type === 'hit' ? (
            <mark key={i} className="rounded bg-primary/25 px-0.5 text-foreground">
              {s.value}
            </mark>
          ) : (
            <span key={i}>{s.value}</span>
          )
        )}
      </pre>
    </div>
  );
});

const DEBOUNCE_MS = 220;

export default function PipelineOutputSearchPage() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [includeChat, setIncludeChat] = useState(true);
  const [loading, setLoading] = useState(true);
  const [runs, setRuns] = useState([]);
  const [messages, setMessages] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [allRuns, allMsgs] = await Promise.all([
        PipelineRun.listAll('-created_date'),
        ConversationMessage.listAll('-created_date'),
      ]);
      setRuns(allRuns);
      setMessages(allMsgs.filter((m) => m.role === 'assistant'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useMindStorageRefresh(load);

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  const termsLower = useMemo(() => parseSearchTerms(debouncedQuery), [debouncedQuery]);

  const indexedRuns = useMemo(
    () =>
      runs.map((run) => {
        const doc = buildPipelineRunDisplayDocument(run);
        return { run, doc, lower: doc.toLowerCase() };
      }),
    [runs]
  );

  const indexedMessages = useMemo(
    () =>
      messages.map((msg) => {
        const doc = buildConversationMessageDisplayDocument(msg);
        return { msg, doc, lower: doc.toLowerCase() };
      }),
    [messages]
  );

  const matches = useMemo(() => {
    if (!termsLower.length) return [];
    const out = [];
    for (const row of indexedRuns) {
      if (blobMatchesAllTerms(row.lower, termsLower)) {
        out.push({
          kind: 'run',
          id: row.run.id,
          created: row.run.created_date,
          title: String(row.run.input || row.run.input_text || 'Untitled').slice(0, 120),
          fullContext: row.doc,
        });
      }
    }
    if (includeChat) {
      for (const row of indexedMessages) {
        if (blobMatchesAllTerms(row.lower, termsLower)) {
          out.push({
            kind: 'assistant_message',
            id: row.msg.id,
            created: row.msg.created_date,
            title: 'Assistant (transcript)',
            fullContext: row.doc,
          });
        }
      }
    }
    out.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
    return out;
  }, [indexedRuns, indexedMessages, termsLower, includeChat]);

  return (
    <PageShell
      icon={FileSearch}
      title="Output search"
      description="Search saved pipeline runs by keyword (separate words = AND). Each match shows the full structured context: input, voice line, module outputs, and shared memory (including globalWorkspace, webFindings, hypothesis fields when present). Optionally include Graph Pipeline assistant messages."
      actions={
        <Button variant="outline" className="gap-2" onClick={() => load()} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          Refresh
        </Button>
      }
    >
      <Panel className="mb-6 space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="output-search-q">Keywords</Label>
            <Input
              id="output-search-q"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. predictive self-aware"
              autoComplete="off"
              className="max-w-xl"
            />
            <p className="text-xs text-muted-foreground">
              Type multiple words — every word must appear somewhere in the combined output for a match.
            </p>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground/90">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={includeChat}
              onChange={(e) => setIncludeChat(e.target.checked)}
            />
            Include assistant chat messages
          </label>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading stored outputs…
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            Indexed <span className="font-medium text-foreground">{runs.length}</span> pipeline runs
            {includeChat ? (
              <>
                {' '}
                and <span className="font-medium text-foreground">{messages.length}</span> assistant messages
              </>
            ) : null}
            .
          </div>
        )}
      </Panel>

      {!loading && !termsLower.length ? (
        <EmptyState
          title="Enter a search"
          description="Your keywords will be matched against stored module outputs, final voice text, inputs, and shared memory fields."
        />
      ) : null}

      {!loading && termsLower.length ? (
        <Panel className="space-y-3">
          <div className="text-sm font-semibold">
            Matches{' '}
            <span className="font-normal text-muted-foreground">
              ({matches.length} {matches.length === 1 ? 'result' : 'results'})
            </span>
          </div>
          {matches.length === 0 ? (
            <EmptyState title="No matches" description="Try fewer or different keywords, or enable assistant messages." />
          ) : (
            <ul className="space-y-4">
              {matches.map((m) => (
                <li
                  key={`${m.kind}-${m.id}`}
                  className="rounded-xl border border-border bg-muted/10 p-4 transition-colors hover:bg-muted/20"
                >
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    {m.kind === 'run' ? (
                      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 font-medium text-foreground/80">
                        <FileSearch className="h-3 w-3" />
                        Pipeline run
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 font-medium text-foreground/80">
                        <MessageSquare className="h-3 w-3" />
                        Chat
                      </span>
                    )}
                    <span>{formatRelative(m.created)}</span>
                    <span className="font-mono opacity-70">· {m.id.slice(-10)}</span>
                  </div>
                  <div className="mt-2 text-sm font-medium text-foreground">{m.title}</div>
                  <div className="mt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Full context
                  </div>
                  <FullContextPanel text={m.fullContext} termsLower={termsLower} />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {m.kind === 'run' ? (
                      <Link
                        to={`/shared-memory?run=${encodeURIComponent(m.id)}`}
                        className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent"
                      >
                        Open in Shared memory
                      </Link>
                    ) : (
                      <Link
                        to="/graph-pipeline"
                        className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent"
                      >
                        Graph Pipeline
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}
    </PageShell>
  );
}
