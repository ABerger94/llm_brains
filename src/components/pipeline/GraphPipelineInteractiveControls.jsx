import { useEffect, useState, useSyncExternalStore } from 'react';
import { ChevronDown, Loader2, Send, Settings2 } from 'lucide-react';
import { Button, Input } from '../ui';
import FileAttachButton from './FileAttachButton';
import { cn } from '../../lib/utils';
import {
  subscribeConsciousnessStream,
  consciousnessStreamStore,
  hydrateConsciousnessStreamFromDb,
} from '../../lib/consciousnessStreamStore';
import { startConsciousnessStreamRun } from '../../lib/consciousnessStreamRunner';
import {
  resolveGraphSessionMindStorageProfile,
} from '../../lib/graphSessionMindProfile';
import { normalizeScheduledTaskMindStorageProfile } from '../../lib/mindEntityContext';
import { conversationEntityForPlaygroundSession } from '../../lib/playgroundDualMind';
import { conversationToStreamEntries } from '../../lib/conversationStreamEntries';
import { filterConversationRowsForGraphSession } from '../../lib/graphPipelineConversation';
import { ConversationMessage } from '../../lib/data';
import { MIND_PHASE_OPTIONS } from '../../lib/mindPersistence';
import GraphPipelineMetacognitionLimitsRow from './GraphPipelineMetacognitionLimitsRow';
import GraphPipelineStreamResumeBanners from './GraphPipelineStreamResumeBanners';

export default function GraphPipelineInteractiveControls({
  graphSessionId,
  hideResumeBanners = false,
  mindStorageProfileForRun,
  mirrorWorkspace = false,
}) {
  const snap = useSyncExternalStore(
    subscribeConsciousnessStream,
    () => consciousnessStreamStore.getState(),
    () => consciousnessStreamStore.getState()
  );

  const {
    input,
    attachments,
    isProcessing,
    mindPhase,
    arousal,
    streamIntent,
    dbHydrated,
  } = snap;

  const [pendingFiles, setPendingFiles] = useState([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const streamLocksUi = isProcessing;
  const sid = graphSessionId != null && String(graphSessionId).trim() ? String(graphSessionId).trim() : '';
  const resolvedMindProfile =
    mindStorageProfileForRun != null && mindStorageProfileForRun !== ''
      ? normalizeScheduledTaskMindStorageProfile(mindStorageProfileForRun)
      : resolveGraphSessionMindStorageProfile(sid || undefined);

  useEffect(() => {
    if (graphSessionId == null || !String(graphSessionId).trim()) return;
    const sidInner = String(graphSessionId).trim();
    let cancelled = false;
    (async () => {
      const Conv = sidInner ? conversationEntityForPlaygroundSession(sidInner) : ConversationMessage;
      const rows = await Conv.list('-created_date', 320);
      if (cancelled) return;
      const filtered = filterConversationRowsForGraphSession(rows, sidInner);
      const s = consciousnessStreamStore.getState();
      if (s.isProcessing) return;
      hydrateConsciousnessStreamFromDb(conversationToStreamEntries(filtered), {
        conversationRows: filtered,
        force: true,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [graphSessionId]);

  const runStream = async () => {
    if (isProcessing) return;
    if (!input.trim() && pendingFiles.length === 0 && attachments.length === 0) return;
    const files = [...pendingFiles];
    setPendingFiles([]);
    await startConsciousnessStreamRun({
      pendingFiles: files,
      mindStorageProfile: resolvedMindProfile,
      ...(sid ? { graphSessionIdForPersistence: sid } : {}),
    });
  };

  return (
    <>
      {!hideResumeBanners ? (
        <GraphPipelineStreamResumeBanners
          graphSessionId={sid}
          mindStorageProfileOverride={mindStorageProfileForRun}
        />
      ) : null}

      {/* Collapsible run settings */}
      <div
        className={cn(
          'shrink-0 border-b',
          mirrorWorkspace
            ? 'border-red-500/40 bg-background shadow-[inset_4px_0_0_0_rgba(239,68,68,0.35)]'
            : 'border-border/70'
        )}
      >
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground transition-colors',
            mirrorWorkspace ? 'hover:bg-red-500/5 dark:hover:bg-red-950/20' : 'hover:bg-muted/20'
          )}
          onClick={() => setSettingsOpen((v) => !v)}
          aria-expanded={settingsOpen}
        >
          <Settings2 className="h-3.5 w-3.5" aria-hidden />
          <span className="font-medium">Run settings</span>
          <span className="ml-1 flex items-center gap-2 text-[11px]">
            <span className="rounded bg-muted px-1.5 py-0.5">{MIND_PHASE_OPTIONS.find((p) => p.id === mindPhase)?.label || mindPhase}</span>
            {streamIntent ? <span className="truncate text-muted-foreground/70">intent: {streamIntent}</span> : null}
          </span>
          <ChevronDown className={cn('ml-auto h-3.5 w-3.5 transition-transform', settingsOpen && 'rotate-180')} aria-hidden />
        </button>
        {settingsOpen ? (
          <div
            className={cn(
              'space-y-2 border-t px-4 py-2.5',
              mirrorWorkspace
                ? 'border-red-500/30 bg-muted/10 shadow-[inset_4px_0_0_0_rgba(239,68,68,0.2)]'
                : 'border-border/50 bg-muted/5'
            )}
          >
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="font-medium">Phase</span>
                <select
                  value={mindPhase}
                  onChange={(e) => consciousnessStreamStore.setState({ mindPhase: e.target.value })}
                  disabled={streamLocksUi}
                  className="h-7 rounded border border-input bg-background px-2 text-xs"
                >
                  {MIND_PHASE_OPTIONS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </label>
              <div
                className="flex items-center gap-2"
                title="Arousal tracks the model's internal state during runs (read-only)."
              >
                <span className="text-xs font-medium text-muted-foreground">Arousal</span>
                <div className="relative h-2 w-20 overflow-hidden rounded-full border border-border/80 bg-muted/50">
                  <div
                    className={cn(
                      'h-full rounded-full bg-gradient-to-r from-violet-500/70 transition-[width] duration-300 ease-out',
                      mirrorWorkspace ? 'to-red-500/80' : 'to-rose-500/80'
                    )}
                    style={{ width: `${Math.min(100, Math.max(0, Number(arousal) || 0) * 100)}%` }}
                  />
                </div>
                <span className="w-8 tabular-nums text-xs text-muted-foreground">{Number(arousal).toFixed(2)}</span>
              </div>
              <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
                <span className="shrink-0 font-medium">Intent</span>
                <Input
                  value={streamIntent}
                  onChange={(e) => consciousnessStreamStore.setState({ streamIntent: e.target.value })}
                  placeholder="Optional"
                  className="h-7 min-w-[100px] flex-1 bg-background text-xs"
                  disabled={streamLocksUi}
                />
              </label>
            </div>
            <GraphPipelineMetacognitionLimitsRow className="" />
          </div>
        ) : null}
      </div>

      {/* Composer */}
      <div
        className={cn(
          'shrink-0 border-t px-4 py-3 shadow-[0_-1px_3px_rgba(0,0,0,0.06)]',
          mirrorWorkspace
            ? 'border-red-500/40 bg-background shadow-[inset_4px_0_0_0_rgba(239,68,68,0.35)]'
            : 'border-border bg-background'
        )}
        data-graph-composer-mind={mirrorWorkspace ? 'mirror' : 'primary'}
      >
        <div className="flex items-center gap-2">
          <FileAttachButton
            pendingFiles={pendingFiles}
            onPendingFilesChange={setPendingFiles}
            attachments={attachments}
            onRemoveAttachment={(id) =>
              consciousnessStreamStore.setState({
                attachments: consciousnessStreamStore.getState().attachments.filter((a) => a.id !== id),
              })
            }
            disabled={streamLocksUi}
          />
          <Input
            value={input}
            onChange={(e) => consciousnessStreamStore.setState({ input: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void runStream();
              }
            }}
            placeholder="Enter a thought, question, or scenario\u2026"
            className="h-10 min-w-[120px] flex-1 bg-muted/20 text-sm"
            disabled={streamLocksUi}
          />
          <Button
            type="button"
            size="icon"
            className="h-10 w-10"
            disabled={
              streamLocksUi || (!input.trim() && pendingFiles.length === 0 && attachments.length === 0)
            }
            onClick={() => void runStream()}
          >
            {streamLocksUi ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        {!dbHydrated ? (
          <p className="mt-2 text-xs text-muted-foreground">Loading conversation prefs\u2026</p>
        ) : null}
      </div>
    </>
  );
}
