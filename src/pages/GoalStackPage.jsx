import {
  useCallback,
  useEffect,
  forwardRef,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Layers,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Target,
  Trash2,
} from 'lucide-react';
import moment from 'moment';
import { Button, Textarea, toast } from '../components/ui';
import PursuitMetacognitionLimitsRow from '../components/pipeline/PursuitMetacognitionLimitsRow';
import PursuitPipelinePrepSelect from '../components/pipeline/PursuitPipelinePrepSelect';
import { ScheduledTask } from '../lib/data';
import { useMindScope, useScopedEntities } from '../context/MindScopeContext';
import MindScopeTabs from '../components/MindScopeTabs';
import { effectiveItemPriority, maxActiveClusterPriority } from '../lib/priorityUtils';
import { runGoalDeepPursuitChain, runGoalPursuitLlmOnly } from '../lib/goalPursuit';
import { isAbortError } from '../lib/dashboardAbortActivePipeline';
import { clearGoalPursuitGraphAbort, registerGoalPursuitGraphAbort } from '../lib/pursuitGraphPipelineAbortRegistry';
import {
  computeGoalPipelineMinimapSnapshot,
  freshPursuitPipelineUiForNewGraphRun,
  initialGoalPipelineUi,
  pursuitShowsLivePipelineChrome,
  reduceGoalPipelineSse,
} from '../lib/goalPipelineSseUi';
import NeuralNetworkViz from '../components/NeuralNetworkViz';
import {
  flushGoalPursuitsPersistNow,
  getGoalPagePursuitSnapshot,
  patchGoalPagePursuitEntry,
  removeGoalPursuit,
  subscribeGoalPagePursuit,
  updateGoalPagePursuitPipelineUiForId,
  upsertGoalPursuit,
} from '../lib/goalPagePursuitStore';
import { formatPursuitThreadProgressLine } from '../lib/pursuitThreadStatusFormat';
import {
  PIPELINE_LOG_EMPTY_IDLE,
  PIPELINE_LOG_EMPTY_RUNNING,
  PIPELINE_LOG_PURSUIT_OUTSIDE_TAB,
  PIPELINE_MINIMAP_STRIP_LABEL,
} from '../lib/activePipelineStatusLabels';
import { PipelineStageMinimap } from '../components/consciousness/PipelineStageMinimap';
import PipelineExecutionLogStatusLine from '../components/pipeline/PipelineExecutionLogStatusLine';
import { scheduleTask } from '../lib/schedulerStore';
import { normalizeScheduledTaskMindStorageProfile, MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR } from '../lib/mindEntityContext';
import {
  isCooperativePauseAllExternalHoldActive,
  setCooperativePauseAllExternalHold,
} from '../lib/cooperativePauseAllExternalHold';
import { flushSchedulerDueTasksNow } from '../lib/scheduledTaskRunner';
import {
  getInteractiveGraphOrStreamActivitySnapshot,
  subscribeInteractiveGraphOrStreamActivity,
} from '../lib/pipelineBusyGate';
import { finalizeNewGoalRoot } from '../lib/goalLineage';
import { goalUiStatus } from '../lib/goalQueueMetrics';
import { useMindStorageRefresh, notifyMindStorageChanged } from '../lib/mindStorageEvents';
import { getRuntimeSettings } from '../lib/runtimeSettings';
import { cn } from '../lib/utils';
import { COGNITIVE_MODULES, getFirstProcessingModuleId, getFirstProcessingModuleName } from '../lib/cognitiveModules';
import PageShell from '../components/PageShell';

/**
 * Mobile expanded goal pipeline must render above AppLayout’s sticky header (z-30); `main` is z-20 so
 * fixed descendants cannot win — portal to `document.body` with a higher z-index.
 */
const GoalPipelineMobilePortal = forwardRef(function GoalPipelineMobilePortal(
  { portal, className, children },
  ref
) {
  const el = (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
  return portal ? createPortal(el, document.body) : el;
});

function subscribeMaxWidthLg(listener) {
  const mq = window.matchMedia('(max-width: 1023px)');
  mq.addEventListener('change', listener);
  return () => mq.removeEventListener('change', listener);
}
function getMaxWidthLgSnapshot() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches;
}

function truncate(value, length = 220) {
  if (!value) return '';
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

const GOAL_QUESTION_FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'pursuing', label: 'Pursuing' },
  { value: 'resolved', label: 'Resolved' },
];

const GOAL_STATEMENT_PREVIEW_CHARS = 280;
const GOAL_STATEMENT_PREVIEW_CHARS_COMPACT = 160;
const GOAL_STATEMENT_PREVIEW_MAX_LINES = 4;
const GOAL_BODY_COLLAPSE_CHARS = 400;
const GOAL_BODY_MAX_LINES = 6;

function goalBodyIsLong(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return s.length > GOAL_BODY_COLLAPSE_CHARS || s.split(/\n/).length > GOAL_BODY_MAX_LINES;
}

function goalStatementIsLong(text, compact) {
  const s = String(text || '').trim();
  if (!s) return false;
  const cap = compact ? GOAL_STATEMENT_PREVIEW_CHARS_COMPACT : GOAL_STATEMENT_PREVIEW_CHARS;
  return s.length > cap || s.split(/\n/).length > GOAL_STATEMENT_PREVIEW_MAX_LINES;
}

/** Keeps the goal list scannable: short text inline, long statements behind expand (same pattern as Curiosity Queue). */
function GoalClampedStatement({ text, className, compact = false }) {
  const s = String(text || '').trim();
  const long = goalStatementIsLong(s, compact);
  const [expanded, setExpanded] = useState(false);
  if (!s) return null;
  const cap = compact ? GOAL_STATEMENT_PREVIEW_CHARS_COMPACT : GOAL_STATEMENT_PREVIEW_CHARS;
  if (!long) {
    return (
      <p
        className={cn(
          'whitespace-pre-wrap break-words leading-relaxed text-foreground',
          compact ? 'text-[11px] text-muted-foreground' : 'text-sm font-medium',
          className
        )}
      >
        {s}
      </p>
    );
  }
  const preview = `${s.slice(0, cap).trimEnd()}…`;
  return (
    <div className={className}>
      <p
        className={cn(
          'whitespace-pre-wrap break-words leading-relaxed text-foreground',
          compact ? 'text-[11px] text-muted-foreground' : 'text-sm font-medium'
        )}
      >
        {expanded ? s : preview}
      </p>
      <button
        type="button"
        className={cn(
          'mt-1 text-left text-xs font-medium text-primary hover:underline',
          compact && 'text-[10px]'
        )}
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? 'Show less' : 'Show full goal'}
      </button>
    </div>
  );
}

function GoalCollapsibleThread({ text }) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (!goalBodyIsLong(s)) {
    return (
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">{s}</p>
    );
  }
  return (
    <details className="mt-1 rounded-md border border-border/50 bg-muted/20">
      <summary className="cursor-pointer select-none px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/35">
        Pursuit thread <span className="font-normal opacity-70">· expand ({s.length} chars)</span>
      </summary>
      <div className="max-h-[min(45svh,24rem)] overflow-y-auto border-t border-border/40 px-2 py-2 text-xs leading-relaxed text-muted-foreground">
        <p className="whitespace-pre-wrap break-words">{s}</p>
      </div>
    </details>
  );
}

function GoalCollapsibleResolution({ text }) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (!goalBodyIsLong(s)) {
    return (
      <p className="mt-2 rounded-md border border-green-500/20 bg-green-500/10 p-2 text-xs leading-relaxed text-green-900 dark:text-green-300/95 whitespace-pre-wrap break-words">
        {s}
      </p>
    );
  }
  return (
    <details className="mt-2 overflow-hidden rounded-md border border-green-500/25 bg-green-500/10">
      <summary className="cursor-pointer select-none px-2 py-1.5 text-xs font-medium text-green-800 dark:text-green-300/90 hover:bg-green-500/15">
        Answer / reflection <span className="font-normal opacity-70">· expand ({s.length} chars)</span>
      </summary>
      <div className="max-h-[min(50svh,28rem)] overflow-y-auto border-t border-green-500/20 p-2 text-xs leading-relaxed text-green-900 dark:text-green-300/95">
        <p className="whitespace-pre-wrap break-words">{s}</p>
      </div>
    </details>
  );
}

function GoalCollapsibleLogDetail({ detail }) {
  const s = String(detail || '').trim();
  if (!s) return null;
  if (!goalBodyIsLong(s)) {
    return (
      <pre className="mt-1 whitespace-pre-wrap break-words border-l-2 border-primary/25 pl-2 text-[11px] text-muted-foreground/90">
        {s}
      </pre>
    );
  }
  return (
    <details className="mt-1 border-l-2 border-primary/25 pl-2">
      <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground hover:text-foreground/80">
        Module output · expand ({s.length} chars)
      </summary>
      <pre className="mt-1 max-h-[min(36svh,18rem)] overflow-y-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground/90">
        {s}
      </pre>
    </details>
  );
}

function Panel({ className, children }) {
  return <div className={cn('rounded-2xl border border-border bg-card p-4', className)}>{children}</div>;
}

const GOAL_STATUS_STYLES = {
  open: 'border-sky-500/30 bg-sky-500/5 text-sky-900 dark:text-sky-300',
  pursuing: 'border-primary/30 bg-primary/5 text-primary',
  resolved: 'border-green-500/30 bg-green-500/5 text-green-800 dark:text-green-400',
  dormant: 'border-border bg-muted/20 text-muted-foreground',
};

function goalClusterHasActivePursuit(clusterItems, pursuitsState) {
  return (Array.isArray(clusterItems) ? clusterItems : []).some(
    (i) => pursuitsState[String(i.id)]?.running === true
  );
}

function goalPipelineActiveModuleId(moduleStatuses) {
  return getFirstProcessingModuleId(moduleStatuses);
}

function fallbackGoalPursuitEntryFromItems(goalId, itemList) {
  const item = itemList.find((i) => String(i.id) === String(goalId));
  return {
    pursuitProgress: null,
    goalPipelineUi: initialGoalPipelineUi(),
    running: false,
    goalStatement: String(item?.goal_statement || '').trim() || undefined,
  };
}

export function GoalStackPage() {
  const { isMirror, profile: mindStorageProfile } = useMindScope();
  const { GoalItem } = useScopedEntities();
  const [searchParams, setSearchParams] = useSearchParams();
  const dashboardFocusConsumedRef = useRef(null);
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [addingGoal, setAddingGoal] = useState(false);
  const { pursuits } = useSyncExternalStore(
    subscribeGoalPagePursuit,
    getGoalPagePursuitSnapshot,
    getGoalPagePursuitSnapshot
  );
  /** Only this tab's page store drives the pipeline carousel (avoids orphaned DB `pursuing` after reload). */
  const pursuitIds = useMemo(() => Object.keys(pursuits), [pursuits]);
  const anyPursuitRunning = useMemo(
    () => Object.values(pursuits).some((p) => p.running),
    [pursuits]
  );
  const pageSystemAccent = isMirror ? 'b' : 'a';
  const entryAccent = (entry) =>
    entry?.mindStorageProfile === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR ? 'b' : 'a';
  const [pipelineCarouselIndex, setPipelineCarouselIndex] = useState(0);
  const goalPipelineLogRef = useRef(null);
  const goalPipelinePanelRef = useRef(null);
  const goalPipelineCarouselRef = useRef(null);
  const prevAnyPursuitRunningRef = useRef(false);
  const prevPursuitCountRef = useRef(0);
  /** Synchronous guard so two rapid clicks cannot start two goal thread batches before React re-renders. */
  const threadGroupPursueLockedRef = useRef(false);
  /** Which cluster root id is running a batch (null = idle); drives Pursue thread button spinners. */
  const [threadGroupPursueRootId, setThreadGroupPursueRootId] = useState(null);
  const interactiveGraphOrStreamBusy = useSyncExternalStore(
    subscribeInteractiveGraphOrStreamActivity,
    getInteractiveGraphOrStreamActivitySnapshot,
    getInteractiveGraphOrStreamActivitySnapshot
  );
  /** Mobile: goal pipeline stays a bottom strip until expanded; do not auto-open when visiting this page. */
  const [goalMobileSheetExpanded, setGoalMobileSheetExpanded] = useState(false);
  const isMaxLg = useSyncExternalStore(subscribeMaxWidthLg, getMaxWidthLgSnapshot, () => false);
  /** When true, fullscreen panel is portaled so it stacks above the app chrome (see GoalPipelineMobilePortal). */
  const portalMobileGoalPipeline = goalMobileSheetExpanded && isMaxLg;
  /** Desktop only: execution log starts collapsed so the pipeline panel does not dominate the page. */
  const [goalDesktopLogExpanded, setGoalDesktopLogExpanded] = useState(false);
  const [goalQuestionFilter, setGoalQuestionFilter] = useState('open');
  const cognitiveModuleCount = useMemo(() => COGNITIVE_MODULES.length, []);

  const activePursuitId = pursuitIds[pipelineCarouselIndex] ?? null;
  const activePursuit = useMemo(() => {
    if (!activePursuitId) return null;
    return pursuits[activePursuitId] ?? fallbackGoalPursuitEntryFromItems(activePursuitId, items);
  }, [activePursuitId, pursuits, items]);
  const activeGoalPipelineUi = useMemo(() => {
    if (!activePursuit) return null;
    const raw = activePursuit.goalPipelineUi;
    if (pursuitShowsLivePipelineChrome(activePursuit)) return raw;
    return freshPursuitPipelineUiForNewGraphRun(raw);
  }, [activePursuit]);
  const activePursuitProgress = activePursuit?.pursuitProgress ?? null;

  const interruptedResumeGoalItem = useMemo(
    () => (activePursuitId ? items.find((i) => String(i.id) === String(activePursuitId)) : null),
    [activePursuitId, items]
  );

  const onGoalPipelineSse = useCallback((goalId, evt) => {
    updateGoalPagePursuitPipelineUiForId(goalId, (prev) => reduceGoalPipelineSse(prev, evt));
  }, []);

  useEffect(() => {
    if (!portalMobileGoalPipeline) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [portalMobileGoalPipeline]);

  useLayoutEffect(() => {
    const el = goalPipelineLogRef.current;
    if (!el || !activeGoalPipelineUi) return;
    el.scrollTop = el.scrollHeight;
  }, [activePursuitId, activeGoalPipelineUi?.executionLog]);

  const scrollPipelineCarouselToIndex = useCallback((index) => {
    const el = goalPipelineCarouselRef.current;
    if (!el) return;
    const w = el.clientWidth;
    if (w <= 0) return;
    el.scrollTo({ left: index * w, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const n = pursuitIds.length;
    setPipelineCarouselIndex((i) => (n === 0 ? 0 : Math.min(i, n - 1)));
    if (n > prevPursuitCountRef.current) {
      const next = n - 1;
      setPipelineCarouselIndex(next);
      requestAnimationFrame(() => scrollPipelineCarouselToIndex(next));
    }
    prevPursuitCountRef.current = n;
  }, [pursuitIds.length, scrollPipelineCarouselToIndex]);

  const handlePipelineCarouselScroll = useCallback(() => {
    const el = goalPipelineCarouselRef.current;
    if (!el) return;
    const w = el.clientWidth;
    if (w <= 0) return;
    const max = pursuitIds.length - 1;
    if (max < 0) return;
    const i = Math.round(el.scrollLeft / w);
    const clamped = Math.max(0, Math.min(i, max));
    setPipelineCarouselIndex((prev) => (prev === clamped ? prev : clamped));
  }, [pursuitIds.length]);

  useLayoutEffect(() => {
    const raw = searchParams.get('focus');
    if (!raw) {
      dashboardFocusConsumedRef.current = null;
      return;
    }
    if (loading) return;
    const focusId = String(raw).trim();
    if (!focusId) {
      setSearchParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.delete('focus');
          return n;
        },
        { replace: true }
      );
      return;
    }
    const exists = items.some((i) => String(i.id) === focusId);
    if (!exists) {
      setSearchParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.delete('focus');
          return n;
        },
        { replace: true }
      );
      return;
    }

    const idx = pursuitIds.indexOf(focusId);
    if (idx < 0) {
      const snap = getGoalPagePursuitSnapshot();
      if (!snap.pursuits[focusId]) {
        const item = items.find((i) => String(i.id) === focusId);
        if (item) {
          upsertGoalPursuit(focusId, {
            running: false,
            interruptedByReload: false,
            pursuitProgress: null,
            goalPipelineUi: initialGoalPipelineUi(),
            goalStatement: String(item.goal_statement || '').trim() || undefined,
            mindStorageProfile,
          });
        }
      }
      if (dashboardFocusConsumedRef.current === focusId) return;
      dashboardFocusConsumedRef.current = focusId;
      setGoalMobileSheetExpanded(true);
      requestAnimationFrame(() => {
        document.getElementById(`goal-focus-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      setSearchParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.delete('focus');
          return n;
        },
        { replace: true }
      );
      return;
    }

    if (dashboardFocusConsumedRef.current === focusId) return;
    dashboardFocusConsumedRef.current = focusId;

    setGoalMobileSheetExpanded(true);
    setGoalDesktopLogExpanded(true);

    setPipelineCarouselIndex(idx);
    requestAnimationFrame(() => {
      scrollPipelineCarouselToIndex(idx);
      goalPipelinePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    requestAnimationFrame(() => {
      document.getElementById(`goal-focus-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    setSearchParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.delete('focus');
        return n;
      },
      { replace: true }
    );
  }, [loading, items, searchParams, pursuitIds, setSearchParams, scrollPipelineCarouselToIndex]);

  useEffect(() => {
    const root = goalPipelineCarouselRef.current;
    if (!root || pursuitIds.length < 2) return undefined;

    let touchStartX = 0;
    let touchStartY = 0;
    let scrollLeftAtStart = 0;
    /** @type {'undecided' | 'h' | 'v'} */
    let mode = 'undecided';

    const end = () => {
      mode = 'undecided';
      requestAnimationFrame(() => handlePipelineCarouselScroll());
    };

    const onTouchStart = (e) => {
      if (e.touches.length !== 1) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      scrollLeftAtStart = root.scrollLeft;
      mode = 'undecided';
    };

    const onTouchMove = (e) => {
      if (e.touches.length !== 1 || mode === 'v') return;
      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      const dx = x - touchStartX;
      const dy = y - touchStartY;

      if (mode === 'undecided') {
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        if (ax > 10 || ay > 10) {
          if (ax > ay * 1.15) mode = 'h';
          else mode = 'v';
        }
      }

      if (mode === 'h') {
        e.preventDefault();
        root.scrollLeft = scrollLeftAtStart - dx;
      }
    };

    const cap = { capture: true };
    root.addEventListener('touchstart', onTouchStart, { ...cap, passive: true });
    root.addEventListener('touchmove', onTouchMove, { ...cap, passive: false });
    root.addEventListener('touchend', end, cap);
    root.addEventListener('touchcancel', end, cap);

    return () => {
      root.removeEventListener('touchstart', onTouchStart, cap);
      root.removeEventListener('touchmove', onTouchMove, cap);
      root.removeEventListener('touchend', end, cap);
      root.removeEventListener('touchcancel', end, cap);
    };
  }, [pursuitIds.length, handlePipelineCarouselScroll]);

  useLayoutEffect(() => {
    if (anyPursuitRunning && !prevAnyPursuitRunningRef.current) {
      if (typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches) {
        goalPipelinePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
    prevAnyPursuitRunningRef.current = anyPursuitRunning;
  }, [anyPursuitRunning]);

  const scheduleBlocked = interactiveGraphOrStreamBusy || anyPursuitRunning;

  const load = useCallback(async () => {
    setLoading(true);
    const raw = await GoalItem.listAll('-created_date');
    const sorted = [...raw].sort((a, b) => {
      const pa = effectiveItemPriority(a);
      const pb = effectiveItemPriority(b);
      if (pb !== pa) return pb - pa;
      return new Date(b.created_date).getTime() - new Date(a.created_date).getTime();
    });
    setItems(sorted);
    setLoading(false);
  }, [GoalItem]);

  useEffect(() => {
    load();
  }, [load]);

  useMindStorageRefresh(load);

  const addItem = async () => {
    if (!draft.trim()) return;
    setAddingGoal(true);
    try {
      const created = await GoalItem.create({
        goal_statement: draft.trim(),
        status: 'open',
        priority: 0.5,
        times_returned_to: 0,
        source: 'manual',
      });
      try {
        await finalizeNewGoalRoot(created, GoalItem);
      } catch {
        /* ignore */
      }
      setDraft('');
      await load();
      notifyMindStorageChanged({ source: 'goals' });
    } finally {
      setAddingGoal(false);
    }
  };

  const pursueItemFull = async (item) => {
    if (isCooperativePauseAllExternalHoldActive()) {
      setCooperativePauseAllExternalHold(false);
      void flushSchedulerDueTasksNow();
    }
    const gid = item.id;
    const ac = new AbortController();
    registerGoalPursuitGraphAbort(gid, ac);
    const prevUi = getGoalPagePursuitSnapshot().pursuits[gid]?.goalPipelineUi;
    upsertGoalPursuit(gid, {
      running: true,
      interruptedByReload: false,
      cooperativePaused: false,
      pursuitProgress: 'Starting…',
      goalPipelineUi: freshPursuitPipelineUiForNewGraphRun(prevUi),
      goalStatement: String(item.goal_statement || '').trim() || undefined,
      mindStorageProfile,
    });
    let pipelinePaused = false;
    try {
      const { pipelinePaused: didPause } = await runGoalDeepPursuitChain(item, {
        mindStorageProfile,
        signal: ac.signal,
        onProgress: (label) => {
          patchGoalPagePursuitEntry(gid, { pursuitProgress: label });
          updateGoalPagePursuitPipelineUiForId(gid, (prev) => ({
            ...prev,
            moduleStatuses: {},
            moduleOutputs: {},
            loopCount: 0,
            finalOutput: '',
            executionLog: [...prev.executionLog, { time: Date.now(), msg: `── ${label} ──` }],
          }));
        },
        onPipelineSse: (evt) => onGoalPipelineSse(gid, evt),
      });
      pipelinePaused = Boolean(didPause);
      await load();
    } catch (e) {
      if (isAbortError(e)) {
        await load();
        return;
      }
      console.error(e);
      toast({
        title: 'Goal pursuit failed',
        description: e instanceof Error ? e.message : String(e),
      });
      try {
        await GoalItem.update(item.id, { status: 'open' });
      } catch {
        /* ignore */
      }
      await load();
      const prevUi = getGoalPagePursuitSnapshot().pursuits[gid]?.goalPipelineUi;
      updateGoalPagePursuitPipelineUiForId(gid, () => freshPursuitPipelineUiForNewGraphRun(prevUi));
    } finally {
      clearGoalPursuitGraphAbort(gid);
      if (pipelinePaused) {
        patchGoalPagePursuitEntry(gid, {
          running: false,
          interruptedByReload: false,
          cooperativePaused: true,
          pursuitProgress: 'Paused — cooperative checkpoint saved. Open Goals to continue.',
        });
        flushGoalPursuitsPersistNow();
      } else {
        patchGoalPagePursuitEntry(gid, {
          running: false,
          pursuitProgress: null,
          interruptedByReload: false,
          cooperativePaused: false,
        });
      }
    }
  };

  /**
   * Run full graph pursuit for each lead in this goal thread (full cluster from DB, not filter-trimmed).
   * Skips children whose parent is also open/dormant in the thread — the parent's deep chain covers them.
   */
  const runGoalThreadGroupPursuit = async (fullClusterItems, clusterRootId) => {
    const rootKey = String(clusterRootId ?? '');
    const list = Array.isArray(fullClusterItems) ? fullClusterItems : [];

    if (threadGroupPursueRootId != null && threadGroupPursueRootId !== rootKey) {
      toast({
        title: 'Thread batch already running',
        description: 'Wait for the other thread batch to finish.',
      });
      return;
    }
    if (goalClusterHasActivePursuit(list, pursuits)) {
      toast({
        title: 'Pursuit busy in this thread',
        description: 'Wait until the current pursue in this thread finishes.',
      });
      return;
    }
    if (threadGroupPursueLockedRef.current) {
      toast({
        title: 'Thread batch already running',
        description: 'Wait for the current thread batch to finish.',
      });
      return;
    }

    threadGroupPursueLockedRef.current = true;
    setThreadGroupPursueRootId(rootKey);
    try {
      const eligible = list.filter((i) => {
        const st = goalUiStatus(i, pursuits);
        const idStr = String(i.id);
        return (st === 'open' || st === 'dormant') && pursuits[idStr]?.running !== true;
      });
      const eligibleIds = new Set(eligible.map((t) => String(t.id)));
      const chainHeads = eligible.filter((it) => {
        const p = it.parent_goal_id;
        if (p == null || p === '') return true;
        return !eligibleIds.has(String(p));
      });
      const targets = [...chainHeads].sort((a, b) => {
        const da = Number(a.pursuit_depth ?? 0);
        const db = Number(b.pursuit_depth ?? 0);
        if (da !== db) return da - db;
        return String(a.id).localeCompare(String(b.id));
      });

      if (targets.length === 0) {
        toast({
          title: 'Nothing to pursue in this thread',
          description: 'No open or dormant goals here, or each eligible one is already running.',
        });
        return;
      }

      if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches) {
        setGoalMobileSheetExpanded(false);
      }

      toast({
        title: 'Pursuing goal thread',
        description: `${targets.length} lead goal(s) will run in order (each may chain deeper).`,
      });
      for (const it of targets) {
        await pursueItemFull(it);
      }
      toast({
        title: 'Thread pursue complete',
        description: `Finished ${targets.length} run(s).`,
      });
    } catch (e) {
      console.error('[goals] thread group pursue', e);
      toast({
        title: 'Thread pursue failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      threadGroupPursueLockedRef.current = false;
      setThreadGroupPursueRootId(null);
    }
  };

  /** Clears execution log / module UI for this slot without removing it (keeps reruns + delay overrides). */
  const clearGoalPursuitExecutionLog = (goalId) => {
    const id = String(goalId || '');
    if (!id) return;
    const snap = getGoalPagePursuitSnapshot();
    if (snap.pursuits[id]?.running) return;
    const prevUi = snap.pursuits[id]?.goalPipelineUi;
    updateGoalPagePursuitPipelineUiForId(id, () => freshPursuitPipelineUiForNewGraphRun(prevUi));
  };

  const ensureGoalPursuitSlot = useCallback((item) => {
    const id = String(item.id);
    const prev = getGoalPagePursuitSnapshot().pursuits[id];
    upsertGoalPursuit(id, {
      running: false,
      interruptedByReload: false,
      cooperativePaused: false,
      pursuitProgress: null,
      goalStatement: String(item.goal_statement || '').trim() || undefined,
      goalPipelineUi: freshPursuitPipelineUiForNewGraphRun(prev?.goalPipelineUi),
      mindStorageProfile,
    });
  }, [mindStorageProfile]);

  /** Ensures the slot exists, selects it in the carousel, and expands the mobile sheet so run-limit inputs apply to this goal. */
  const focusGoalPursuitSlot = useCallback(
    (item) => {
      ensureGoalPursuitSlot(item);
      const id = String(item?.id ?? '');
      if (!id) return;
      const snap = getGoalPagePursuitSnapshot();
      const ids = Object.keys(snap.pursuits);
      const idx = ids.indexOf(id);
      if (idx >= 0) {
        setPipelineCarouselIndex(idx);
      }
      setGoalMobileSheetExpanded(true);
      requestAnimationFrame(() => {
        if (idx >= 0) scrollPipelineCarouselToIndex(idx);
        goalPipelinePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },
    [ensureGoalPursuitSlot, scrollPipelineCarouselToIndex]
  );

  const quickReflectItem = async (item) => {
    const gid = item.id;
    upsertGoalPursuit(gid, {
      running: true,
      interruptedByReload: false,
      cooperativePaused: false,
      pursuitProgress: 'Quick reflect…',
      goalPipelineUi: initialGoalPipelineUi(),
      goalStatement: String(item.goal_statement || '').trim() || undefined,
      mindStorageProfile,
    });
    try {
      await GoalItem.update(item.id, { status: 'pursuing' });
      await load();
      await runGoalPursuitLlmOnly(item, { mindStorageProfile });
      await load();
    } catch (e) {
      console.error(e);
      toast({
        title: 'Quick reflect failed',
        description: e instanceof Error ? e.message : String(e),
      });
      await GoalItem.update(item.id, { status: 'open' });
      await load();
    } finally {
      removeGoalPursuit(gid);
    }
  };

  async function hasPendingPursuitForTarget(targetId) {
    const all = await ScheduledTask.list('-created_date', 120);
    const wantProfile = normalizeScheduledTaskMindStorageProfile(mindStorageProfile);
    return all.some(
      (t) =>
        t.task_type === 'goal_pursuit' &&
        (t.status || 'pending') === 'pending' &&
        t.target_goal_id === targetId &&
        normalizeScheduledTaskMindStorageProfile(t.mind_storage_profile) === wantProfile
    );
  }

  const schedulePursuitForItem = async (item) => {
    if (scheduleBlocked) {
      toast({
        title: 'Scheduler busy',
        description: 'Wait until a pipeline or multi-step pursue finishes before scheduling.',
      });
      return;
    }
    const rt = getRuntimeSettings();
    const delay = Math.max(1, Math.floor(Number(rt.goalSchedulePursuitDelayMinutes) || 18));
    if (await hasPendingPursuitForTarget(item.id)) {
      toast({ title: 'Already scheduled', description: 'A pending goal pursuit already targets this item.' });
      return;
    }
    const gSlot = getGoalPagePursuitSnapshot().pursuits[item.id];
    const gUi = gSlot?.goalPipelineUi;
    await scheduleTask('goal_pursuit', delay, {
      target_goal_id: item.id,
      reason: `Goal: ${truncate(item.goal_statement, 120)}`,
      scheduled_by: 'user',
      mind_storage_profile: mindStorageProfile,
      ...(gUi && gUi.metacognitionMaxReruns != null
        ? { metacognition_max_reruns_override: gUi.metacognitionMaxReruns }
        : {}),
      ...(gUi && gUi.metacognitionRerunDelayMinutes != null
        ? { metacognition_rerun_delay_minutes_override: gUi.metacognitionRerunDelayMinutes }
        : {}),
    });
    toast({ title: 'Goal pursuit scheduled', description: `Runs in about ${delay} minutes.` });
    notifyMindStorageChanged({ source: 'scheduled-tasks' });
  };

  const setStatus = async (id, status) => {
    await GoalItem.update(id, { status });
    await load();
    notifyMindStorageChanged({ source: 'goals' });
  };

  const deleteItem = async (id) => {
    await GoalItem.delete(id);
    await load();
    notifyMindStorageChanged({ source: 'goals' });
  };

  const openItems = items.filter((i) => goalUiStatus(i, pursuits) === 'open');
  const pursuingItems = items.filter((i) => goalUiStatus(i, pursuits) === 'pursuing');
  const resolvedItems = items.filter((i) => goalUiStatus(i, pursuits) === 'resolved');
  const pursuitPrepCandidates = useMemo(
    () =>
      items.filter((i) => {
        const st = goalUiStatus(i, pursuits);
        return st === 'open' || st === 'dormant';
      }),
    [items, pursuits]
  );

  const clusters = useMemo(() => {
    const map = new Map();
    for (const item of items) {
      const root = item.root_goal_id || item.id;
      if (!map.has(root)) map.set(root, []);
      map.get(root).push(item);
    }
    return [...map.entries()]
      .map(([rootId, list]) => {
        const sorted = [...list].sort((a, b) => {
          const da = Number(a.pursuit_depth ?? 0);
          const db = Number(b.pursuit_depth ?? 0);
          if (da !== db) return da - db;
          const pa = effectiveItemPriority(a);
          const pb = effectiveItemPriority(b);
          if (pb !== pa) return pb - pa;
          return new Date(a.created_date).getTime() - new Date(b.created_date).getTime();
        });
        const recency = Math.max(
          ...list.map((i) => new Date(i.updated_date || i.created_date || 0).getTime())
        );
        return { rootId, items: sorted, recency };
      })
      .sort((a, b) => b.recency - a.recency);
  }, [items]);

  const filteredGoalClusters = useMemo(() => {
    if (goalQuestionFilter === 'all') return clusters;
    return clusters
      .map((c) => ({
        ...c,
        items: c.items.filter((i) => goalUiStatus(i, pursuits) === goalQuestionFilter),
      }))
      .filter((c) => c.items.length > 0);
  }, [clusters, goalQuestionFilter, pursuits]);

  const sortedFilteredGoalClusters = useMemo(() => {
    return [...filteredGoalClusters]
      .map((c) => ({
        ...c,
        _maxActiveP: maxActiveClusterPriority(c.items, pursuits, goalUiStatus),
      }))
      .sort((a, b) => {
        if (b._maxActiveP !== a._maxActiveP) return b._maxActiveP - a._maxActiveP;
        return b.recency - a.recency;
      })
      .map((row) => {
        const rest = { ...row };
        delete rest._maxActiveP;
        return rest;
      });
  }, [filteredGoalClusters, pursuits]);

  const goalPipelineRootClassName = useMemo(
    () =>
      portalMobileGoalPipeline
        ? 'min-w-0 fixed inset-0 z-[70] flex min-h-0 flex-col bg-background pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]'
        : cn(
            'min-w-0',
            goalMobileSheetExpanded
              ? 'max-lg:fixed max-lg:inset-0 max-lg:z-50 max-lg:flex max-lg:flex-col max-lg:bg-background max-lg:pt-[env(safe-area-inset-top,0px)]'
              : 'max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-40 max-lg:px-2 max-lg:pt-1',
            'lg:relative lg:z-auto lg:bg-transparent lg:pt-0 lg:scroll-mt-[calc(env(safe-area-inset-top,0px)+4.5rem)]'
          ),
    [portalMobileGoalPipeline, goalMobileSheetExpanded]
  );

  return (
    <PageShell
      icon={Target}
      title="Goals"
      description="Aims the mind works toward — seeded from the graph’s Goal Generation module (THIS_TURN / LONGER_TERM / NEW + GOAL_URGENCY) or added by hand; rank, pursue with the full pipeline when enabled, and resolve."
      actions={
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => load()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      }
    >
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <MindScopeTabs />
        </div>
        {isMirror ? (
          <p className="rounded-lg border border-border/80 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            System B: browse and pursue mirror goals here — full graph runs and scheduled tasks use the isolated mirror
            mind store.
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 text-center">
            <div className="text-2xl font-bold text-sky-800 dark:text-sky-300">{openItems.length}</div>
            <div className="text-xs text-muted-foreground">Open goals</div>
          </div>
          <div className={cn(
            'rounded-xl border p-4 text-center',
            pageSystemAccent === 'b'
              ? 'border-red-500/20 bg-red-500/5'
              : 'border-primary/20 bg-primary/5'
          )}>
            <div className={cn('text-2xl font-bold', pageSystemAccent === 'b' ? 'text-red-400' : 'text-primary')}>{pursuingItems.length}</div>
            <div className="text-xs text-muted-foreground">Actively pursuing</div>
          </div>
          <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-4 text-center">
            <div className="text-2xl font-bold text-green-700 dark:text-green-400">{resolvedItems.length}</div>
            <div className="text-xs text-muted-foreground">Resolved</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Show</span>
          {GOAL_QUESTION_FILTER_OPTIONS.map(({ value, label }) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={goalQuestionFilter === value ? 'default' : 'outline'}
              className="h-8"
              onClick={() => setGoalQuestionFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>

        {(pursuitIds.length > 0 || pursuitPrepCandidates.length > 0) ? (
          <GoalPipelineMobilePortal
            ref={goalPipelinePanelRef}
            portal={portalMobileGoalPipeline}
            className={goalPipelineRootClassName}
          >
            <div
              className={cn(
                'space-y-3 rounded-xl border bg-card p-3 shadow-sm sm:p-4',
                pageSystemAccent === 'b'
                  ? 'border-red-500/40 shadow-[inset_4px_0_0_0_rgba(239,68,68,0.45)]'
                  : 'border-primary/25',
                goalMobileSheetExpanded
                  ? 'max-lg:mx-0 max-lg:mb-0 max-lg:flex max-lg:h-full max-lg:min-h-0 max-lg:flex-1 max-lg:flex-col max-lg:gap-3 max-lg:overflow-hidden max-lg:rounded-none max-lg:border-0 max-lg:shadow-none max-lg:max-h-none max-lg:pb-[env(safe-area-inset-bottom,0px)]'
                  : 'max-lg:mx-auto max-lg:space-y-0 max-lg:overflow-x-hidden max-lg:rounded-b-none max-lg:rounded-t-2xl max-lg:border-x-0 max-lg:border-b-0 max-lg:px-2 max-lg:py-1.5 max-lg:pb-[max(0.5rem,env(safe-area-inset-bottom,0px))] max-lg:shadow-[0_-6px_28px_rgba(0,0,0,0.14)] dark:max-lg:shadow-[0_-6px_28px_rgba(0,0,0,0.45)]'
              )}
            >
              <div
                className={cn(
                  'flex shrink-0 flex-wrap items-start justify-between gap-2',
                  !goalMobileSheetExpanded && 'max-lg:flex-nowrap max-lg:items-center max-lg:gap-1.5'
                )}
              >
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      'flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-semibold text-foreground',
                      !goalMobileSheetExpanded && 'max-lg:text-xs'
                    )}
                  >
                    <Layers className={cn('h-4 w-4 shrink-0', pageSystemAccent === 'b' ? 'text-red-400' : 'text-primary')} />
                    <span className="truncate">Goal pipeline</span>
                    {pursuitIds.length > 1 ? (
                      <span className="shrink-0 text-[10px] font-normal tabular-nums text-muted-foreground">
                        {pipelineCarouselIndex + 1} / {pursuitIds.length}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 hidden text-[11px] text-muted-foreground lg:block">
                    Full cognitive stack per pursuit — separate from the main Graph Pipeline panel. Swipe horizontally when
                    several runs are active on smaller screens. On desktop, the execution log starts collapsed; use the
                    chevron on its header to expand or hide it. Chat transcript is not prepended to the server input.
                  </p>
                  {(() => {
                    const modName = getFirstProcessingModuleName(activeGoalPipelineUi?.moduleStatuses);
                    const line1 = modName ? `Module: ${modName}` : null;
                    const line2 = activePursuitProgress
                      ? formatPursuitThreadProgressLine(activePursuitProgress)
                      : null;
                    if (!line1 && !line2) return null;
                    return (
                      <div
                        className={cn(
                          'mt-1 space-y-0.5',
                          !goalMobileSheetExpanded && 'max-lg:hidden'
                        )}
                      >
                        {line1 ? (
                          <p className="truncate text-xs font-medium text-primary">{line1}</p>
                        ) : null}
                        {line2 ? (
                          <p className="truncate text-xs text-muted-foreground">{line2}</p>
                        ) : null}
                      </div>
                    );
                  })()}
                  {activePursuit?.goalStatement ? (
                    <GoalClampedStatement
                      text={activePursuit.goalStatement}
                      compact
                      className={cn('mt-0.5 min-w-0', !goalMobileSheetExpanded && 'max-lg:hidden')}
                    />
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {pursuitIds.length > 1 ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(
                          'h-9 w-9 shrink-0',
                          !goalMobileSheetExpanded && 'max-lg:h-8 max-lg:w-8'
                        )}
                        aria-label="Previous pursuit pipeline"
                        disabled={pipelineCarouselIndex <= 0}
                        onClick={() => {
                          const i = Math.max(0, pipelineCarouselIndex - 1);
                          setPipelineCarouselIndex(i);
                          scrollPipelineCarouselToIndex(i);
                        }}
                      >
                        <ChevronLeft className="h-5 w-5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(
                          'h-9 w-9 shrink-0',
                          !goalMobileSheetExpanded && 'max-lg:h-8 max-lg:w-8'
                        )}
                        aria-label="Next pursuit pipeline"
                        disabled={pipelineCarouselIndex >= pursuitIds.length - 1}
                        onClick={() => {
                          const i = Math.min(pursuitIds.length - 1, pipelineCarouselIndex + 1);
                          setPipelineCarouselIndex(i);
                          scrollPipelineCarouselToIndex(i);
                        }}
                      >
                        <ChevronRight className="h-5 w-5" />
                      </Button>
                    </>
                  ) : null}
                  {activePursuitId &&
                  !pursuits[activePursuitId]?.running &&
                  pursuits[activePursuitId]?.goalPipelineUi.executionLog.length > 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 shrink-0 text-xs"
                      onClick={() => clearGoalPursuitExecutionLog(activePursuitId)}
                    >
                      Clear log
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'h-9 w-9 shrink-0 lg:hidden',
                      !goalMobileSheetExpanded && 'max-lg:h-8 max-lg:w-8'
                    )}
                    aria-expanded={goalMobileSheetExpanded}
                    aria-label={goalMobileSheetExpanded ? 'Collapse pipeline panel' : 'Expand pipeline panel'}
                    onClick={() => setGoalMobileSheetExpanded((v) => !v)}
                  >
                    {goalMobileSheetExpanded ? (
                      <ChevronDown className="h-5 w-5" />
                    ) : (
                      <ChevronUp className="h-5 w-5" />
                    )}
                  </Button>
                </div>
              </div>
              <div className={cn(!goalMobileSheetExpanded && 'max-lg:hidden')}>
              {pursuitIds.length === 0 && pursuitPrepCandidates.length > 0 ? (
                <PursuitPipelinePrepSelect
                  idPrefix="goal"
                  label="Open slot for goal"
                  helperText="Pick a goal to create an idle pipeline slot. Then set reruns and delay here before you use Pursue (full) on the card."
                  candidates={pursuitPrepCandidates}
                  formatOption={(it) => truncate(String(it.goal_statement || ''), 120)}
                  onPick={(item) => focusGoalPursuitSlot(item)}
                  disabled={false}
                />
              ) : null}
              {activePursuitId ? (
                <PursuitMetacognitionLimitsRow
                  maxReruns={activeGoalPipelineUi?.metacognitionMaxReruns ?? null}
                  delayMinutes={activeGoalPipelineUi?.metacognitionRerunDelayMinutes ?? null}
                  disabled={pursuits[activePursuitId]?.running === true}
                  onChange={(patch) =>
                    updateGoalPagePursuitPipelineUiForId(activePursuitId, (prev) => ({ ...prev, ...patch }))
                  }
                  className="mt-2"
                />
              ) : null}
              {activePursuit?.interruptedByReload ? (
                <div className="flex w-full flex-col gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100/90 sm:flex-row sm:items-start">
                  <div className="flex min-w-0 flex-1 gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                    <p className="min-w-0 flex-1">
                      This pursuit pipeline was interrupted by a page reload. Partial logs and module state were restored
                      from browser storage. Use <span className="font-medium text-foreground/90">Pursue</span> to continue
                      from the server, or Dismiss to hide this notice.
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:pt-0">
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      className="h-7 gap-1 text-[10px]"
                      disabled={
                        !interruptedResumeGoalItem ||
                        scheduleBlocked ||
                        pursuits[activePursuitId]?.running === true
                      }
                      title={
                        scheduleBlocked
                          ? 'Wait until pipelines or another pursuit are idle'
                          : !interruptedResumeGoalItem
                            ? 'Goal row not found — refresh the list'
                            : undefined
                      }
                      onClick={() => {
                        if (interruptedResumeGoalItem) void pursueItemFull(interruptedResumeGoalItem);
                      }}
                    >
                      <Play className="h-3 w-3 shrink-0" aria-hidden />
                      Pursue
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 border-amber-500/40 text-[10px]"
                      onClick={() =>
                        activePursuitId &&
                        patchGoalPagePursuitEntry(activePursuitId, { interruptedByReload: false })
                      }
                    >
                      Dismiss
                    </Button>
                  </div>
                </div>
              ) : null}
              </div>
              {pursuitIds.length > 0 ? (
              <div
                className={cn(
                  'space-y-3',
                  goalMobileSheetExpanded && 'max-lg:flex max-lg:min-h-0 max-lg:flex-1 max-lg:flex-col max-lg:space-y-0 max-lg:gap-3 max-lg:overflow-hidden',
                  !goalMobileSheetExpanded && 'max-lg:hidden'
                )}
              >
                <p className="shrink-0 text-[11px] text-muted-foreground lg:hidden">
                  Full cognitive stack per pursuit — swipe left or right to switch when several runs are open. Chat
                  transcript is not prepended to the server input.
                </p>
                <div
                  ref={goalPipelineCarouselRef}
                  onScroll={handlePipelineCarouselScroll}
                  className={cn(
                    'flex w-full flex-nowrap overflow-x-auto overscroll-x-contain scroll-smooth snap-x snap-mandatory',
                    '[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
                    '[touch-action:pan-x_pan-y] [-webkit-overflow-scrolling:touch]',
                    goalMobileSheetExpanded && 'max-lg:min-h-0 max-lg:flex-1'
                  )}
                >
                  {pursuitIds.map((pid) => {
                    const storedEntry = pursuits[pid];
                    const entry = storedEntry ?? fallbackGoalPursuitEntryFromItems(pid, items);
                    const pipelineUi = pursuitShowsLivePipelineChrome(entry)
                      ? entry.goalPipelineUi
                      : freshPursuitPipelineUiForNewGraphRun(entry.goalPipelineUi);
                    const slideMinimap = computeGoalPipelineMinimapSnapshot(
                      pipelineUi.moduleStatuses,
                      entry.running
                    );
                    const activeModuleId = goalPipelineActiveModuleId(pipelineUi.moduleStatuses);
                    return (
                      <div
                        key={pid}
                        className="box-border h-full min-h-0 w-full shrink-0 grow-0 basis-full snap-center snap-always max-lg:self-stretch max-lg:overflow-y-auto lg:border-r lg:border-border/40 lg:pr-4 lg:[&:last-child]:border-r-0 lg:[&:last-child]:pr-0"
                      >
                        <div className="space-y-3">
                          <PipelineStageMinimap
                            snapshot={slideMinimap}
                            stripLabel={PIPELINE_MINIMAP_STRIP_LABEL}
                            ariaLabel="Goal pursuit pipeline stage overview"
                          />
                          <div
                            className={cn(
                              'grid grid-cols-1 gap-4 lg:items-stretch',
                              goalDesktopLogExpanded ? 'lg:grid-cols-3' : 'lg:grid-cols-1'
                            )}
                          >
                            <div
                              className={cn(
                                'relative h-[min(280px,40svh)] min-h-[13rem] min-w-0 overflow-hidden rounded-lg border',
                                entry.running && entryAccent(entry) === 'b'
                                  ? 'border-red-500/45 bg-red-500/[0.08] shadow-[inset_0_0_80px_rgba(239,68,68,0.10)] dark:bg-red-500/10 dark:shadow-[inset_0_0_90px_rgba(239,68,68,0.14)]'
                                  : entry.running && entryAccent(entry) === 'a'
                                    ? 'border-blue-500/45 bg-blue-500/[0.08] shadow-[inset_0_0_80px_rgba(59,130,246,0.10)] dark:bg-blue-500/10 dark:shadow-[inset_0_0_90px_rgba(59,130,246,0.14)]'
                                    : 'border-border bg-muted lg:bg-muted/10',
                                goalDesktopLogExpanded ? 'lg:col-span-2' : 'lg:col-span-1'
                              )}
                            >
                              <NeuralNetworkViz
                                variant="embedded"
                                activeModuleId={activeModuleId}
                                runAccent={entry.running ? entryAccent(entry) : null}
                                ariaLabel="Goal pursuit pipeline modules"
                              />
                            </div>
                            <div
                              className={cn(
                                'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card',
                                goalDesktopLogExpanded
                                  ? 'lg:max-h-[min(72svh,520px)] lg:min-h-[min(240px,32svh)]'
                                  : 'lg:max-h-none lg:min-h-0 lg:shrink-0'
                              )}
                            >
                              <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                                  <span className="font-mono text-[10px] text-muted-foreground">execution.log</span>
                                  {pipelineUi.executionLog.length > 0 ? (
                                    <span className="text-[10px] text-muted-foreground">
                                      ({pipelineUi.executionLog.length} lines)
                                    </span>
                                  ) : null}
                                </div>
                                <span className="shrink-0 text-[10px] text-muted-foreground">
                                  {cognitiveModuleCount} modules
                                </span>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="hidden h-8 w-8 shrink-0 lg:inline-flex"
                                  aria-expanded={goalDesktopLogExpanded}
                                  aria-label={
                                    goalDesktopLogExpanded
                                      ? 'Collapse execution log'
                                      : 'Expand execution log'
                                  }
                                  onClick={() => setGoalDesktopLogExpanded((v) => !v)}
                                >
                                  <ChevronDown
                                    className={cn(
                                      'h-4 w-4 transition-transform duration-200',
                                      goalDesktopLogExpanded && 'rotate-180'
                                    )}
                                  />
                                </Button>
                              </div>
                              <div
                                ref={pid === activePursuitId ? goalPipelineLogRef : undefined}
                                className={cn(
                                  'relative min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain [-webkit-overflow-scrolling:touch]',
                                  'max-lg:min-h-[11rem] max-lg:flex-1 max-lg:max-h-none',
                                  goalDesktopLogExpanded ? 'lg:min-h-0 lg:flex-1' : 'lg:hidden'
                                )}
                              >
                                <PipelineExecutionLogStatusLine
                                  className="sticky top-0 z-10"
                                  runError={null}
                                  isRunning={Boolean(storedEntry?.running)}
                                  executionLog={pipelineUi.executionLog}
                                />
                                <div className="space-y-2 p-3">
                                  {pipelineUi.executionLog.length === 0 ? (
                                    <p className="text-xs text-muted-foreground">
                                      {storedEntry
                                        ? pursuitShowsLivePipelineChrome(entry)
                                          ? PIPELINE_LOG_EMPTY_RUNNING
                                          : PIPELINE_LOG_EMPTY_IDLE
                                        : PIPELINE_LOG_PURSUIT_OUTSIDE_TAB}
                                    </p>
                                  ) : (
                                    pipelineUi.executionLog.map((logEntry, i) => (
                                      <div key={`${logEntry.time}-${i}`} className="font-mono text-xs leading-relaxed">
                                        <div
                                          className={
                                            String(logEntry.msg || '').startsWith('✓')
                                              ? 'text-emerald-500/90'
                                              : String(logEntry.msg || '').startsWith('──')
                                                ? 'text-primary/90'
                                                : 'text-foreground/80'
                                          }
                                        >
                                          {logEntry.msg}
                                        </div>
                                        {logEntry.detail ? <GoalCollapsibleLogDetail detail={logEntry.detail} /> : null}
                                      </div>
                                    ))
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              ) : null}
            </div>
          </GoalPipelineMobilePortal>
        ) : null}

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <Panel className="space-y-3 xl:sticky xl:top-4 xl:self-start">
            <div className="text-sm font-semibold">Add goal</div>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="What should this mind work toward?"
              className="min-h-[140px]"
            />
            <Button
              type="button"
              onClick={() => void addItem()}
              disabled={addingGoal || !draft.trim()}
              className="w-full gap-2"
            >
              {addingGoal ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add goal
            </Button>
          </Panel>

          <div className="min-w-0 space-y-6">
            {loading ? (
              <div className="flex justify-center py-16">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
              </div>
            ) : items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border py-16 text-center">
                <Target className="mx-auto mb-3 h-10 w-10 text-muted-foreground/25" />
                <p className="text-sm text-muted-foreground">
                  No goals yet. Run some pipeline sessions or add an aim by hand.
                </p>
              </div>
            ) : sortedFilteredGoalClusters.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border py-16 text-center">
                <Target className="mx-auto mb-3 h-10 w-10 text-muted-foreground/25" />
                <p className="text-sm text-muted-foreground">
                  No goals match{' '}
                  <strong className="text-foreground/90">
                    {GOAL_QUESTION_FILTER_OPTIONS.find((o) => o.value === goalQuestionFilter)?.label ??
                      goalQuestionFilter}
                  </strong>
                  . Try another filter or change a goal&apos;s status.
                </p>
              </div>
            ) : (
              <div className="space-y-8">
                {sortedFilteredGoalClusters.map(({ rootId, items: clusterItems }) => {
                  const rootItem =
                    items.find((i) => String(i.id) === String(rootId)) || clusterItems[0];
                  const fullClusterForRoot =
                    clusters.find((c) => String(c.rootId) === String(rootId))?.items ?? clusterItems;
                  const rootKey = String(rootId);
                  const batchRunningHere = threadGroupPursueRootId === rootKey;
                  const batchRunningOther =
                    threadGroupPursueRootId != null && threadGroupPursueRootId !== rootKey;
                  const clusterPursuitBusy = goalClusterHasActivePursuit(fullClusterForRoot, pursuits);
                  const threadPursueDisabled =
                    batchRunningOther || batchRunningHere || clusterPursuitBusy;
                  return (
                    <div key={rootId} className="space-y-2">
                      <div className="relative z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/15 px-3 py-2">
                        <div className="min-w-0">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Root goal
                          </div>
                          <GoalClampedStatement text={rootItem?.goal_statement || rootId} className="min-w-0" />
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="shrink-0"
                          disabled={threadPursueDisabled}
                          title={
                            batchRunningHere
                              ? 'Running pursuits for this thread…'
                              : batchRunningOther
                                ? 'Another thread batch is still running'
                                : clusterPursuitBusy
                                  ? 'A pursue in this thread is still running'
                                  : 'Run every open/dormant lead in this thread in order (full thread, not only rows visible under the filter). Pipeline panel defaults to a bottom strip on phones so this stays tappable.'
                          }
                          onClick={() => void runGoalThreadGroupPursuit(fullClusterForRoot, rootId)}
                        >
                          {batchRunningHere ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Play className="mr-1.5 h-3.5 w-3.5 opacity-80" aria-hidden />
                          )}
                          Pursue thread
                        </Button>
                      </div>
                      <div className="space-y-2 border-l-2 border-sky-500/25 pl-3">
                        {clusterItems.map((item) => {
                          const st = goalUiStatus(item, pursuits);
                          const itemPursuitEntry = pursuits[String(item.id)];
                          const styleCls = st === 'pursuing' && entryAccent(itemPursuitEntry) === 'b'
                            ? 'border-red-500/30 bg-red-500/5 text-red-400'
                            : (GOAL_STATUS_STYLES[st] || GOAL_STATUS_STYLES.open);
                          const p = effectiveItemPriority(item);
                          const depth = Number(item.pursuit_depth ?? 0);
                          const parent = item.parent_goal_id
                            ? clusterItems.find((i) => String(i.id) === String(item.parent_goal_id))
                            : null;
                          return (
                            <div
                              key={item.id}
                              id={`goal-focus-${item.id}`}
                              className={cn('rounded-xl border p-4 transition-colors', styleCls)}
                              style={{ marginLeft: Math.min(depth, 6) * 10 }}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="mb-1 flex flex-wrap items-center gap-2">
                                    <span className="rounded border border-current/20 px-1.5 py-0.5 text-[9px] uppercase opacity-80">
                                      {st}
                                    </span>
                                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-current/15">
                                      <div
                                        className="h-full rounded-full bg-current opacity-70"
                                        style={{ width: `${Math.round(p * 100)}%` }}
                                      />
                                    </div>
                                    <span className="text-[10px] opacity-60">{Math.round(p * 100)}% priority</span>
                                  </div>
                                  {parent ? (
                                    <p className="mb-1 text-[10px] text-muted-foreground">
                                      Branched from: {truncate(parent.goal_statement, 100)}
                                    </p>
                                  ) : null}
                                  <GoalClampedStatement text={item.goal_statement} />
                                  {item.pursuit_thread ? <GoalCollapsibleThread text={item.pursuit_thread} /> : null}
                                  {item.resolution ? <GoalCollapsibleResolution text={item.resolution} /> : null}
                                  <div className="mt-2 text-[10px] text-muted-foreground/70">
                                    {item.created_date ? moment(item.created_date).fromNow() : ''}
                                    {item.times_returned_to != null ? ` · returned ${item.times_returned_to}×` : null}
                                    {item.last_pursuit_pipeline_run_id
                                      ? ` · run ${String(item.last_pursuit_pipeline_run_id).slice(-6)}`
                                      : null}
                                  </div>
                                </div>
                                <div className="flex shrink-0 flex-col items-end gap-1">
                                  {st === 'open' || st === 'dormant' ? (
                                    <>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 gap-1 text-xs"
                                        disabled={pursuits[item.id]?.running === true}
                                        onClick={() => void pursueItemFull(item)}
                                      >
                                        {pursuits[item.id]?.running === true ? (
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                          <ArrowRight className="h-3 w-3" />
                                        )}
                                        Pursue (full)
                                      </Button>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="h-7 gap-1 text-xs"
                                        disabled={pursuits[item.id]?.running === true}
                                        onClick={() => focusGoalPursuitSlot(item)}
                                      >
                                        Run limits
                                      </Button>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 text-xs text-muted-foreground"
                                        disabled={pursuits[item.id]?.running === true}
                                        onClick={() => void quickReflectItem(item)}
                                      >
                                        Quick reflect
                                      </Button>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 text-xs text-muted-foreground"
                                        disabled={scheduleBlocked}
                                        title={
                                          scheduleBlocked
                                            ? 'Wait until the graph pipeline or another pursuit on this page finishes'
                                            : undefined
                                        }
                                        onClick={() => void schedulePursuitForItem(item)}
                                      >
                                        Schedule
                                      </Button>
                                      {st === 'open' ? (
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="ghost"
                                          className="h-7 text-xs text-muted-foreground"
                                          disabled={pursuits[item.id]?.running === true}
                                          onClick={() => setStatus(item.id, 'resolved')}
                                        >
                                          Resolve
                                        </Button>
                                      ) : null}
                                    </>
                                  ) : null}
                                  {st === 'pursuing' ? (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 gap-1 text-xs text-green-700 dark:text-green-400"
                                      onClick={() => setStatus(item.id, 'resolved')}
                                    >
                                      <CheckCircle2 className="h-3 w-3" />
                                      Resolve
                                    </Button>
                                  ) : null}
                                  {st === 'resolved' ? (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 text-xs"
                                      onClick={() => setStatus(item.id, 'open')}
                                    >
                                      Reopen
                                    </Button>
                                  ) : null}
                                  <button
                                    type="button"
                                    title="Delete"
                                    className="p-1 self-end opacity-30 transition-opacity hover:opacity-80"
                                    onClick={() => deleteItem(item.id)}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {(pursuitIds.length > 0 || pursuitPrepCandidates.length > 0) ? (
          <div
            className={cn(
              'shrink-0 lg:hidden',
              goalMobileSheetExpanded ? 'h-0' : 'h-14'
            )}
            aria-hidden
          />
        ) : null}
      </div>
    </PageShell>
  );
}
