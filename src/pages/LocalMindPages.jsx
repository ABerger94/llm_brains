/** Many local-mind routes live here; prefer extracting new sections into colocated components. */
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import moment from 'moment';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock3,
  Database,
  Eye,
  EyeOff,
  Fingerprint,
  Gauge,
  Globe,
  Laptop,
  Layers,
  Loader2,
  Moon,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Sparkles,
  Merge,
  ScanSearch,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Zap,
} from 'lucide-react';
import CognitiveHealthSnapshotPanels from '../components/cognitiveHealth/CognitiveHealthSnapshotPanels';
import PageShell from '../components/PageShell';
import { Button, Input, Textarea, toast } from '../components/ui';
import ModelPicker from '../components/browserMind/ModelPicker';
import LoadProgress from '../components/browserMind/LoadProgress';
import { AVAILABLE_MODELS, isWebGPUAvailable, loadEngine, getLoadedModelId } from '../lib/browserLlmEngine';
import {
  getPipelineExecutionBackend,
  setPipelineExecutionBackend,
  EXECUTION_BACKEND_BROWSER,
  EXECUTION_BACKEND_SERVER,
} from '../lib/localPipeline/executionBackend';
import { computeCognitiveHealthDerived } from '../lib/cognitiveHealthDerived';
import { curiosityUiStatus } from '../lib/curiosityQueueMetrics';
import { emergenceReviewState } from '../lib/emergenceReviewState';
import { invokeLLM } from '../lib/llm';
import {
  clampPriority,
  DEFAULT_MANUAL_LIKE_PRIORITY,
  effectiveItemPriority,
  maxActiveClusterPriority,
} from '../lib/priorityUtils';
import { llmService } from '../services/llmService';
import {
  ScheduledTask,
  Dataset,
  EmergenceEvent,
  FeedbackItem,
  PipelineRun,
  TrainingRun,
} from '../lib/data';
import {
  DEFAULT_RUNTIME_SETTINGS,
  getPipelineIdentityRuntimeSlice,
  getRuntimeSettings,
  saveRuntimeSettings,
  buildModulePromptOverridesForSave,
  initializeModulePromptDrafts,
  MODULE_PROMPT_OVERRIDE_MAX_LEN,
  resolveMaxMetacognitionReruns,
  resolveMetacognitionRerunDelayMinutes,
} from '../lib/runtimeSettings';
import { COGNITIVE_MODULES, getFirstProcessingModuleId, getFirstProcessingModuleName } from '../lib/cognitiveModules';
import { MODULES as BUNDLED_PIPELINE_MODULES } from '../../shared/pipelineModules.mjs';
import { collectPipelineEmergenceMarkers } from '../../shared/biographyIdentityExtract.mjs';
import { temporalEventsExcludingPauseNoise } from '../../shared/temporalTimelinePauseFilter.mjs';
import { excludeCheckpointPipelineRuns } from '../lib/pipelineRunCheckpoint';

function pipelineModulesToDefaultsList(modules) {
  return modules.map(({ name, systemPrompt }) => ({ name, systemPrompt }));
}
import { MIND_PHASE_OPTIONS } from '../lib/mindPersistence';
import { consolidateDuplicateCuriosityItemsInStore } from '../lib/consolidateMindEntities';
import {
  runCuriosityDeepPursuitChain,
  runCuriosityPursuitLlmOnly,
} from '../lib/curiosityPursuit';
import { isAbortError } from '../lib/dashboardAbortActivePipeline';
import {
  clearCuriosityPursuitGraphAbort,
  registerCuriosityPursuitGraphAbort,
} from '../lib/pursuitGraphPipelineAbortRegistry';
import {
  computeCuriosityPipelineMinimapSnapshot,
  freshPursuitPipelineUiForNewGraphRun,
  initialCuriosityPipelineUi,
  pursuitShowsLivePipelineChrome,
  reduceCuriosityPipelineSse,
} from '../lib/curiosityPipelineSseUi';
import {
  flushCuriosityPursuitsPersistNow,
  getCuriosityPagePursuitSnapshot,
  patchCuriosityPursuitEntry,
  removeCuriosityPursuit,
  subscribeCuriosityPagePursuit,
  updateCuriosityPursuitPipelineUiForId,
  upsertCuriosityPursuit,
} from '../lib/curiosityPagePursuitStore';
import { getGoalPagePursuitSnapshot, subscribeGoalPagePursuit } from '../lib/goalPagePursuitStore';
import { formatPursuitThreadProgressLine } from '../lib/pursuitThreadStatusFormat';
import {
  PIPELINE_LOG_EMPTY_IDLE,
  PIPELINE_LOG_EMPTY_RUNNING,
  PIPELINE_LOG_PURSUIT_OUTSIDE_TAB,
  PIPELINE_MINIMAP_STRIP_LABEL,
} from '../lib/activePipelineStatusLabels';
import { PipelineStageMinimap } from '../components/consciousness/PipelineStageMinimap';
import PipelineExecutionLogStatusLine from '../components/pipeline/PipelineExecutionLogStatusLine';
import PursuitMetacognitionLimitsRow from '../components/pipeline/PursuitMetacognitionLimitsRow';
import PursuitPipelinePrepSelect from '../components/pipeline/PursuitPipelinePrepSelect';
import NeuralNetworkViz from '../components/NeuralNetworkViz';
import { scheduleTask } from '../lib/schedulerStore';
import { normalizeScheduledTaskMindStorageProfile } from '../lib/mindEntityContext';
import {
  isCooperativePauseAllExternalHoldActive,
  setCooperativePauseAllExternalHold,
} from '../lib/cooperativePauseAllExternalHold';
import { flushSchedulerDueTasksNow } from '../lib/scheduledTaskRunner';
import {
  getInteractiveGraphOrStreamActivitySnapshot,
  subscribeInteractiveGraphOrStreamActivity,
} from '../lib/pipelineBusyGate';
import { finalizeNewCuriosityRoot } from '../lib/curiosityLineage';
import { generateMindBiographyViaLlm, persistMindBiographyVersion } from '../lib/mindBiographyLlm';
import {
  MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR,
  MIND_STORAGE_PROFILE_PRIMARY,
  setActiveMindEntityProfile,
} from '../lib/mindEntityContext';
import { useMindStorageRefresh, notifyMindStorageChanged } from '../lib/mindStorageEvents';
import { useMindScope, useScopedEntities } from '../context/MindScopeContext';
import MindScopeTabs from '../components/MindScopeTabs';
import { LOCAL_LLM_SETUP_TEXT } from '../lib/localLlmGuide';
import { searchLongTermMemory } from '../lib/longTermMemorySearch';
import { cn } from '../lib/utils';
import {
  WORLD_MODEL_CATEGORY_ORDER,
  WORLD_MODEL_CATEGORY_META,
  humanizeUnityRationaleForDisplay,
  normalizeWorldModelCategory,
  displayWorldModelLabel,
  itemKeyForRecord,
  stableWorldModelKey,
  buildWorldModelCreatePayload,
  buildWorldModelUpdatePayload,
  newWorldModelHistoryEntry,
} from '../lib/worldModelSchema';

const MEMORY_TYPE_COLORS = {
  episodic: 'text-blue-400 border-blue-400/20 bg-blue-400/5',
  semantic: 'text-purple-400 border-purple-400/20 bg-purple-400/5',
  procedural: 'text-green-400 border-green-400/20 bg-green-400/5',
  emotional: 'text-pink-400 border-pink-400/20 bg-pink-400/5',
  dream: 'text-amber-400 border-amber-400/20 bg-amber-400/5',
};

const MEMORY_TYPES = ['episodic', 'semantic', 'procedural', 'emotional', 'dream'];

function LongTermMemoryCard({ mem, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const type = mem.memory_type || 'episodic';
  const typeCls = MEMORY_TYPE_COLORS[type] || 'border-border bg-card';
  const body = String(mem.content || mem.title || '').trim();
  const src = mem.source_module || mem.source;
  const kws = Array.isArray(mem.embedding_keywords) ? mem.embedding_keywords : [];

  return (
    <div className={cn('rounded-xl border transition-all', typeCls)}>
      <button
        type="button"
        className="flex w-full cursor-pointer items-start gap-3 p-4 text-left"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className={cn('rounded border px-1.5 py-0.5 text-[9px]', MEMORY_TYPE_COLORS[type] || typeCls)}>
              {type}
            </span>
            {src ? <span className="font-mono text-[10px] text-muted-foreground">[{src}]</span> : null}
            <span className="ml-auto text-[10px] text-muted-foreground">
              {mem.created_date ? moment(mem.created_date).fromNow() : ''}
            </span>
          </div>
          <p className={cn('text-sm leading-relaxed text-foreground', !expanded && 'line-clamp-2')}>{body || ''}</p>
          {kws.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {kws.slice(0, 8).map((kw, i) => (
                <span key={`${kw}-${i}`} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {kw}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="text-[10px] text-muted-foreground">{Math.round((mem.importance ?? 0.5) * 100)}% imp.</div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(mem.id);
              }}
              className="p-1 opacity-30 transition-opacity hover:opacity-100"
              aria-label="Delete memory"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </div>
        </div>
      </button>
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

function StatCard({ label, value, hint }) {
  return (
    <Panel>
      <div className="text-xs uppercase tracking-[0.22em] text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </Panel>
  );
}

function formatRelative(value) {
  return value ? moment(value).fromNow() : 'just now';
}

function truncate(value, length = 220) {
  if (!value) return '';
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

const EMERGENCE_MODULE_ORDER = ['Identity', 'Narrative', 'Integration'];

/** Per-run text for emergence prompts: labeled cognitive module outputs + voice line. */
function flattenPipelineOutputsForEmergence(run) {
  const mo = run.module_outputs || {};
  const entries = Object.entries(mo).filter(([, v]) => v != null && String(v).trim());
  entries.sort(([a], [b]) => {
    const ia = EMERGENCE_MODULE_ORDER.indexOf(a);
    const ib = EMERGENCE_MODULE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  const parts = entries.map(([k, v]) => `[${k}]\n${String(v).trim()}`);
  const voice = String(run.final_output || '').trim();
  if (parts.length === 0) {
    return voice || '(no captured module output; voice line empty)';
  }
  const body = parts.join('\n\n');
  return voice ? `${body}\n\n[Voice]\n${voice}` : body;
}

/** Saved Graph Pipeline chat / shared conversation rows for emergence compare (chronological slice). */
function flattenConversationMessagesForEmergence(rows) {
  const sorted = [...(rows || [])].sort(
    (a, b) => new Date(a.created_date).getTime() - new Date(b.created_date).getTime()
  );
  const blocks = [];
  for (const m of sorted) {
    const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Voice' : String(m.role || '?');
    let block = `[${role}]\n${String(m.content || '').trim()}`;
    if (m.role === 'assistant') {
      const mo = m.module_outputs || {};
      const parts = Object.entries(mo)
        .filter(([, v]) => v != null && String(v).trim())
        .map(([k, v]) => `[${k}]\n${String(v).trim()}`);
      if (parts.length) block += `\n\n${parts.join('\n\n')}`;
    }
    blocks.push(block);
  }
  return blocks.join('\n\n---\n\n');
}

const EMERGENCE_CATEGORY_SET = new Set(['identity_shift', 'reasoning_shift', 'style_shift', 'other']);

function normalizeEmergenceCategory(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (EMERGENCE_CATEGORY_SET.has(s)) return s;
  return 'other';
}

function emergenceDeviationScore(event) {
  if (typeof event.deviation_score === 'number') return event.deviation_score;
  if (event.severity === 'high') return 0.75;
  if (event.severity === 'medium') return 0.5;
  if (event.severity === 'low') return 0.35;
  return null;
}

const EMERGENCE_SIGNAL_LABELS = {
  emergence_llm: 'LLM scan',
  emergence_heuristic: 'Heuristic',
  identity_tracking: 'Identity tracking',
};

function emergenceSignalLabel(event) {
  const t = String(event?.signal_type || '').trim().toLowerCase();
  if (EMERGENCE_SIGNAL_LABELS[t]) return EMERGENCE_SIGNAL_LABELS[t];
  if (!t) return 'Signal';
  return t
    .replace(/^emergence_/, '')
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function normalizeEmergenceEvidenceItems(event) {
  let raw = event?.evidence_items;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => ({
      marker: String(row?.marker || row?.marker_type || 'Evidence').slice(0, 200),
      source: String(row?.source || row?.source_label || '').slice(0, 200),
      quote: String(row?.quote || '').trim(),
    }))
    .filter((row) => row.quote);
}

/** Comma-split heuristic "Detected: …" lines; respects parentheses e.g. "identity module (substantive)". */
function parseEmergenceDetectedMarkers(details) {
  const d = String(details || '').trim();
  if (!/^detected\s*:/i.test(d)) return null;
  const rest = d.replace(/^detected\s*:/i, '').trim();
  if (!rest) return [];
  const parts = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) {
      const t = buf.trim();
      if (t) parts.push(t);
      buf = '';
      continue;
    }
    buf += c;
  }
  const last = buf.trim();
  if (last) parts.push(last);
  return parts;
}

/** Order evidence rows to match each flag from the Detected: list (exact key, then loose substring match). */
function emergenceEvidenceRowsByDetectedMarkers(detectedMarkers, evidenceItems) {
  const byMarker = new Map();
  for (const ev of evidenceItems) {
    const list = byMarker.get(ev.marker) || [];
    list.push(ev);
    byMarker.set(ev.marker, list);
  }
  return detectedMarkers.map((marker) => {
    let items = byMarker.get(marker) || [];
    if (items.length === 0) {
      const ml = marker.toLowerCase().trim();
      items = evidenceItems.filter((ev) => {
        const el = String(ev.marker || '').toLowerCase().trim();
        if (!el) return false;
        return (
          el === ml ||
          (ml.length >= 5 && el.includes(ml)) ||
          (el.length >= 5 && ml.includes(el))
        );
      });
    }
    return { marker, items };
  });
}

/** When details lack Detected:, still show one bucket per distinct evidence marker (stable order). */
function groupEmergenceEvidenceByMarker(evidenceItems) {
  const order = [];
  const map = new Map();
  for (const ev of evidenceItems) {
    const m = String(ev.marker || 'Evidence').trim() || 'Evidence';
    if (!map.has(m)) {
      order.push(m);
      map.set(m, []);
    }
    map.get(m).push(ev);
  }
  return order.map((marker) => ({ marker, items: map.get(marker) || [] }));
}

function emergenceEvidenceKey(ev) {
  return `${String(ev.marker || '')}\0${String(ev.quote || '')}`;
}

/**
 * Recompute heuristic emergence quotes from saved PipelineRun rows when evidence_items were missing (e.g. legacy data).
 */
/** @returns {Promise<boolean>} true if any row was updated */
async function backfillEmergenceEvidenceFromPipelineRuns(
  events,
  stores = { PipelineRun, EmergenceEvent }
) {
  const { PipelineRun: RunStore, EmergenceEvent: EmergenceStore } = stores;
  const empty = events.filter((e) => e.pipeline_run_id && normalizeEmergenceEvidenceItems(e).length === 0);
  const runIds = [...new Set(empty.map((e) => e.pipeline_run_id))].slice(0, 40);
  const cache = new Map();
  for (const rid of runIds) {
    try {
      const run = await RunStore.retrieve(rid);
      if (!run) continue;
      const mo = run.module_outputs || {};
      const sm = run.shared_memory && typeof run.shared_memory === 'object' ? run.shared_memory : {};
      const { markers, evidence_items } = collectPipelineEmergenceMarkers({
        voiceText: run.final_output,
        narrativeText: String(mo.Narrative ?? ''),
        identityText: String(mo.Identity ?? ''),
        dmnText: typeof sm.dmnCarryover === 'string' ? sm.dmnCarryover : '',
      });
      cache.set(rid, { markers, evidence_items });
    } catch (e) {
      console.warn('[emergence] backfill run retrieve failed', rid, e);
    }
  }
  let updatedAny = false;
  for (const e of empty) {
    const pack = cache.get(e.pipeline_run_id);
    if (!pack || !Array.isArray(pack.evidence_items) || pack.evidence_items.length === 0) continue;
    try {
      const patch = { evidence_items: pack.evidence_items };
      const isHeuristic = String(e.signal_type || '').toLowerCase() === 'emergence_heuristic';
      if (isHeuristic && pack.markers?.length) {
        patch.details = truncate(`Detected: ${pack.markers.join(', ')}`, 2000);
      }
      await EmergenceStore.update(e.id, patch);
      updatedAny = true;
    } catch (err) {
      console.warn('[emergence] backfill update failed', e.id, err);
    }
  }
  return updatedAny;
}

/** Display labels for biography identity fields (preserve casing). */
function healthDisplayTagList(field) {
  if (Array.isArray(field)) return field.map((x) => String(x).trim()).filter(Boolean);
  if (typeof field === 'string' && field.trim()) {
    return field
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export function LongTermMemoryPage() {
  const { isMirror } = useMindScope();
  const { LongTermMemory, PipelineRun } = useScopedEntities();
  const [memories, setMemories] = useState([]);
  const [query, setQuery] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [capturingRun, setCapturingRun] = useState(false);
  const [savingMemory, setSavingMemory] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [memoryType, setMemoryType] = useState('episodic');

  const load = useCallback(async () => {
    setLoading(true);
    const data = await LongTermMemory.list('-created_date', 100);
    setMemories(data);
    setLoading(false);
  }, [LongTermMemory]);

  useEffect(() => {
    load();
  }, [load]);

  useMindStorageRefresh(load);

  const search = async () => {
    if (!query.trim()) {
      await load();
      return;
    }
    setSearching(true);
    try {
      const results = await searchLongTermMemory(query, 20, LongTermMemory);
      setMemories(results);
    } finally {
      setSearching(false);
    }
  };

  const resetList = async () => {
    setQuery('');
    await load();
  };

  const createMemory = async () => {
    if (!content.trim()) return;
    setSavingMemory(true);
    try {
      await LongTermMemory.create({
        title: title.trim() || `Memory ${new Date().toLocaleString()}`,
        content,
        memory_type: memoryType,
        source: 'manual',
      });
      setTitle('');
      setContent('');
      toast({ title: 'Memory saved' });
      await load();
      notifyMindStorageChanged({ source: 'long-term-memory' });
    } finally {
      setSavingMemory(false);
    }
  };

  const captureLatestRun = async () => {
    setCapturingRun(true);
    try {
      const [latestRun] = await PipelineRun.list('-created_date', 1);
      if (!latestRun) {
        toast({ title: 'No pipeline run to capture' });
        return;
      }
      await LongTermMemory.create({
        title: `Pipeline memory ${new Date(latestRun.created_date).toLocaleString()}`,
        content: latestRun.final_output || JSON.stringify(latestRun.module_outputs || {}, null, 2),
        memory_type: 'episodic',
        source: 'pipeline-run',
        pipeline_run_id: latestRun.id,
      });
      toast({ title: 'Captured latest run' });
      await load();
      notifyMindStorageChanged({ source: 'long-term-memory' });
    } finally {
      setCapturingRun(false);
    }
  };

  const deleteMemory = async (id) => {
    await LongTermMemory.delete(id);
    toast({ title: 'Memory deleted' });
    await load();
    notifyMindStorageChanged({ source: 'long-term-memory' });
  };

  const filtered = filterType === 'all' ? memories : memories.filter((m) => (m.memory_type || '') === filterType);

  return (
    <div className="w-full min-h-0 p-4 sm:p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <MindScopeTabs />
              {isMirror ? (
                <span className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
                  System B mirror store
                </span>
              ) : null}
            </div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
              <Brain className="h-6 w-6 text-blue-400" />
              Long-Term Memory
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Persistent memories across all sessions. Search filters what is stored locally; the graph pipeline also recalls
              relevant entries before each run.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" className="shrink-0 gap-2" onClick={() => load()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        <div className="mb-6 flex flex-wrap gap-3">
          <div className="flex min-w-0 flex-1 basis-full gap-2 sm:min-w-[200px] sm:basis-auto">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && search()}
              placeholder="Search titles and content..."
              className="bg-muted/30"
            />
            <Button type="button" onClick={search} disabled={searching} size="icon" variant="outline" aria-label="Search">
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </div>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="h-10 w-44 rounded-md border border-input bg-muted/30 px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="all">All types</option>
            {MEMORY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <Button type="button" variant="outline" size="sm" onClick={resetList}>
            Reset
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void captureLatestRun()}
            disabled={capturingRun || loading}
            className="gap-2"
          >
            {capturingRun ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Capture latest run
          </Button>
        </div>

        <div className="mb-4 flex flex-wrap gap-3">
          {MEMORY_TYPES.map((t) => {
            const count = memories.filter((m) => (m.memory_type || '') === t).length;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setFilterType((prev) => (prev === t ? 'all' : t))}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs transition-all',
                  MEMORY_TYPE_COLORS[t],
                  filterType === t && 'ring-1 ring-current'
                )}
              >
                {t}: {count}
              </button>
            );
          })}
        </div>

        <details className="mb-6 rounded-xl border border-border bg-card">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-foreground">
            Add memory manually
          </summary>
          <div className="space-y-3 border-t border-border p-4">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" className="bg-muted/30" />
            <select
              value={memoryType}
              onChange={(e) => setMemoryType(e.target.value)}
              className="h-10 w-full rounded-md border border-input bg-muted/30 px-3 text-sm"
            >
              {MEMORY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="What should the mind remember?"
              className="min-h-[140px] bg-muted/30"
            />
            <Button type="button" onClick={() => void createMemory()} disabled={savingMemory || !content.trim()} className="gap-2">
              {savingMemory ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Save memory
            </Button>
          </div>
        </details>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-16 text-center">
            <Brain className="mx-auto mb-2 h-8 w-8 text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground">
              No memories found. Run the pipeline, capture a run, or add one manually.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((mem) => (
              <LongTermMemoryCard key={mem.id} mem={mem} onDelete={deleteMemory} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function MindBiographyPage() {
  const { isMirror } = useMindScope();
  const { MindBiography: MindBiographyStore } = useScopedEntities();
  const [biographies, setBiographies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await MindBiographyStore.list('-created_date', 50);
    setBiographies(data);
    if (data.length > 0) {
      setExpandedId((prev) => (prev && data.some((b) => b.id === prev) ? prev : data[0].id));
    } else {
      setExpandedId(null);
    }
    setLoading(false);
  }, [MindBiographyStore]);

  useEffect(() => {
    load();
  }, [load]);

  useMindStorageRefresh(load);

  const generateBiography = async () => {
    setGenerating(true);
    try {
      if (isMirror) {
        setActiveMindEntityProfile(MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR);
      }
      try {
        const prevBioList = await MindBiographyStore.list('-created_date', 1);
        const prevBio = prevBioList[0];

        let gen;
        try {
          gen = await generateMindBiographyViaLlm(prevBio, {});
        } catch (err) {
          console.error('[biography] generation failed', err);
          toast({
            title: 'Biography generation failed',
            description:
              'The model did not return a usable AUTOBIOGRAPHY section (it may have echoed JSON context). Try again, use a stronger model, or reduce context. ' +
              (err instanceof Error ? err.message : String(err)).slice(0, 220),
            variant: 'destructive',
          });
          return;
        }

        await persistMindBiographyVersion({
          sessionNumber: gen.sessionNumber,
          fullText: gen.fullText,
          summary: gen.summary,
          keywords: gen.keywords,
          values: gen.values,
          changes: gen.changes,
          memoriesCount: gen.memoriesCount,
          beliefCount: gen.beliefCount,
          sessionId: gen.runs[0]?.id || 'manual',
          source: 'biography',
        });

        await load();
      } finally {
        setActiveMindEntityProfile(MIND_STORAGE_PROFILE_PRIMARY);
      }
    } finally {
      setGenerating(false);
    }
  };

  const deleteBiography = async (id) => {
    if (!window.confirm('Delete this biography version? This cannot be undone.')) return;
    await MindBiographyStore.delete(id);
    if (expandedId === id) setExpandedId(null);
    toast({
      title: 'Biography deleted',
      description: 'Long-term memory / timeline rows created with that version are not removed.',
    });
    await load();
    notifyMindStorageChanged({ source: 'biography' });
  };

  const asList = (x) => {
    if (Array.isArray(x)) return x.filter(Boolean);
    if (typeof x === 'string' && x.trim())
      return x
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return [];
  };

  return (
    <div className="w-full min-h-0 p-4 sm:p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <MindScopeTabs />
        </div>
        {isMirror ? (
          <p className="mb-4 rounded-lg border border-border/80 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            System B: isolated mirror biography store — “Write New Version” saves to this mirror mind only.
          </p>
        ) : null}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
              <BookOpen className="h-6 w-6 text-purple-400" />
              Mind Biography
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              A living autobiography in the Voice module&apos;s own stance, using the same context bundle as a pipeline Voice
              step (memories, beliefs, tensions, curiosity, timeline, constitution, structural self, recent run snapshot). Local
              stores only—no web lookups for this write.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => load()} disabled={loading}>
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              Refresh
            </Button>
            <Button
              onClick={() => void generateBiography()}
              disabled={generating || loading}
              className="gap-2"
            >
              {generating ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Write New Version
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          </div>
        ) : biographies.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-16 text-center">
            <BookOpen className="mx-auto mb-3 h-10 w-10 text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground">
              No biography yet. Run some pipeline sessions, add beliefs and memories, then write the first version.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {biographies.map((bio, idx) => {
              const kws = asList(bio.identity_keywords);
              const vals = asList(bio.core_values);
              const sessionNum = bio.session_number ?? bio.version ?? biographies.length - idx;
              const narrative = bio.full_text || bio.summary || '';
              return (
                <div
                  key={bio.id}
                  className={cn(
                    'overflow-hidden rounded-xl border bg-card',
                    idx === 0 ? 'border-purple-500/30' : 'border-border'
                  )}
                >
                  <div className="flex items-center gap-1 p-4">
                    <button
                      type="button"
                      aria-expanded={expandedId === bio.id}
                      className="flex min-w-0 flex-1 items-center gap-4 text-left transition-colors hover:bg-muted/10 rounded-lg -m-2 p-2"
                      onClick={() => setExpandedId(expandedId === bio.id ? null : bio.id)}
                    >
                      <div
                        className={cn(
                          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                          idx === 0 ? 'bg-purple-500/10' : 'bg-muted/30'
                        )}
                      >
                        <Sparkles className={cn('h-5 w-5', idx === 0 ? 'text-purple-400' : 'text-muted-foreground')} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-foreground">
                          {idx === 0 ? 'Current Self' : `Version ${sessionNum}`}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {bio.created_date ? moment(bio.created_date).format('MMMM D, YYYY · h:mm a') : ''}
                        </div>
                      </div>
                      {expandedId === bio.id ? (
                        <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label="Delete biography version"
                      disabled={generating}
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteBiography(bio.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  {expandedId === bio.id ? (
                    <div className="space-y-4 border-t border-border px-4 pb-4 pt-4">
                      {narrative.trim() ? (
                        <div>
                          <div className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">Full Narrative</div>
                          <div className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/20 p-4 text-sm leading-relaxed text-foreground/80">
                            {narrative}
                          </div>
                        </div>
                      ) : null}
                      {kws.length > 0 ? (
                        <div>
                          <div className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">Identity</div>
                          <div className="flex flex-wrap gap-1.5">
                            {kws.map((kw, i) => (
                              <span
                                key={`${kw}-${i}`}
                                className="rounded-full border border-purple-500/20 bg-purple-500/10 px-2 py-1 text-xs text-purple-300"
                              >
                                {kw}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {vals.length > 0 ? (
                        <div>
                          <div className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">Core Values</div>
                          <div className="flex flex-wrap gap-1.5">
                            {vals.map((v, i) => (
                              <span
                                key={`${v}-${i}`}
                                className="rounded-full border border-primary/20 bg-primary/10 px-2 py-1 text-xs text-primary"
                              >
                                {v}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {bio.notable_changes ? (
                        <div>
                          <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">What Changed</div>
                          <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200/90">
                            {bio.notable_changes}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function worldModelSortKey(x) {
  return new Date(x.updated_date || x.created_date || 0).getTime();
}

function WorldModelEntryCard({ item, historyOpen, onToggleHistory, onRemove }) {
  const cat = normalizeWorldModelCategory(item.category);
  const meta = WORLD_MODEL_CATEGORY_META[cat];
  const label = displayWorldModelLabel(item);
  const history = Array.isArray(item.history) ? [...item.history].reverse() : [];
  const when = item.updated_date || item.created_date;

  return (
    <Panel className="border-border/80">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onToggleHistory}
          className="mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          title={historyOpen ? 'Hide update history' : 'Show update history'}
        >
          {historyOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{label}</span>
            <span className="rounded-md border border-border bg-muted/30 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {meta?.label || cat}
            </span>
            {item.archived ? (
              <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-200/90">
                archived
              </span>
            ) : null}
            <span className="text-[11px] text-muted-foreground">
              {Math.round((item.confidence ?? 0.8) * 100)}% confidence
            </span>
            {item.last_updated_by ? (
              <span className="text-[11px] text-muted-foreground">· {item.last_updated_by}</span>
            ) : null}
          </div>
          {item.value ? (
            <div className="mt-2 rounded-lg border border-primary/15 bg-primary/5 px-2.5 py-1.5 text-xs">
              <span className="font-medium text-primary/90">Current value: </span>
              <span className="text-foreground/90">{item.value}</span>
            </div>
          ) : null}
          {item.description ? (
            <p className="mt-2 text-sm leading-relaxed text-foreground/85">
              {humanizeUnityRationaleForDisplay(item.description)}
            </p>
          ) : null}
          {item.evidence ? (
            <p className="mt-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground/70">Evidence: </span>
              {item.evidence}
            </p>
          ) : null}
          <div className="mt-1 break-words text-[10px] text-muted-foreground/80">
            Key{' '}
            <code className="break-all rounded bg-muted/50 px-1 font-mono text-[10px]">{item.key || itemKeyForRecord(item)}</code>
            {when ? ` · updated ${moment(when).fromNow()}` : null}
          </div>
        </div>
        <Button type="button" variant="ghost" size="icon" className="shrink-0" onClick={() => onRemove(item.id)} title="Delete">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {historyOpen ? (
        <div className="mt-3 border-t border-border pt-3 pl-8">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Update history ({history.length})
          </div>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground">No history entries yet. Edits and extractions append here.</p>
          ) : (
            <ul className="space-y-2">
              {history.map((h, idx) => (
                <li
                  key={`${item.id}-h-${idx}-${h.at || idx}`}
                  className="rounded-lg border border-border/60 bg-muted/15 px-3 py-2 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                    {h.at ? <span>{moment(h.at).format('MMM D, YYYY h:mm A')}</span> : null}
                    {h.source ? (
                      <span className="rounded bg-muted/50 px-1.5 py-0.5 font-medium text-foreground/80">{h.source}</span>
                    ) : null}
                    {typeof h.confidence === 'number' ? (
                      <span>{Math.round(h.confidence * 100)}% at snapshot</span>
                    ) : null}
                  </div>
                  {h.note ? <p className="mt-1 text-[11px] italic text-muted-foreground">{h.note}</p> : null}
                  {h.value ? (
                    <p className="mt-1 text-foreground/90">
                      <span className="text-muted-foreground">Value: </span>
                      {h.value}
                    </p>
                  ) : null}
                  {h.description ? (
                    <p className="mt-1 whitespace-pre-wrap text-foreground/85">
                      {humanizeUnityRationaleForDisplay(h.description)}
                    </p>
                  ) : null}
                  {h.evidence ? (
                    <p className="mt-1 text-muted-foreground">
                      <span className="text-foreground/60">Evidence: </span>
                      {h.evidence}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </Panel>
  );
}

export function WorldModelPage() {
  const { WorldModel, BeliefStore, PipelineRun, LongTermMemory, TemporalEvent } = useScopedEntities();
  const [items, setItems] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [form, setForm] = useState({
    label: '',
    category: 'self',
    value: '',
    description: '',
    confidence: '0.8',
    lastUpdatedBy: 'manual',
  });
  const [extracting, setExtracting] = useState(false);
  const [addingWorldEntry, setAddingWorldEntry] = useState(false);
  const [openHistoryIds, setOpenHistoryIds] = useState(() => new Set());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await WorldModel.list('-updated_date', 200));
    } finally {
      setLoading(false);
    }
  }, [WorldModel]);

  useEffect(() => {
    load();
  }, [load]);

  useMindStorageRefresh(load);

  const toggleHistory = (id) => {
    setOpenHistoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const createItem = async () => {
    if (!form.label.trim() || !form.description.trim()) return;
    setAddingWorldEntry(true);
    try {
      const payload = buildWorldModelCreatePayload({
        category: form.category,
        label: form.label.trim(),
        description: form.description.trim(),
        value: form.value.trim(),
        confidence: Number(form.confidence) || 0.8,
        last_updated_by: form.lastUpdatedBy.trim() || 'manual',
      });
      await WorldModel.create(payload);
      setForm({
        label: '',
        category: 'self',
        value: '',
        description: '',
        confidence: '0.8',
        lastUpdatedBy: 'manual',
      });
      await load();
      notifyMindStorageChanged({ source: 'world-model' });
    } finally {
      setAddingWorldEntry(false);
    }
  };

  const extractWorldModel = async () => {
    setExtracting(true);
    try {
      const [runsRaw, beliefs, existingRows, memories, eventsRaw] = await Promise.all([
        PipelineRun.list('-created_date', 6),
        BeliefStore.list('-created_date', 20),
        WorldModel.list('-updated_date', 200),
        LongTermMemory.list('-created_date', 12),
        TemporalEvent.list('-created_date', 20),
      ]);
      const runs = excludeCheckpointPipelineRuns(runsRaw);
      const events = temporalEventsExcludingPauseNoise(eventsRaw);
      let current = [...existingRows];
      const result = await invokeLLM({
        prompt: `Build or refine this mind's world model for MetaSelf-CognitiveStack (graph pipeline, long-term memory, beliefs, temporal timeline, consolidation).

Sources:
- Recent Voice outputs from pipeline runs
- Existing world-model rows (merge by meaning; same real-world fact = one row)
- Recent belief store statements
- Recent long-term memories
- Temporal timeline events

Return JSON { "items": [ ... ] }. Each item MUST have:
- name (string, short label — we store it as "label")
- category: one of self, environment, relationship, goal, belief, event
  (legacy synonyms OK: goals→goal, beliefs→belief, relationships→relationship, significant_events→event, constraints/capabilities map to belief/self)
- description (string, concrete current state)
- value (optional string: compact "current value" if distinct from description)
- confidence (number 0-1)
- evidence (string: cite runs / beliefs / memories / events)

RECENT VOICE OUTPUTS:
${runs.map((run) => run.final_output).filter(Boolean).join('\n\n').slice(0, 5000)}

EXISTING WORLD MODEL:
${current.map((i) => `- [${normalizeWorldModelCategory(i.category)}] ${displayWorldModelLabel(i)}: ${truncate(i.description, 160)}`).join('\n').slice(0, 2800)}

RECENT BELIEFS:
${beliefs.map((b) => `- ${b.statement} (conf ${b.confidence ?? 0.5})`).join('\n').slice(0, 2500)}

RECENT MEMORIES:
${memories.map((m) => `- ${m.title}: ${truncate(m.content, 140)}`).join('\n').slice(0, 2500)}

TIMELINE EVENTS:
${events.map((e) => `- ${e.title}: ${truncate(e.details, 140)}`).join('\n').slice(0, 2500)}
`,
        response_json_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  label: { type: 'string' },
                  category: { type: 'string' },
                  description: { type: 'string' },
                  value: { type: 'string' },
                  confidence: { type: 'number' },
                  evidence: { type: 'string' },
                },
              },
            },
          },
        },
      });

      for (const raw of result.items || []) {
        const llmLabel = String(raw.label || raw.name || '').trim();
        if (!llmLabel) continue;
        const canon = normalizeWorldModelCategory(raw.category);
        const key = stableWorldModelKey(canon, llmLabel);
        const existing = current.find((r) => itemKeyForRecord(r) === key);
        if (existing) {
          const patch = buildWorldModelUpdatePayload(
            existing,
            {
              description: raw.description,
              confidence: raw.confidence,
              evidence: raw.evidence,
              value: raw.value,
              category: canon,
              label: llmLabel,
              name: llmLabel,
              key,
              last_updated_by: 'extract-from-runs',
            },
            'extract-from-runs',
            'Extract from Runs'
          );
          const updatedRecord = await WorldModel.update(existing.id, patch);
          if (updatedRecord) {
            const ix = current.findIndex((r) => r.id === existing.id);
            if (ix >= 0) current[ix] = updatedRecord;
          }
        } else {
          const created = await WorldModel.create(
            buildWorldModelCreatePayload({
              category: canon,
              label: llmLabel,
              description: raw.description,
              value: raw.value,
              confidence: raw.confidence,
              last_updated_by: 'extract-from-runs',
              evidence: raw.evidence,
              history: [
                newWorldModelHistoryEntry({
                  source: 'extract-from-runs',
                  description: raw.description,
                  value: raw.value,
                  confidence: raw.confidence,
                  evidence: raw.evidence,
                  note: 'Created by Extract from Runs',
                }),
              ],
            })
          );
          current.push(created);
        }
      }
      await load();
      notifyMindStorageChanged({ source: 'world-model' });
    } finally {
      setExtracting(false);
    }
  };

  const removeItem = async (id) => {
    await WorldModel.delete(id);
    setOpenHistoryIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    await load();
    notifyMindStorageChanged({ source: 'world-model' });
  };

  const visibleItems = useMemo(
    () => (showArchived ? items : items.filter((i) => !i.archived)),
    [items, showArchived]
  );

  const itemsByCategory = useMemo(() => {
    const map = Object.fromEntries(WORLD_MODEL_CATEGORY_ORDER.map((k) => [k, []]));
    map.__other = [];
    for (const i of visibleItems) {
      const c = normalizeWorldModelCategory(i.category);
      if (WORLD_MODEL_CATEGORY_ORDER.includes(c)) map[c].push(i);
      else map.__other.push(i);
    }
    for (const k of WORLD_MODEL_CATEGORY_ORDER) {
      map[k].sort((a, b) => worldModelSortKey(b) - worldModelSortKey(a));
    }
    map.__other.sort((a, b) => worldModelSortKey(b) - worldModelSortKey(a));
    return map;
  }, [visibleItems]);

  return (
    <PageShell
      icon={Globe}
      title="World Model"
      description="Structured snapshot of what this mind currently treats as true about itself, the situation, others, goals, and notable events. Category “self” is structural (slow constraints); narrative continuity lives on the Mind Self page. Rows feed the graph pipeline as STRUCTURAL_SELF_JSON for key modules. Saved runs also merge Integration’s INTEGRATION_JSON (including broadcast winners and unity rationale) into new rows; held beliefs live primarily on Belief Map with BELIEF_REVISIONS reinforcement from the pipeline. Consolidation may decay stale confidence and archive weak rows. Each entry keeps a history of updates."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
          <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => load()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </Button>
          <Button type="button" onClick={() => void extractWorldModel()} disabled={extracting || addingWorldEntry || loading} className="gap-2">
            {extracting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Extract from Runs
          </Button>
        </div>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <MindScopeTabs />
      </div>
      <Panel className="mb-6 border-border/80 bg-muted/10">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Entries use categories <strong className="text-foreground/90">self</strong>,{' '}
          <strong className="text-foreground/90">environment</strong>,{' '}
          <strong className="text-foreground/90">relationship</strong>,{' '}
          <strong className="text-foreground/90">goal</strong>, <strong className="text-foreground/90">belief</strong>, and{' '}
          <strong className="text-foreground/90">event</strong>. Each has a stable <code className="text-xs">key</code>, optional{' '}
          <code className="text-xs">value</code> for a compact state line, and an <code className="text-xs">history</code> array of
          past versions (who updated it, when, and what changed). Older data using plural or legacy category names is mapped
          automatically.
        </p>
      </Panel>

      {loading && items.length === 0 ? (
        <div className="mb-8 flex justify-center py-16">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        </div>
      ) : (
      <div className="mb-8 space-y-6">
        <div className="text-sm font-semibold text-foreground">By category</div>
        {WORLD_MODEL_CATEGORY_ORDER.map((catKey) => {
          const list = itemsByCategory[catKey] || [];
          const meta = WORLD_MODEL_CATEGORY_META[catKey];
          return (
            <Panel key={catKey} className="border-border/80">
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <h3 className="text-base font-semibold text-foreground">{meta.label}</h3>
                  <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground">{meta.blurb}</p>
                </div>
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {list.length} {list.length === 1 ? 'item' : 'items'}
                </span>
              </div>
              {list.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No entries yet. Add one below or run Extract from Runs.</p>
              ) : (
                <div className="mt-4 space-y-3">
                  {list.map((item) => (
                    <WorldModelEntryCard
                      key={item.id}
                      item={item}
                      historyOpen={openHistoryIds.has(item.id)}
                      onToggleHistory={() => toggleHistory(item.id)}
                      onRemove={removeItem}
                    />
                  ))}
                </div>
              )}
            </Panel>
          );
        })}
      </div>
      )}

      {itemsByCategory.__other?.length ? (
        <Panel className="mb-8 border-amber-500/25 bg-amber-500/5">
          <div className="mb-1 text-sm font-semibold text-amber-200/95">Other / legacy categories</div>
          <p className="mb-4 text-xs text-muted-foreground">
            These rows did not map to the six canonical categories. They are kept visible until you edit or re-extract.
          </p>
          <div className="space-y-3">
            {itemsByCategory.__other.map((item) => (
              <WorldModelEntryCard
                key={item.id}
                item={item}
                historyOpen={openHistoryIds.has(item.id)}
                onToggleHistory={() => toggleHistory(item.id)}
                onRemove={removeItem}
              />
            ))}
          </div>
        </Panel>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <Panel className="space-y-3">
          <div className="text-sm font-semibold">Add world-model entry</div>
          <Input
            value={form.label}
            onChange={(e) => setForm((prev) => ({ ...prev, label: e.target.value }))}
            placeholder="Label (required)"
          />
          <select
            value={form.category}
            onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {WORLD_MODEL_CATEGORY_ORDER.map((key) => (
              <option key={key} value={key}>
                {WORLD_MODEL_CATEGORY_META[key].label}
              </option>
            ))}
          </select>
          <Input
            value={form.value}
            onChange={(e) => setForm((prev) => ({ ...prev, value: e.target.value }))}
            placeholder="Current value (optional)"
          />
          <Input
            value={form.confidence}
            onChange={(e) => setForm((prev) => ({ ...prev, confidence: e.target.value }))}
            placeholder="Confidence 0.0–1.0"
          />
          <Input
            value={form.lastUpdatedBy}
            onChange={(e) => setForm((prev) => ({ ...prev, lastUpdatedBy: e.target.value }))}
            placeholder="Last updated by (e.g. manual, Memory module)"
          />
          <Textarea
            value={form.description}
            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
            placeholder="Description — what this entry represents"
            className="min-h-[140px]"
          />
          <Button
            type="button"
            onClick={() => void createItem()}
            disabled={addingWorldEntry || extracting || !form.label.trim() || !form.description.trim()}
            className="w-full gap-2"
          >
            {addingWorldEntry ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add entry
          </Button>
        </Panel>
        <div className="space-y-3">
          {items.length === 0 ? (
            <EmptyState
              title="No world-model rows yet"
              description="Use the form to add facts manually, or Extract from Runs to infer them from recent Voice output, beliefs, memories, and timeline events."
            />
          ) : (
            <Panel className="border-dashed border-border/80 bg-muted/5">
              <p className="text-sm text-muted-foreground">
                All entries are listed under <strong className="text-foreground/90">By category</strong> above. Expand the
                chevron on any row to see its full <strong className="text-foreground/90">update history</strong> (manual
                edits, Extract from Runs, consolidation, or scheduled refreshes).
              </p>
            </Panel>
          )}
        </div>
      </div>
    </PageShell>
  );
}
const CURIOSITY_STATUS_STYLES = {
  open: 'border-sky-500/30 bg-sky-500/5 text-sky-900 dark:text-sky-300',
  pursuing: 'border-primary/30 bg-primary/5 text-primary',
  resolved: 'border-green-500/30 bg-green-500/5 text-green-800 dark:text-green-400',
  dormant: 'border-border bg-muted/20 text-muted-foreground',
};

const CURIOSITY_QUESTION_FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'pursuing', label: 'Pursuing' },
  { value: 'resolved', label: 'Resolved' },
];

/** True if any item in this thread cluster has a live full/quick pursue slot (page store). */
function curiosityClusterHasActivePursuit(clusterItems, pursuitsState) {
  return (Array.isArray(clusterItems) ? clusterItems : []).some(
    (i) => pursuitsState[String(i.id)]?.running === true
  );
}

function curiosityPipelineActiveModuleId(moduleStatuses) {
  return getFirstProcessingModuleId(moduleStatuses);
}

/** Fallback when a pursuit id is listed but the merged entry is incomplete (defensive). */
function fallbackCuriosityPursuitEntryFromItems(curiosityId, itemList) {
  const item = itemList.find((i) => String(i.id) === String(curiosityId));
  return {
    pursuitProgress: null,
    curiosityPipelineUi: initialCuriosityPipelineUi(),
    running: false,
    question: String(item?.question || '').trim() || undefined,
  };
}

const CURIOSITY_QUESTION_PREVIEW_CHARS = 280;
const CURIOSITY_QUESTION_PREVIEW_CHARS_COMPACT = 160;
const CURIOSITY_QUESTION_PREVIEW_MAX_LINES = 4;
const CURIOSITY_BODY_COLLAPSE_CHARS = 400;
const CURIOSITY_BODY_MAX_LINES = 6;

function curiosityBodyIsLong(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return s.length > CURIOSITY_BODY_COLLAPSE_CHARS || s.split(/\n/).length > CURIOSITY_BODY_MAX_LINES;
}

function curiosityQuestionIsLong(text, compact) {
  const s = String(text || '').trim();
  if (!s) return false;
  const cap = compact ? CURIOSITY_QUESTION_PREVIEW_CHARS_COMPACT : CURIOSITY_QUESTION_PREVIEW_CHARS;
  return s.length > cap || s.split(/\n/).length > CURIOSITY_QUESTION_PREVIEW_MAX_LINES;
}

/** Keeps the curiosity list scannable: short text inline, long questions behind expand. */
function CuriosityClampedQuestion({ text, className, compact = false }) {
  const s = String(text || '').trim();
  const long = curiosityQuestionIsLong(s, compact);
  const [expanded, setExpanded] = useState(false);
  if (!s) return null;
  const cap = compact ? CURIOSITY_QUESTION_PREVIEW_CHARS_COMPACT : CURIOSITY_QUESTION_PREVIEW_CHARS;
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
        {expanded ? 'Show less' : 'Show full question'}
      </button>
    </div>
  );
}

function CuriosityCollapsibleThread({ text }) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (!curiosityBodyIsLong(s)) {
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

function CuriosityCollapsibleResolution({ text }) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (!curiosityBodyIsLong(s)) {
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

function CuriosityCollapsibleLogDetail({ detail }) {
  const s = String(detail || '').trim();
  if (!s) return null;
  if (!curiosityBodyIsLong(s)) {
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

/**
 * Mobile expanded curiosity pipeline must render above AppLayout’s sticky header (z-30); `main` is z-20 so
 * fixed descendants cannot win — portal to `document.body` with a higher z-index.
 */
const CuriosityPipelineMobilePortal = forwardRef(function CuriosityPipelineMobilePortal(
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

export function CuriosityPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { isMirror, profile: mindStorageProfile } = useMindScope();
  const se = useScopedEntities();
  const curiosityStore = se.CuriosityItem;
  const dashboardFocusConsumedRef = useRef(null);
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [consolidatingQuestions, setConsolidatingQuestions] = useState(false);
  const [addingCuriosity, setAddingCuriosity] = useState(false);
  const { pursuits } = useSyncExternalStore(
    subscribeCuriosityPagePursuit,
    getCuriosityPagePursuitSnapshot,
    getCuriosityPagePursuitSnapshot
  );
  const interactiveGraphOrStreamBusy = useSyncExternalStore(
    subscribeInteractiveGraphOrStreamActivity,
    getInteractiveGraphOrStreamActivitySnapshot,
    getInteractiveGraphOrStreamActivitySnapshot
  );
  /** Only this tab's page store drives the pipeline carousel (avoids orphaned DB `pursuing` after reload). */
  /** Deterministic order so the carousel does not jump when the store re-emits (Object.keys order alone can vary). */
  const pursuitIds = useMemo(
    () =>
      Object.keys(pursuits).sort((a, b) =>
        String(a).localeCompare(String(b), undefined, { numeric: true })
      ),
    [pursuits]
  );
  const anyPursuitRunning = useMemo(
    () => Object.values(pursuits).some((p) => p.running),
    [pursuits]
  );
  const pageSystemAccent = isMirror ? 'b' : 'a';
  const entryAccent = (entry) =>
    entry?.mindStorageProfile === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR ? 'b' : 'a';
  const [pipelineCarouselIndex, setPipelineCarouselIndex] = useState(0);
  const curiosityPipelineLogRef = useRef(null);
  const curiosityPipelinePanelRef = useRef(null);
  const curiosityPipelineCarouselRef = useRef(null);
  const prevAnyPursuitRunningRef = useRef(false);
  const curiosityPipelineLayoutSyncMountedRef = useRef(false);
  const prevPursuitCountRef = useRef(0);
  /** Synchronous guard so two rapid clicks cannot start two group runs before React re-renders. */
  const threadGroupPursueLockedRef = useRef(false);
  /** Which cluster root id is running a batch (null = idle); drives button spinners. */
  const [threadGroupPursueRootId, setThreadGroupPursueRootId] = useState(null);
  /** Default collapsed on small screens so the fixed fullscreen pipeline layer (z-50) does not cover the list and block "Pursue group". */
  const [curiosityMobileSheetExpanded, setCuriosityMobileSheetExpanded] = useState(false);
  const isMaxLg = useSyncExternalStore(subscribeMaxWidthLg, getMaxWidthLgSnapshot, () => false);
  /** When true, fullscreen panel is portaled so it stacks above the app chrome (see CuriosityPipelineMobilePortal). */
  const portalMobileCuriosityPipeline = curiosityMobileSheetExpanded && isMaxLg;
  /** Desktop: entire pipeline panel starts collapsed so the question list is front-and-centre on page load. */
  const [curiosityPipelinePanelOpen, setCuriosityPipelinePanelOpen] = useState(false);
  /** Desktop only: execution log starts collapsed so the pipeline panel does not dominate the page. */
  const [curiosityDesktopLogExpanded, setCuriosityDesktopLogExpanded] = useState(false);
  const [curiosityQuestionFilter, setCuriosityQuestionFilter] = useState('open');
  /** Which thread roots are expanded; default none = collapsed (root + sub-count only). */
  const [expandedCuriosityThreadRoots, setExpandedCuriosityThreadRoots] = useState(() => new Set());
  const cognitiveModuleCount = useMemo(() => COGNITIVE_MODULES.length, []);

  const activePursuitId = pursuitIds[pipelineCarouselIndex] ?? null;
  const activePursuit = useMemo(() => {
    if (!activePursuitId) return null;
    return pursuits[activePursuitId] ?? fallbackCuriosityPursuitEntryFromItems(activePursuitId, items);
  }, [activePursuitId, pursuits, items]);
  const activeCuriosityPipelineUi = useMemo(() => {
    if (!activePursuit) return null;
    const raw = activePursuit.curiosityPipelineUi;
    if (pursuitShowsLivePipelineChrome(activePursuit)) return raw;
    return freshPursuitPipelineUiForNewGraphRun(raw);
  }, [activePursuit]);
  const activePursuitProgress = activePursuit?.pursuitProgress ?? null;

  const interruptedResumeCuriosityItem = useMemo(
    () => (activePursuitId ? items.find((i) => String(i.id) === String(activePursuitId)) : null),
    [activePursuitId, items]
  );

  const curiosityPipelineRootClassName = useMemo(
    () =>
      portalMobileCuriosityPipeline
        ? 'min-w-0 fixed inset-0 z-[70] flex min-h-0 flex-col bg-background pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]'
        : cn(
            'min-w-0',
            curiosityMobileSheetExpanded
              ? 'max-lg:fixed max-lg:inset-0 max-lg:z-50 max-lg:flex max-lg:flex-col max-lg:bg-background max-lg:pt-[env(safe-area-inset-top,0px)]'
              : 'max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-40 max-lg:px-2 max-lg:pt-1',
            'lg:relative lg:z-auto lg:bg-transparent lg:pt-0 lg:scroll-mt-[calc(env(safe-area-inset-top,0px)+4.5rem)]'
          ),
    [portalMobileCuriosityPipeline, curiosityMobileSheetExpanded]
  );

  useEffect(() => {
    if (!portalMobileCuriosityPipeline) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [portalMobileCuriosityPipeline]);

  const pipelineLogScrollRef = useRef({ pursuitId: null, len: 0 });

  useLayoutEffect(() => {
    const el = curiosityPipelineLogRef.current;
    const log = activeCuriosityPipelineUi?.executionLog;
    if (!el || !Array.isArray(log)) return;
    const len = log.length;
    const pid = activePursuitId;
    const prev = pipelineLogScrollRef.current;

    if (pid !== prev.pursuitId) {
      pipelineLogScrollRef.current = { pursuitId: pid, len };
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (len < prev.len) {
      pipelineLogScrollRef.current = { pursuitId: pid, len };
      return;
    }
    if (len === prev.len) return;

    const threshold = 140;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
    pipelineLogScrollRef.current = { pursuitId: pid, len };
  }, [activePursuitId, activeCuriosityPipelineUi]);

  const scrollPipelineCarouselToIndex = useCallback((index) => {
    const el = curiosityPipelineCarouselRef.current;
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
    const el = curiosityPipelineCarouselRef.current;
    if (!el) return;
    const w = el.clientWidth;
    if (w <= 0) return;
    const max = pursuitIds.length - 1;
    if (max < 0) return;
    const i = Math.min(max, Math.max(0, Math.floor((el.scrollLeft + w * 0.35) / w)));
    setPipelineCarouselIndex((prev) => (prev === i ? prev : i));
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
      const snap = getCuriosityPagePursuitSnapshot();
      if (!snap.pursuits[focusId]) {
        const item = items.find((i) => String(i.id) === focusId);
        if (item) {
          upsertCuriosityPursuit(focusId, {
            running: false,
            interruptedByReload: false,
            pursuitProgress: null,
            curiosityPipelineUi: initialCuriosityPipelineUi(),
            question: String(item.question || '').trim() || undefined,
            mindStorageProfile,
          });
        }
      }
      if (dashboardFocusConsumedRef.current === focusId) return;
      dashboardFocusConsumedRef.current = focusId;
      setCuriosityMobileSheetExpanded(true);
      requestAnimationFrame(() => {
        document.getElementById(`curiosity-focus-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

    setCuriosityMobileSheetExpanded(true);
    setCuriosityPipelinePanelOpen(true);
    setCuriosityDesktopLogExpanded(true);

    setPipelineCarouselIndex(idx);
    requestAnimationFrame(() => {
      scrollPipelineCarouselToIndex(idx);
      curiosityPipelinePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    requestAnimationFrame(() => {
      document.getElementById(`curiosity-focus-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  /**
   * Nested vertical scrollers (execution log, whole-sheet overflow) often consume touch before the
   * horizontal scrollport sees a pan. When ≥2 pursuits, detect horizontal intent and drive scrollLeft.
   */
  useEffect(() => {
    const root = curiosityPipelineCarouselRef.current;
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
    if (!curiosityPipelineLayoutSyncMountedRef.current) {
      curiosityPipelineLayoutSyncMountedRef.current = true;
      prevAnyPursuitRunningRef.current = anyPursuitRunning;
      return;
    }
    if (anyPursuitRunning && !prevAnyPursuitRunningRef.current) {
      /* Mobile uses a fixed bottom dock; scrollIntoView cannot bring it into the main column. */
      if (typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches) {
        curiosityPipelinePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
    prevAnyPursuitRunningRef.current = anyPursuitRunning;
  }, [anyPursuitRunning]);

  const scheduleBlocked = interactiveGraphOrStreamBusy || anyPursuitRunning;

  const load = useCallback(async () => {
    setLoading(true);
    const raw = await curiosityStore.listAll('-created_date');
    const sorted = [...raw].sort((a, b) => {
      const pa = effectiveItemPriority(a);
      const pb = effectiveItemPriority(b);
      if (pb !== pa) return pb - pa;
      return new Date(b.created_date).getTime() - new Date(a.created_date).getTime();
    });
    setItems(sorted);
    setLoading(false);
  }, [curiosityStore]);

  useEffect(() => {
    load();
  }, [load]);

  useMindStorageRefresh(load);

  const addItem = async () => {
    if (!draft.trim()) return;
    setAddingCuriosity(true);
    try {
      const created = await curiosityStore.create({
        question: draft.trim(),
        status: 'open',
        priority: 0.5,
        times_returned_to: 0,
        source: 'manual',
      });
      try {
        await finalizeNewCuriosityRoot(created, curiosityStore);
      } catch {
        /* ignore */
      }
      setDraft('');
      await load();
      notifyMindStorageChanged({ source: 'curiosity' });
    } finally {
      setAddingCuriosity(false);
    }
  };

  const generateItems = async () => {
    setGenerating(true);
    try {
      const [memories, beliefs, runs, existingOpen] = await Promise.all([
        se.LongTermMemory.list('-created_date', 20),
        se.BeliefStore.filter({ status: 'active' }, '-created_date', 25),
        se.PipelineRun.list('-created_date', 10),
        curiosityStore.filter({ status: 'open' }, '-created_date', 30),
      ]);

      const beliefsForPrompt = beliefs.length
        ? beliefs.slice(0, 12)
        : (await se.BeliefStore.list('-created_date', 15)).slice(0, 12);

      const runsText = runs
        .map((run) => truncate(String(run.final_output || ''), 500))
        .filter(Boolean)
        .join('\n---\n');

      const result = await invokeLLM({
        prompt: `You are the Curiosity module of a cognitive AI. Based on what this mind has experienced and currently believes, generate genuine unprompted questions it wants to pursue.

RECENT EXPERIENCES:
${memories
  .slice(0, 8)
  .map((m) => `[${m.memory_type || 'memory'}] ${String(m.content || m.title || '').slice(0, 220)}`)
  .join('\n')}

CURRENT BELIEFS:
${beliefsForPrompt
  .map((b) => `- "${String(b.statement || b.title || '').slice(0, 200)}" (confidence: ${b.confidence ?? 0.5})`)
  .join('\n')}

RECENT PIPELINE VOICES (excerpts):
${runsText || '(none yet)'}

EXISTING OPEN QUESTIONS (do not duplicate or paraphrase closely):
${existingOpen
  .slice(0, 10)
  .map((q) => `- ${String(q.question || '').slice(0, 180)}`)
  .join('\n')}

Generate 5-8 curiosity items. Each should be a genuine intellectual pursuit — not only a follow-up, but something this mind intrinsically wants to understand. Mix philosophical, self-referential, and empirical angles where appropriate.

For each item include "priority" (0.0–1.0): use the full range. At least one item should be clearly high urgency and at least one lower; do not default every priority to 0.5.`,
        response_json_schema: {
          type: 'object',
          properties: {
            curiosities: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  question: { type: 'string' },
                  pursuit_thread: { type: 'string' },
                  priority: { type: 'number' },
                },
              },
            },
          },
        },
      });

      const list = result.curiosities || result.items || [];
      let n = 0;
      for (const c of list) {
        const q = String(c.question || '').trim();
        if (!q) continue;
        const priority =
          typeof c.priority === 'number' && !Number.isNaN(c.priority)
            ? clampPriority(c.priority, DEFAULT_MANUAL_LIKE_PRIORITY)
            : DEFAULT_MANUAL_LIKE_PRIORITY;
        const created = await curiosityStore.create({
          question: q,
          pursuit_thread: String(c.pursuit_thread || '').trim(),
          priority,
          status: 'open',
          source: 'llm-generated',
          times_returned_to: 0,
        });
        try {
          await finalizeNewCuriosityRoot(created, curiosityStore);
        } catch {
          /* ignore */
        }
        n += 1;
      }

      if (n > 0) {
        await se.TemporalEvent.create({
          title: 'curiosity_sparked',
          details: `${n} new curiosity thread(s) generated`,
          source: 'curiosity',
        });
      }

      await load();
      notifyMindStorageChanged({ source: 'curiosity' });
      notifyMindStorageChanged({ source: 'temporal' });
      if (n === 0) {
        toast({ title: 'No questions generated', description: 'Try more pipeline runs or memories first.' });
      }
    } catch (e) {
      console.error(e);
      toast({
        title: 'Generate failed',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setGenerating(false);
    }
  };

  const consolidateCuriosityQuestions = async () => {
    if (isMirror) return;
    setConsolidatingQuestions(true);
    try {
      const snap = getCuriosityPagePursuitSnapshot();
      const skipRunningIds = new Set();
      for (const [id, e] of Object.entries(snap.pursuits)) {
        if (e?.running) skipRunningIds.add(id);
      }
      const result = await consolidateDuplicateCuriosityItemsInStore({ skipRunningIds });
      const extra =
        result.skippedRunning != null && result.skippedRunning > 0
          ? ` (${result.skippedRunning} cluster(s) skipped — active pursuit.)`
          : '';
      toast({ title: 'Questions consolidated', description: `${result.message}${extra}` });
      await load();
    } catch (e) {
      console.error(e);
      toast({
        title: 'Consolidate failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setConsolidatingQuestions(false);
    }
  };

  const pursueItemFull = async (item) => {
    if (isCooperativePauseAllExternalHoldActive()) {
      setCooperativePauseAllExternalHold(false);
      void flushSchedulerDueTasksNow();
    }
    const cid = item.id;
    const ac = new AbortController();
    registerCuriosityPursuitGraphAbort(cid, ac);
    const prevUi = getCuriosityPagePursuitSnapshot().pursuits[cid]?.curiosityPipelineUi;
    upsertCuriosityPursuit(cid, {
      running: true,
      interruptedByReload: false,
      cooperativePaused: false,
      pursuitProgress: 'Starting…',
      curiosityPipelineUi: freshPursuitPipelineUiForNewGraphRun(prevUi),
      question: String(item.question || '').trim() || undefined,
      mindStorageProfile,
    });
    let pipelinePaused = false;
    try {
      const { pipelinePaused: didPause } = await runCuriosityDeepPursuitChain(item, {
        mindStorageProfile,
        signal: ac.signal,
        onProgress: (label) => {
          patchCuriosityPursuitEntry(cid, { pursuitProgress: label });
          updateCuriosityPursuitPipelineUiForId(cid, (prev) => ({
            ...prev,
            moduleStatuses: {},
            moduleOutputs: {},
            loopCount: 0,
            finalOutput: '',
            executionLog: [...prev.executionLog, { time: Date.now(), msg: `── ${label} ──` }],
          }));
        },
        onPipelineSse: (evt) => {
          updateCuriosityPursuitPipelineUiForId(cid, (prev) => reduceCuriosityPipelineSse(prev, evt));
        },
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
        title: 'Pursuit failed',
        description: e instanceof Error ? e.message : String(e),
      });
      try {
        await curiosityStore.update(item.id, { status: 'open' });
      } catch {
        /* ignore */
      }
      await load();
      const prevUi = getCuriosityPagePursuitSnapshot().pursuits[cid]?.curiosityPipelineUi;
      updateCuriosityPursuitPipelineUiForId(cid, () => freshPursuitPipelineUiForNewGraphRun(prevUi));
    } finally {
      clearCuriosityPursuitGraphAbort(cid);
      if (pipelinePaused) {
        patchCuriosityPursuitEntry(cid, {
          running: false,
          interruptedByReload: false,
          cooperativePaused: true,
          pursuitProgress: 'Paused — cooperative checkpoint saved. Open Curiosity to continue.',
        });
        flushCuriosityPursuitsPersistNow();
      } else {
        patchCuriosityPursuitEntry(cid, {
          running: false,
          pursuitProgress: null,
          interruptedByReload: false,
          cooperativePaused: false,
        });
      }
    }
  };

  /** Clears execution log / module UI for this slot without removing it (keeps reruns + delay overrides). */
  const clearCuriosityPursuitExecutionLog = (curiosityId) => {
    const id = String(curiosityId || '');
    if (!id) return;
    const snap = getCuriosityPagePursuitSnapshot();
    if (snap.pursuits[id]?.running) return;
    const prevUi = snap.pursuits[id]?.curiosityPipelineUi;
    updateCuriosityPursuitPipelineUiForId(id, () => freshPursuitPipelineUiForNewGraphRun(prevUi));
  };

  const ensureCuriosityPursuitSlot = useCallback((item) => {
    const id = String(item.id);
    const prev = getCuriosityPagePursuitSnapshot().pursuits[id];
    upsertCuriosityPursuit(id, {
      running: false,
      interruptedByReload: false,
      cooperativePaused: false,
      pursuitProgress: null,
      question: String(item.question || '').trim() || undefined,
      curiosityPipelineUi: freshPursuitPipelineUiForNewGraphRun(prev?.curiosityPipelineUi),
      mindStorageProfile,
    });
  }, [mindStorageProfile]);

  /** Ensures the slot exists, selects it in the carousel, and reveals the panel (desktop + mobile) so run-limit inputs apply to this question. */
  const focusCuriosityPursuitSlot = useCallback(
    (item) => {
      ensureCuriosityPursuitSlot(item);
      const id = String(item?.id ?? '');
      if (!id) return;
      const snap = getCuriosityPagePursuitSnapshot();
      const ids = Object.keys(snap.pursuits).sort((a, b) =>
        String(a).localeCompare(String(b), undefined, { numeric: true })
      );
      const idx = ids.indexOf(id);
      if (idx >= 0) {
        setPipelineCarouselIndex(idx);
      }
      setCuriosityPipelinePanelOpen(true);
      setCuriosityMobileSheetExpanded(true);
      requestAnimationFrame(() => {
        if (idx >= 0) scrollPipelineCarouselToIndex(idx);
        curiosityPipelinePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },
    [ensureCuriosityPursuitSlot, scrollPipelineCarouselToIndex]
  );

  const quickReflectItem = async (item) => {
    const cid = item.id;
    upsertCuriosityPursuit(cid, {
      running: true,
      interruptedByReload: false,
      cooperativePaused: false,
      pursuitProgress: 'Quick reflect…',
      curiosityPipelineUi: initialCuriosityPipelineUi(),
      question: String(item.question || '').trim() || undefined,
      mindStorageProfile,
    });
    try {
      await curiosityStore.update(item.id, { status: 'pursuing' });
      await load();
      await runCuriosityPursuitLlmOnly(item, { mindStorageProfile });
      await load();
    } catch (e) {
      console.error(e);
      toast({
        title: 'Quick reflect failed',
        description: e instanceof Error ? e.message : String(e),
      });
      await curiosityStore.update(item.id, { status: 'open' });
      await load();
    } finally {
      removeCuriosityPursuit(cid);
    }
  };

  async function hasPendingPursuitForTarget(targetId) {
    const all = await ScheduledTask.list('-created_date', 120);
    const wantProfile = normalizeScheduledTaskMindStorageProfile(mindStorageProfile);
    return all.some(
      (t) =>
        t.task_type === 'curiosity_pursuit' &&
        (t.status || 'pending') === 'pending' &&
        t.target_curiosity_id === targetId &&
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
    const delay = Math.max(1, Math.floor(Number(rt.curiositySchedulePursuitDelayMinutes) || 15));
    if (await hasPendingPursuitForTarget(item.id)) {
      toast({ title: 'Already scheduled', description: 'A pending pursuit already targets this question.' });
      return;
    }
    const pursSlot = getCuriosityPagePursuitSnapshot().pursuits[item.id];
    const pursUi = pursSlot?.curiosityPipelineUi;
    await scheduleTask('curiosity_pursuit', delay, {
      target_curiosity_id: item.id,
      reason: `Curiosity: ${truncate(item.question, 120)}`,
      scheduled_by: 'user',
      mind_storage_profile: mindStorageProfile,
      ...(pursUi && pursUi.metacognitionMaxReruns != null
        ? { metacognition_max_reruns_override: pursUi.metacognitionMaxReruns }
        : {}),
      ...(pursUi && pursUi.metacognitionRerunDelayMinutes != null
        ? { metacognition_rerun_delay_minutes_override: pursUi.metacognitionRerunDelayMinutes }
        : {}),
    });
    toast({ title: 'Pursuit scheduled', description: `Runs in about ${delay} minutes.` });
    notifyMindStorageChanged({ source: 'scheduled-tasks' });
  };

  /**
   * Run full graph pursuit for each "lead" in this thread: full cluster from DB-shaped `items` (not filter-trimmed).
   * Omits children whose parent is also open/dormant in the same thread — the parent's deep chain covers them.
   */
  const runThreadGroupPursuit = async (fullClusterItems, clusterRootId) => {
    const rootKey = String(clusterRootId ?? '');
    const list = Array.isArray(fullClusterItems) ? fullClusterItems : [];

    if (threadGroupPursueRootId != null && threadGroupPursueRootId !== rootKey) {
      toast({
        title: 'Thread batch already running',
        description: 'Wait for the other thread batch to finish.',
      });
      return;
    }
    if (curiosityClusterHasActivePursuit(list, pursuits)) {
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
        const st = curiosityUiStatus(i, pursuits);
        const idStr = String(i.id);
        return (st === 'open' || st === 'dormant') && pursuits[idStr]?.running !== true;
      });
      const eligibleIds = new Set(eligible.map((t) => String(t.id)));
      const chainHeads = eligible.filter((it) => {
        const p = it.parent_curiosity_id;
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
          description:
            'No open or dormant questions here, or each eligible one is already running.',
        });
        return;
      }

      if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches) {
        setCuriosityMobileSheetExpanded(false);
      }

      toast({
        title: 'Pursuing thread',
        description: `${targets.length} lead question(s) will run in order (each may chain deeper).`,
      });
      for (const it of targets) {
        await pursueItemFull(it);
      }
      toast({
        title: 'Thread pursue complete',
        description: `Finished ${targets.length} run(s).`,
      });
    } catch (e) {
      console.error('[curiosity] thread group pursue', e);
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

  const setStatus = async (id, status) => {
    await curiosityStore.update(id, { status });
    await load();
    notifyMindStorageChanged({ source: 'curiosity' });
  };

  const deleteItem = async (id) => {
    await curiosityStore.delete(id);
    await load();
    notifyMindStorageChanged({ source: 'curiosity' });
  };

  const openItems = items.filter((i) => curiosityUiStatus(i, pursuits) === 'open');
  const pursuingItems = items.filter((i) => curiosityUiStatus(i, pursuits) === 'pursuing');
  const resolvedItems = items.filter((i) => curiosityUiStatus(i, pursuits) === 'resolved');
  const pursuitPrepCandidates = useMemo(
    () =>
      items.filter((i) => {
        const st = curiosityUiStatus(i, pursuits);
        return st === 'open' || st === 'dormant';
      }),
    [items, pursuits]
  );
  const clusters = useMemo(() => {
    const map = new Map();
    for (const item of items) {
      const root = item.root_curiosity_id || item.id;
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

  const filteredCuriosityClusters = useMemo(() => {
    if (curiosityQuestionFilter === 'all') return clusters;
    return clusters
      .map((c) => ({
        ...c,
        items: c.items.filter((i) => curiosityUiStatus(i, pursuits) === curiosityQuestionFilter),
      }))
      .filter((c) => c.items.length > 0);
  }, [clusters, curiosityQuestionFilter, pursuits]);

  const sortedFilteredCuriosityClusters = useMemo(() => {
    return [...filteredCuriosityClusters]
      .map((c) => ({
        ...c,
        _maxActiveP: maxActiveClusterPriority(c.items, pursuits, curiosityUiStatus),
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
  }, [filteredCuriosityClusters, pursuits]);

  const toggleCuriosityThreadExpanded = useCallback((rootId) => {
    const k = String(rootId);
    setExpandedCuriosityThreadRoots((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  return (
    <PageShell
      icon={ScanSearch}
      title="Curiosity Queue"
      description="Questions the mind generates for itself — the Curiosity module emits MAIN_QUESTION, URGENCY, THREADS, and optional FOLLOWUP_CURIOSITIES JSON; rank items, pursue with the full graph when enabled, and resolve."
      actions={
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => load()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </Button>
          <Button
            type="button"
            onClick={() => void generateItems()}
            disabled={generating || addingCuriosity || consolidatingQuestions}
            className="gap-2 border border-sky-500/30 bg-sky-500/10 text-sky-900 hover:bg-sky-500/20 dark:text-sky-200"
          >
            {generating ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Generate Questions
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void consolidateCuriosityQuestions()}
            disabled={isMirror || consolidatingQuestions || loading || generating || addingCuriosity}
            className="gap-2"
            title="Merge duplicate or paraphrased questions in the store"
          >
            {consolidatingQuestions ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Merge className="h-4 w-4" />
            )}
            Consolidate Questions
          </Button>
        </div>
      }
    >
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <MindScopeTabs />
          {isMirror ? (
            <span className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
              System B mirror — full graph pursuit and scheduled runs use the isolated mirror mind store.
            </span>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 text-center">
            <div className="text-2xl font-bold text-sky-800 dark:text-sky-300">{openItems.length}</div>
            <div className="text-xs text-muted-foreground">Open questions</div>
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
          {CURIOSITY_QUESTION_FILTER_OPTIONS.map(({ value, label }) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={curiosityQuestionFilter === value ? 'default' : 'outline'}
              className="h-8"
              onClick={() => setCuriosityQuestionFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>

        {(pursuitIds.length > 0 || pursuitPrepCandidates.length > 0) ? (
          <CuriosityPipelineMobilePortal
            ref={curiosityPipelinePanelRef}
            portal={portalMobileCuriosityPipeline}
            className={curiosityPipelineRootClassName}
          >
            <div
              className={cn(
                'space-y-3 rounded-xl border bg-card p-3 shadow-sm sm:p-4',
                pageSystemAccent === 'b'
                  ? 'border-red-500/40 shadow-[inset_4px_0_0_0_rgba(239,68,68,0.45)]'
                  : 'border-primary/25',
                curiosityMobileSheetExpanded
                  ? 'max-lg:mx-0 max-lg:mb-0 max-lg:flex max-lg:h-full max-lg:min-h-0 max-lg:flex-1 max-lg:flex-col max-lg:gap-3 max-lg:overflow-x-hidden max-lg:rounded-none max-lg:border-0 max-lg:shadow-none max-lg:max-h-none max-lg:pb-[env(safe-area-inset-bottom,0px)]'
                  : 'max-lg:mx-auto max-lg:space-y-0 max-lg:overflow-x-hidden max-lg:rounded-b-none max-lg:rounded-t-2xl max-lg:border-x-0 max-lg:border-b-0 max-lg:px-2 max-lg:py-1.5 max-lg:pb-[max(0.5rem,env(safe-area-inset-bottom,0px))] max-lg:shadow-[0_-6px_28px_rgba(0,0,0,0.14)] dark:max-lg:shadow-[0_-6px_28px_rgba(0,0,0,0.45)]'
              )}
            >
              <div
                className={cn(
                  'flex shrink-0 flex-wrap items-start justify-between gap-2',
                  curiosityMobileSheetExpanded &&
                    'max-lg:relative max-lg:z-[70] max-lg:border-b max-lg:border-border/60 max-lg:bg-background max-lg:pb-2',
                  !curiosityMobileSheetExpanded && 'max-lg:flex-nowrap max-lg:items-center max-lg:gap-1.5'
                )}
              >
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      'flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-semibold text-foreground',
                      !curiosityMobileSheetExpanded && 'max-lg:text-xs'
                    )}
                  >
                    <Layers className={cn('h-4 w-4 shrink-0', pageSystemAccent === 'b' ? 'text-red-400' : 'text-primary')} />
                    <span className="truncate">Curiosity pipeline</span>
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
                    const modName = getFirstProcessingModuleName(activeCuriosityPipelineUi?.moduleStatuses);
                    const line1 = modName ? `Module: ${modName}` : null;
                    const line2 = activePursuitProgress
                      ? formatPursuitThreadProgressLine(activePursuitProgress)
                      : null;
                    if (!line1 && !line2) return null;
                    return (
                      <div
                        className={cn(
                          'mt-1 space-y-0.5',
                          !curiosityMobileSheetExpanded && 'max-lg:hidden'
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
                  {activePursuit?.question ? (
                    <CuriosityClampedQuestion
                      text={activePursuit.question}
                      compact
                      className={cn('mt-0.5 min-w-0', !curiosityMobileSheetExpanded && 'max-lg:hidden')}
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
                          !curiosityMobileSheetExpanded && 'max-lg:h-8 max-lg:w-8'
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
                          !curiosityMobileSheetExpanded && 'max-lg:h-8 max-lg:w-8'
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
                  pursuits[activePursuitId]?.curiosityPipelineUi.executionLog.length > 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 shrink-0 text-xs"
                      onClick={() => clearCuriosityPursuitExecutionLog(activePursuitId)}
                    >
                      Clear log
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="hidden h-9 w-9 shrink-0 lg:inline-flex"
                    aria-expanded={curiosityPipelinePanelOpen}
                    aria-label={curiosityPipelinePanelOpen ? 'Collapse pipeline panel' : 'Expand pipeline panel'}
                    onClick={() => setCuriosityPipelinePanelOpen((v) => !v)}
                  >
                    {curiosityPipelinePanelOpen ? (
                      <ChevronUp className="h-5 w-5" />
                    ) : (
                      <ChevronDown className="h-5 w-5" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'relative z-[80] h-9 w-9 shrink-0 touch-manipulation lg:hidden',
                      !curiosityMobileSheetExpanded && 'max-lg:h-8 max-lg:w-8'
                    )}
                    aria-expanded={curiosityMobileSheetExpanded}
                    aria-label={curiosityMobileSheetExpanded ? 'Collapse pipeline panel' : 'Expand pipeline panel'}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setCuriosityMobileSheetExpanded((v) => !v);
                    }}
                  >
                    {curiosityMobileSheetExpanded ? (
                      <ChevronDown className="h-5 w-5" />
                    ) : (
                      <ChevronUp className="h-5 w-5" />
                    )}
                  </Button>
                </div>
              </div>
              <div className={cn(!curiosityMobileSheetExpanded && 'max-lg:hidden', !curiosityPipelinePanelOpen && 'lg:hidden')}>
              {pursuitIds.length === 0 && pursuitPrepCandidates.length > 0 ? (
                <PursuitPipelinePrepSelect
                  idPrefix="curiosity"
                  label="Open slot for question"
                  helperText="Pick a question to create an idle pipeline slot. Then set reruns and delay here before you use Pursue (full) on the card."
                  candidates={pursuitPrepCandidates}
                  formatOption={(it) => truncate(String(it.question || ''), 120)}
                  onPick={(item) => focusCuriosityPursuitSlot(item)}
                  disabled={false}
                />
              ) : null}
              {activePursuitId ? (
                <PursuitMetacognitionLimitsRow
                  maxReruns={activeCuriosityPipelineUi?.metacognitionMaxReruns ?? null}
                  delayMinutes={activeCuriosityPipelineUi?.metacognitionRerunDelayMinutes ?? null}
                  disabled={pursuits[activePursuitId]?.running === true}
                  onChange={(patch) =>
                    updateCuriosityPursuitPipelineUiForId(activePursuitId, (prev) => ({ ...prev, ...patch }))
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
                        !interruptedResumeCuriosityItem ||
                        scheduleBlocked ||
                        pursuits[activePursuitId]?.running === true
                      }
                      title={
                        scheduleBlocked
                          ? 'Wait until pipelines or another pursuit are idle'
                          : !interruptedResumeCuriosityItem
                            ? 'Curiosity row not found — refresh the list'
                            : undefined
                      }
                      onClick={() => {
                        if (interruptedResumeCuriosityItem) void pursueItemFull(interruptedResumeCuriosityItem);
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
                        patchCuriosityPursuitEntry(activePursuitId, { interruptedByReload: false })
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
                  curiosityMobileSheetExpanded && 'max-lg:flex max-lg:min-h-0 max-lg:flex-1 max-lg:flex-col max-lg:space-y-0 max-lg:gap-3 max-lg:overflow-hidden',
                  !curiosityMobileSheetExpanded && 'max-lg:hidden',
                  !curiosityPipelinePanelOpen && 'lg:hidden'
                )}
              >
                <p className="shrink-0 text-[11px] text-muted-foreground lg:hidden">
                  Full cognitive stack per pursuit — swipe left or right to switch when several runs are open. Chat
                  transcript is not prepended to the server input.
                </p>
                <div
                  ref={curiosityPipelineCarouselRef}
                  onScroll={handlePipelineCarouselScroll}
                  className={cn(
                    'flex w-full flex-nowrap overflow-x-auto overscroll-x-contain scroll-smooth snap-x snap-mandatory',
                    '[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
                    /* pan-x alone blocks vertical scrolling on nested overflow-y (mobile “stuck”); allow both axes */
                    '[touch-action:pan-x_pan-y] [-webkit-overflow-scrolling:touch]',
                    curiosityMobileSheetExpanded && 'max-lg:min-h-0 max-lg:flex-1'
                  )}
                >
                  {pursuitIds.map((pid) => {
                    const storedEntry = pursuits[pid];
                    const entry = storedEntry ?? fallbackCuriosityPursuitEntryFromItems(pid, items);
                    const pipelineUi = pursuitShowsLivePipelineChrome(entry)
                      ? entry.curiosityPipelineUi
                      : freshPursuitPipelineUiForNewGraphRun(entry.curiosityPipelineUi);
                    const slideMinimap = computeCuriosityPipelineMinimapSnapshot(
                      pipelineUi.moduleStatuses,
                      entry.running
                    );
                    const activeModuleId = curiosityPipelineActiveModuleId(pipelineUi.moduleStatuses);
                    return (
                      <div
                        key={pid}
                        className="box-border h-full min-h-0 w-full shrink-0 grow-0 basis-full snap-center snap-always max-lg:self-stretch max-lg:overflow-y-auto lg:border-r lg:border-border/40 lg:pr-4 lg:[&:last-child]:border-r-0 lg:[&:last-child]:pr-0"
                      >
                        <div className="space-y-3">
                          <PipelineStageMinimap
                            snapshot={slideMinimap}
                            stripLabel={PIPELINE_MINIMAP_STRIP_LABEL}
                            ariaLabel="Curiosity pursuit pipeline stage overview"
                          />
                          <div
                            className={cn(
                              'grid grid-cols-1 gap-4 lg:items-stretch',
                              curiosityDesktopLogExpanded ? 'lg:grid-cols-3' : 'lg:grid-cols-1'
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
                                curiosityDesktopLogExpanded ? 'lg:col-span-2' : 'lg:col-span-1'
                              )}
                            >
                              <NeuralNetworkViz
                                variant="embedded"
                                activeModuleId={activeModuleId}
                                runAccent={entry.running ? entryAccent(entry) : null}
                                ariaLabel="Curiosity pursuit pipeline modules"
                              />
                            </div>
                            <div
                              className={cn(
                                'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card',
                                curiosityDesktopLogExpanded
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
                                  aria-expanded={curiosityDesktopLogExpanded}
                                  aria-label={
                                    curiosityDesktopLogExpanded
                                      ? 'Collapse execution log'
                                      : 'Expand execution log'
                                  }
                                  onClick={() => setCuriosityDesktopLogExpanded((v) => !v)}
                                >
                                  <ChevronDown
                                    className={cn(
                                      'h-4 w-4 transition-transform duration-200',
                                      curiosityDesktopLogExpanded && 'rotate-180'
                                    )}
                                  />
                                </Button>
                              </div>
                              <div
                                ref={pid === activePursuitId ? curiosityPipelineLogRef : undefined}
                                className={cn(
                                  'relative min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain [-webkit-overflow-scrolling:touch]',
                                  'max-lg:min-h-[11rem] max-lg:flex-1 max-lg:max-h-none',
                                  curiosityDesktopLogExpanded ? 'lg:min-h-0 lg:flex-1' : 'lg:hidden'
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
                                        {logEntry.detail ? <CuriosityCollapsibleLogDetail detail={logEntry.detail} /> : null}
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
          </CuriosityPipelineMobilePortal>
        ) : null}

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <Panel className="space-y-3 xl:sticky xl:top-4 xl:self-start">
            <div className="text-sm font-semibold">Add question</div>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="What should this mind want to explore?"
              className="min-h-[140px]"
            />
            <Button
              type="button"
              onClick={() => void addItem()}
              disabled={addingCuriosity || generating || !draft.trim()}
              className="w-full gap-2"
            >
              {addingCuriosity ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add question
            </Button>
          </Panel>

          <div className="min-w-0 space-y-6">
            {loading ? (
              <div className="flex justify-center py-16">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
              </div>
            ) : items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border py-16 text-center">
                <ScanSearch className="mx-auto mb-3 h-10 w-10 text-muted-foreground/25" />
                <p className="text-sm text-muted-foreground">
                  No curiosity yet. Run some pipeline sessions, add memories or beliefs, then generate questions.
                </p>
              </div>
            ) : sortedFilteredCuriosityClusters.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border py-16 text-center">
                <ScanSearch className="mx-auto mb-3 h-10 w-10 text-muted-foreground/25" />
                <p className="text-sm text-muted-foreground">
                  No questions match{' '}
                  <strong className="text-foreground/90">
                    {CURIOSITY_QUESTION_FILTER_OPTIONS.find((o) => o.value === curiosityQuestionFilter)?.label ??
                      curiosityQuestionFilter}
                  </strong>
                  . Try another filter or change a question&apos;s status.
                </p>
              </div>
            ) : (
              <div className="space-y-8">
                {sortedFilteredCuriosityClusters.map(({ rootId, items: clusterItems }) => {
                  const rootItem =
                    items.find((i) => String(i.id) === String(rootId)) || clusterItems[0];
                  const fullClusterForRoot =
                    clusters.find((c) => String(c.rootId) === String(rootId))?.items ?? clusterItems;
                  const rootKey = String(rootId);
                  const batchRunningHere = threadGroupPursueRootId === rootKey;
                  const batchRunningOther =
                    threadGroupPursueRootId != null && threadGroupPursueRootId !== rootKey;
                  const clusterPursuitBusy = curiosityClusterHasActivePursuit(fullClusterForRoot, pursuits);
                  const threadPursueDisabled =
                    batchRunningOther || batchRunningHere || clusterPursuitBusy;
                  const hasMultiItemThread = fullClusterForRoot.length > 1;
                  const subQuestionCount = Math.max(0, fullClusterForRoot.length - 1);
                  const threadListExpanded = expandedCuriosityThreadRoots.has(rootKey);
                  const pursueThreadTitle =
                    batchRunningHere
                      ? 'Running pursuits for this thread…'
                      : batchRunningOther
                        ? 'Another thread batch is still running'
                        : clusterPursuitBusy
                          ? 'A pursue in this thread is still running'
                          : 'Run every open/dormant lead in this thread in order (full thread, not only rows visible under the filter). Pipeline panel defaults to a bottom strip on phones so this stays tappable.';

                  return (
                    <div key={rootId} className="space-y-2">
                      {hasMultiItemThread && !threadListExpanded ? (
                        <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-2.5">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <button
                              type="button"
                              className="flex min-w-0 flex-1 items-start gap-2 rounded-md p-1 text-left transition-colors hover:bg-muted/40 -m-1"
                              onClick={() => toggleCuriosityThreadExpanded(rootKey)}
                            >
                              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                              <div className="min-w-0">
                                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                  Thread
                                </div>
                                <CuriosityClampedQuestion text={rootItem?.question || rootId} className="min-w-0" />
                                <p className="mt-1 text-[11px] text-muted-foreground">
                                  {subQuestionCount} sub-question{subQuestionCount === 1 ? '' : 's'}
                                </p>
                              </div>
                            </button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="shrink-0"
                              disabled={threadPursueDisabled}
                              title={pursueThreadTitle}
                              onClick={(e) => {
                                e.stopPropagation();
                                void runThreadGroupPursuit(fullClusterForRoot, rootId);
                              }}
                            >
                              {batchRunningHere ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                              ) : (
                                <Play className="mr-1.5 h-3.5 w-3.5 opacity-80" aria-hidden />
                              )}
                              Pursue thread
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {hasMultiItemThread ? (
                            <div className="relative z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/15 px-3 py-2">
                              <div className="flex min-w-0 flex-1 items-start gap-2">
                                <button
                                  type="button"
                                  className="mt-0.5 shrink-0 rounded p-0.5 hover:bg-muted"
                                  onClick={() => toggleCuriosityThreadExpanded(rootKey)}
                                  title="Collapse thread"
                                  aria-expanded="true"
                                >
                                  <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
                                </button>
                                <div className="min-w-0">
                                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    Root thread
                                  </div>
                                  <CuriosityClampedQuestion text={rootItem?.question || rootId} className="min-w-0" />
                                </div>
                              </div>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="shrink-0"
                                disabled={threadPursueDisabled}
                                title={pursueThreadTitle}
                                onClick={() => void runThreadGroupPursuit(fullClusterForRoot, rootId)}
                              >
                                {batchRunningHere ? (
                                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                                ) : (
                                  <Play className="mr-1.5 h-3.5 w-3.5 opacity-80" aria-hidden />
                                )}
                                Pursue thread
                              </Button>
                            </div>
                          ) : null}
                          <div
                            className={cn(
                              'space-y-2',
                              hasMultiItemThread && 'border-l-2 border-sky-500/25 pl-3'
                            )}
                          >
                        {clusterItems.map((item) => {
                          const st = curiosityUiStatus(item, pursuits);
                          const itemPursuitEntry = pursuits[String(item.id)];
                          const styleCls = st === 'pursuing' && entryAccent(itemPursuitEntry) === 'b'
                            ? 'border-red-500/30 bg-red-500/5 text-red-400'
                            : (CURIOSITY_STATUS_STYLES[st] || CURIOSITY_STATUS_STYLES.open);
                          const p = effectiveItemPriority(item);
                          const depth = Number(item.pursuit_depth ?? 0);
                          const parent = item.parent_curiosity_id
                            ? clusterItems.find((i) => i.id === item.parent_curiosity_id)
                            : null;
                          return (
                            <div
                              key={item.id}
                              id={`curiosity-focus-${item.id}`}
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
                                      Branched from: {truncate(parent.question, 100)}
                                    </p>
                                  ) : null}
                                  <CuriosityClampedQuestion text={item.question} />
                                  {item.pursuit_thread ? <CuriosityCollapsibleThread text={item.pursuit_thread} /> : null}
                                  {item.resolution ? <CuriosityCollapsibleResolution text={item.resolution} /> : null}
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
                                        onClick={() => focusCuriosityPursuitSlot(item)}
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
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {pursuitIds.length > 0 || pursuitPrepCandidates.length > 0 ? (
          <div
            className={cn(
              'shrink-0 lg:hidden',
              curiosityMobileSheetExpanded ? 'h-0' : 'h-14'
            )}
            aria-hidden
          />
        ) : null}
      </div>
    </PageShell>
  );
}

function isPipelineTimelineEvent(event) {
  return event.source === 'pipeline';
}

export function TemporalPage() {
  const { TemporalEvent, PipelineRun } = useScopedEntities();
  const [events, setEvents] = useState([]);
  const [label, setLabel] = useState('');
  const [details, setDetails] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDetails, setEditDetails] = useState('');
  const [loading, setLoading] = useState(true);
  const [addingTimelineEvent, setAddingTimelineEvent] = useState(false);
  const [savingTimelineEditId, setSavingTimelineEditId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [manualEventsRaw, runsRaw] = await Promise.all([
        TemporalEvent.list('-created_date', 100),
        PipelineRun.list('-created_date', 50),
      ]);
      const manualEvents = temporalEventsExcludingPauseNoise(manualEventsRaw);
      const runEvents = excludeCheckpointPipelineRuns(runsRaw).map((run) => ({
        id: `run-${run.id}`,
        title: 'Pipeline run completed',
        details: truncate(run.final_output || '', 240),
        created_date: run.created_date,
        source: 'pipeline',
      }));
      setEvents([...manualEvents, ...runEvents].sort((a, b) => (a.created_date < b.created_date ? 1 : -1)));
    } finally {
      setLoading(false);
    }
  }, [TemporalEvent, PipelineRun]);

  useEffect(() => {
    load();
  }, [load]);

  useMindStorageRefresh(load);

  const createEvent = async () => {
    if (!label.trim()) return;
    setAddingTimelineEvent(true);
    try {
      await TemporalEvent.create({ title: label, details, source: 'manual' });
      setLabel('');
      setDetails('');
      await load();
      notifyMindStorageChanged({ source: 'temporal' });
    } finally {
      setAddingTimelineEvent(false);
    }
  };

  const startEdit = (event) => {
    setEditingId(event.id);
    setEditTitle(event.title || '');
    setEditDetails(event.details || '');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditTitle('');
    setEditDetails('');
  };

  const saveEdit = async () => {
    if (!editingId || !editTitle.trim()) return;
    const id = editingId;
    setSavingTimelineEditId(id);
    try {
      await TemporalEvent.update(id, { title: editTitle.trim(), details: editDetails });
      cancelEdit();
      await load();
      notifyMindStorageChanged({ source: 'temporal' });
    } finally {
      setSavingTimelineEditId(null);
    }
  };

  const deleteEvent = async (id) => {
    if (!window.confirm('Delete this timeline event? This cannot be undone.')) return;
    if (editingId === id) cancelEdit();
    await TemporalEvent.delete(id);
    await load();
    notifyMindStorageChanged({ source: 'temporal' });
  };

  return (
    <PageShell
      icon={Clock3}
      title="Temporal Timeline"
      description="Review pipeline history and log explicit milestones over time."
      actions={
        <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => load()} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          Refresh
        </Button>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <MindScopeTabs />
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <Panel className="space-y-3">
          <div className="text-sm font-semibold">Log Timeline Event</div>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Event title" />
          <Textarea value={details} onChange={(e) => setDetails(e.target.value)} placeholder="What changed?" className="min-h-[180px]" />
          <Button
            onClick={() => void createEvent()}
            disabled={addingTimelineEvent || !label.trim()}
            className="w-full gap-2"
          >
            {addingTimelineEvent ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add Event
          </Button>
        </Panel>
        <div className="space-y-3">
          {loading && events.length === 0 ? (
            <div className="flex justify-center py-12">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            </div>
          ) : events.length === 0 ? (
            <EmptyState title="No timeline events yet" description="Pipeline runs and manual milestones will appear here." />
          ) : null}
          {events.map((event) => {
            const readOnly = isPipelineTimelineEvent(event);
            const isEditing = editingId === event.id;
            return (
              <Panel key={event.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 text-xs text-muted-foreground">
                    {formatRelative(event.created_date)} · {event.source || 'manual'}
                    {readOnly ? (
                      <span className="ml-1 text-[10px] uppercase tracking-wide opacity-70">(from pipeline)</span>
                    ) : null}
                  </div>
                  {!readOnly && !isEditing ? (
                    <div className="flex shrink-0 gap-1">
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => startEdit(event)} title="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => deleteEvent(event.id)} title="Delete">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : null}
                </div>
                {isEditing ? (
                  <div className="mt-3 space-y-2">
                    <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="Event title" />
                    <Textarea
                      value={editDetails}
                      onChange={(e) => setEditDetails(e.target.value)}
                      placeholder="What changed?"
                      className="min-h-[120px]"
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        className="gap-1"
                        onClick={() => void saveEdit()}
                        disabled={!editTitle.trim() || savingTimelineEditId === event.id}
                      >
                        {savingTimelineEditId === event.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Save className="h-3.5 w-3.5" />
                        )}
                        Save
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={cancelEdit}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="mt-1 text-sm font-semibold">{event.title}</div>
                    {event.details ? <div className="mt-2 text-sm text-foreground/80">{event.details}</div> : null}
                  </>
                )}
              </Panel>
            );
          })}
        </div>
      </div>
    </PageShell>
  );
}

export function HealthPage() {
  const { isMirror } = useMindScope();
  const {
    PipelineRun,
    BeliefStore,
    LongTermMemory,
    CuriosityItem,
    GoalItem,
    FeedbackItem,
    DreamRun,
    EmergenceEvent,
    MindBiography,
  } = useScopedEntities();
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [identityLogOpen, setIdentityLogOpen] = useState(true);
  const [emergencePreviewOpen, setEmergencePreviewOpen] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [
      runsRaw,
      beliefs,
      memories,
      curiosities,
      goals,
      feedback,
      dreams,
      emergences,
      biographies,
    ] = await Promise.all([
      PipelineRun.listAll('-created_date'),
      BeliefStore.listAll('-created_date'),
      LongTermMemory.listAll('-created_date'),
      CuriosityItem.listAll('-created_date'),
      GoalItem.listAll('-created_date'),
      FeedbackItem.listAll('-created_date'),
      DreamRun.listAll('-created_date'),
      EmergenceEvent.listAll('-created_date'),
      MindBiography.listAll('-created_date'),
    ]);

    const positiveRatings = feedback.filter((item) => item.rating === 'up').length;
    const negativeRatings = feedback.filter((item) => item.rating === 'down').length;

    /** Incremental module checkpoints are extra PipelineRun rows — omit from growth-over-runs so counts match completed legs. */
    const runs = excludeCheckpointPipelineRuns(runsRaw);

    setSnapshot({
      runs,
      beliefs,
      memories,
      curiosities,
      goals,
      feedback,
      dreams,
      emergences,
      biographies,
      positiveRatings,
      negativeRatings,
    });
    setLoading(false);
  }, [
    PipelineRun,
    BeliefStore,
    LongTermMemory,
    CuriosityItem,
    GoalItem,
    FeedbackItem,
    DreamRun,
    EmergenceEvent,
    MindBiography,
  ]);

  useEffect(() => {
    load();
  }, [load]);

  useMindStorageRefresh(load);

  const curiosityPursuits = useSyncExternalStore(
    subscribeCuriosityPagePursuit,
    () => getCuriosityPagePursuitSnapshot().pursuits,
    () => ({})
  );

  const goalPursuits = useSyncExternalStore(
    subscribeGoalPagePursuit,
    () => getGoalPagePursuitSnapshot().pursuits,
    () => ({})
  );

  const derived = useMemo(
    () => (snapshot ? computeCognitiveHealthDerived(snapshot, curiosityPursuits, goalPursuits) : null),
    [snapshot, curiosityPursuits, goalPursuits]
  );

  return (
    <PageShell
      icon={Activity}
      title="Cognitive Health"
      description={
        isMirror
          ? 'System B (playground mirror) store — same metrics as Primary, scoped to the isolated mirror mind used in System Chat. Curiosity/goal pursuit slots still reflect Primary live UI state.'
          : 'Proxies for cognitive depth — counts use the full local store (no row cap). Curiosity and goal status breakdowns match the Curiosity Queue and Goals stack (live pursuit slots). Pipeline runs are saved graph/stream runs. The /api/health endpoint also exposes embedding cache stats and calibrated threshold values. Emergence totals and the recent list exclude items you rejected on the Emergence Log.'
      }
      actions={
        <>
          <MindScopeTabs />
          <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => load()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </Button>
        </>
      }
    >
      <div className="mx-auto w-full min-w-0 max-w-6xl space-y-6">
        <CognitiveHealthSnapshotPanels derived={derived} loading={loading} />

        {!loading && derived ? (
          <>
            <div className="min-w-0 rounded-xl border border-sky-500/20 bg-card p-4">
              <div className="mb-1 flex min-w-0 flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  aria-expanded={identityLogOpen}
                  onClick={() => setIdentityLogOpen((o) => !o)}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-1 pr-2 text-left transition-colors hover:bg-muted/40',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'
                  )}
                >
                  {identityLogOpen ? (
                    <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <Fingerprint className="h-4 w-4 shrink-0 text-sky-400" />
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Identity log
                  </h3>
                  <span className="ml-1 text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
                    ({derived.identityLog.length})
                  </span>
                </button>
                <Link
                  to={isMirror ? '/biography/mirror' : '/biography'}
                  className="text-[11px] font-medium text-sky-400/90 hover:text-sky-300 hover:underline"
                >
                  Mind Biography →
                </Link>
              </div>
              {identityLogOpen ? (
                <>
                  <p className="mb-3 text-[10px] text-muted-foreground">
                    Chronological tracker: saved biography snapshots (keywords, core values, change notes from pipeline or
                    manual generation) and <strong className="text-foreground/90">identity_shift</strong> rows from the
                    Emergence Log (pending + approved). Rejected emergence items are omitted.
                  </p>
                  {derived.identityLog.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                      No identity snapshots or identity-shift flags yet. Run the graph pipeline or generate a biography to
                      seed this log.
                    </div>
                  ) : (
                    <div className="space-y-2">
                  {derived.identityLog.map((entry) => {
                    if (entry.kind === 'biography') {
                      const bio = entry.bio;
                      const ver = bio.session_number ?? bio.version ?? '—';
                      const kws = healthDisplayTagList(bio.identity_keywords);
                      const vals = healthDisplayTagList(bio.core_values);
                      const delta = String(bio.notable_changes || '').trim();
                      const summary = String(bio.summary || '').trim();
                      return (
                        <div
                          key={`bio-${bio.id}`}
                          className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3 text-xs"
                        >
                          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium text-sky-300">Biography snapshot · v{ver}</span>
                            <span className="text-muted-foreground">{formatRelative(entry.date)}</span>
                          </div>
                          {bio.last_pipeline_touch ? (
                            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                              Last pipeline touch: {bio.last_pipeline_touch}
                            </div>
                          ) : null}
                          {summary ? (
                            <p className="text-foreground/85">{truncate(summary, 320)}</p>
                          ) : (
                            <p className="italic text-muted-foreground">No summary stored.</p>
                          )}
                          {delta ? (
                            <p className="mt-2 border-l-2 border-sky-500/35 pl-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-words">
                              {truncate(delta, 400)}
                            </p>
                          ) : null}
                          {kws.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {kws.slice(0, 14).map((t) => (
                                <span
                                  key={`${bio.id}-kw-${t}`}
                                  className="rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-200/90"
                                >
                                  {t}
                                </span>
                              ))}
                              {kws.length > 14 ? (
                                <span className="text-[10px] text-muted-foreground">+{kws.length - 14} more</span>
                              ) : null}
                            </div>
                          ) : null}
                          {vals.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {vals.slice(0, 10).map((t) => (
                                <span
                                  key={`${bio.id}-cv-${t}`}
                                  className="rounded-md bg-violet-500/12 px-1.5 py-0.5 text-[10px] text-violet-200/85"
                                >
                                  {t}
                                </span>
                              ))}
                              {vals.length > 10 ? (
                                <span className="text-[10px] text-muted-foreground">+{vals.length - 10} more</span>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      );
                    }
                    const e = entry.event;
                    const evItems = normalizeEmergenceEvidenceItems(e);
                    const det = parseEmergenceDetectedMarkers(e.details);
                    const byFlag =
                      det != null && det.length > 0
                        ? emergenceEvidenceRowsByDetectedMarkers(det, evItems)
                        : null;
                    return (
                      <div
                        key={`em-${e.id}`}
                        className="rounded-lg border border-pink-500/25 bg-pink-500/5 p-3 text-xs"
                      >
                        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-pink-300">
                            Emergence · {e.title || 'identity_shift'}
                          </span>
                          <span className="text-muted-foreground">{formatRelative(entry.date)}</span>
                        </div>
                        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                          identity_shift
                          {e.severity ? ` · severity ${e.severity}` : ''}
                        </div>
                        <p className="text-foreground/85">{e.details || 'No details.'}</p>
                        {byFlag ? (
                          <ul className="mt-2 space-y-2 border-l-2 border-pink-500/25 pl-2">
                            {byFlag.map(({ marker, items }) => (
                              <li key={`${e.id}-id-${marker}`} className="text-[11px] text-muted-foreground">
                                <span className="font-medium text-foreground/90">{marker}</span>
                                {items[0]?.quote ? (
                                  <pre className="mt-1 max-h-[min(40svh,22rem)] overflow-y-auto whitespace-pre-wrap break-words font-sans text-[10px] leading-relaxed text-muted-foreground/95">
                                    {items[0].source ? `${items[0].source}: ` : ''}
                                    {items[0].quote}
                                  </pre>
                                ) : (
                                  <span className="mt-0.5 block text-[10px] italic opacity-80">No excerpt stored</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : evItems[0]?.quote ? (
                          <p className="mt-2 border-l-2 border-pink-500/30 pl-2 text-[11px] italic text-muted-foreground whitespace-pre-wrap break-words">
                            {evItems[0].quote}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                    </div>
                  )}
                  <div className="mt-3 text-[10px] text-muted-foreground">
                    <Link to="/emergence" className="font-medium text-pink-300/90 hover:text-pink-200 hover:underline">
                      Emergence Log →
                    </Link>
                    <span className="mx-2 opacity-40">·</span>
                    Identity stability (above) compares the two newest biography rows only.
                  </div>
                </>
              ) : null}
            </div>

            {derived.emergencePreview.length > 0 ? (
              <div className="min-w-0 rounded-xl border border-pink-500/20 bg-card p-4">
                <div className="mb-1 flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    aria-expanded={emergencePreviewOpen}
                    onClick={() => setEmergencePreviewOpen((o) => !o)}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-1 pr-2 text-left transition-colors hover:bg-muted/40',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'
                    )}
                  >
                    {emergencePreviewOpen ? (
                      <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <Zap className="h-4 w-4 shrink-0 text-pink-400" />
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Recent emergence events
                    </h3>
                    <span className="ml-1 text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
                      ({derived.emergencePreview.length})
                    </span>
                  </button>
                  <Link
                    to="/emergence"
                    className="text-[11px] font-medium text-pink-300/90 hover:text-pink-200 hover:underline"
                  >
                    Log →
                  </Link>
                </div>
                {emergencePreviewOpen ? (
                  <>
                    <p className="mb-3 text-[10px] text-muted-foreground">
                      From <strong className="text-foreground/90">Emergence Log</strong> — pending and approved flags only
                      (rejected items are hidden here and in the emergence count above). Heuristics use Voice, Narrative,
                      and Identity output; severity reflects marker count per run.
                    </p>
                    <div className="space-y-2">
                  {derived.emergencePreview.map((e) => {
                    const evItems = normalizeEmergenceEvidenceItems(e);
                    const det = parseEmergenceDetectedMarkers(e.details);
                    const byFlag =
                      det != null && det.length > 0
                        ? emergenceEvidenceRowsByDetectedMarkers(det, evItems)
                        : null;
                    return (
                      <div
                        key={e.id}
                        className="rounded-lg border border-pink-500/20 bg-pink-500/5 p-3 text-xs"
                      >
                        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-pink-300">{e.title || 'Emergence'}</span>
                          <span className="text-muted-foreground">{formatRelative(e.created_date)}</span>
                        </div>
                        {e.emergence_category ? (
                          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                            {e.emergence_category}
                          </div>
                        ) : null}
                        {e.severity ? (
                          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                            Severity: {e.severity}
                          </div>
                        ) : null}
                        <p className="break-words text-foreground/85">{e.details || 'No details.'}</p>
                        {byFlag ? (
                          <ul className="mt-2 space-y-2 border-l-2 border-pink-500/25 pl-2">
                            {byFlag.map(({ marker, items }) => (
                              <li key={`${e.id}-p-${marker}`} className="text-[11px] text-muted-foreground">
                                <span className="font-medium text-foreground/90">{marker}</span>
                                {items[0]?.quote ? (
                                  <pre className="mt-1 max-h-[min(40svh,22rem)] overflow-y-auto whitespace-pre-wrap break-words font-sans text-[10px] leading-relaxed text-muted-foreground/95">
                                    {items[0].source ? `${items[0].source}: ` : ''}
                                    {items[0].quote}
                                  </pre>
                                ) : (
                                  <span className="mt-0.5 block text-[10px] italic opacity-80">
                                    No excerpt stored
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : evItems[0]?.quote ? (
                          <p className="mt-2 border-l-2 border-pink-500/30 pl-2 text-[11px] italic text-muted-foreground whitespace-pre-wrap break-words">
                            {evItems[0].quote}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Panel>
                <div className="text-sm font-semibold">System readiness</div>
                <ul className="mt-3 space-y-2 text-sm text-foreground/80">
                  <li>{derived.runCount > 0 ? 'Healthy' : 'Needs activity'} — pipeline execution history</li>
                  <li>{derived.memoryCount > 0 ? 'Healthy' : 'Needs seeding'} — long-term memory persistence</li>
                  <li>
                    {derived.openOrPursuing < 25 ? 'Healthy' : 'High load'} — open or pursuing curiosity backlog
                  </li>
                  <li>
                    Week vs week: runs{' '}
                    {derived.runTrend > 0 ? '↑' : derived.runTrend < 0 ? '↓' : '—'}, beliefs{' '}
                    {derived.beliefTrend > 0 ? '↑' : derived.beliefTrend < 0 ? '↓' : '—'}, memories{' '}
                    {derived.memoryTrend > 0 ? '↑' : derived.memoryTrend < 0 ? '↓' : '—'}
                  </li>
                </ul>
              </Panel>
              <Panel>
                <div className="text-sm font-semibold">Latest pipeline runs</div>
                <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                  {(snapshot?.runs || []).slice(0, 5).map((run) => (
                    <div key={run.id}>Completed {formatRelative(run.created_date)}</div>
                  ))}
                  {(snapshot?.runs || []).length === 0 ? (
                    <span className="text-xs">No runs recorded yet.</span>
                  ) : null}
                </div>
              </Panel>
            </div>
          </>
        ) : null}
      </div>
    </PageShell>
  );
}

function EmergenceEventCard({
  event,
  onDecide,
  reviewState,
  reviewBusy = false,
}) {
  const [expanded, setExpanded] = useState(false);
  const score = emergenceDeviationScore(event);
  const scoreColor =
    score == null ? 'text-muted-foreground' : score > 0.7 ? 'text-pink-400' : score > 0.5 ? 'text-amber-400' : 'text-foreground';
  const description = (event.description || event.details || '').trim();
  const snapshot = (event.output_snapshot || '').trim();
  const trigger = typeof event.trigger_input === 'string' ? event.trigger_input : '';
  const evidenceItems = normalizeEmergenceEvidenceItems(event);
  const detectedMarkers = parseEmergenceDetectedMarkers(event.details);
  const evidenceByFlagFromDetected =
    detectedMarkers != null && detectedMarkers.length > 0
      ? emergenceEvidenceRowsByDetectedMarkers(detectedMarkers, evidenceItems)
      : null;
  const evidenceByFlag =
    evidenceByFlagFromDetected != null
      ? evidenceByFlagFromDetected
      : evidenceItems.length > 0
        ? groupEmergenceEvidenceByMarker(evidenceItems)
        : null;
  const orphanEvidenceItems =
    evidenceByFlag != null
      ? (() => {
          const covered = new Set();
          for (const row of evidenceByFlag) {
            for (const it of row.items) covered.add(emergenceEvidenceKey(it));
          }
          return evidenceItems.filter((ev) => !covered.has(emergenceEvidenceKey(ev)));
        })()
      : [];
  const isPending = reviewState === 'pending';
  const borderApproved = reviewState === 'approved';
  const borderRejected = reviewState === 'rejected';

  return (
    <div
      className={cn(
        'rounded-xl border p-4 transition-all',
        borderApproved && 'border-emerald-500/25 bg-emerald-500/5 opacity-90',
        borderRejected && 'border-border bg-muted/20 opacity-60',
        isPending && 'border-pink-500/30 bg-pink-500/5'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <div
                className={cn(
                  'h-2 w-2 rounded-full',
                  borderApproved ? 'bg-emerald-400' : borderRejected ? 'bg-muted-foreground' : 'bg-pink-400'
                )}
              />
              <span className={cn('font-mono text-xs font-bold', scoreColor)}>
                {score != null ? `${Math.round(score * 100)}% deviation` : 'score n/a'}
              </span>
            </div>
            <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-200">
              {emergenceSignalLabel(event)}
            </span>
            {event.module_id ? (
              <span className="text-[10px] text-muted-foreground">[{event.module_id}]</span>
            ) : null}
            {event.emergence_category ? (
              <span className="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {event.emergence_category}
              </span>
            ) : null}
            {event.pipeline_run_id ? (
              <span className="text-[10px] text-muted-foreground">run …{String(event.pipeline_run_id).slice(-6)}</span>
            ) : null}
            {!isPending ? (
              <span
                className={cn(
                  'text-[10px] font-medium uppercase tracking-wide',
                  borderApproved ? 'text-emerald-400' : 'text-muted-foreground'
                )}
              >
                {borderApproved ? 'Approved' : 'Rejected'}
              </span>
            ) : null}
            <span className="ml-auto text-[10px] text-muted-foreground">{formatRelative(event.created_date)}</span>
          </div>
          {event.title && !event.description ? (
            <div className="text-sm font-semibold text-foreground">{event.title}</div>
          ) : null}
          <p className="max-h-[min(45svh,26rem)] overflow-y-auto text-sm leading-relaxed text-foreground break-words">
            {description || event.title || '—'}
          </p>
          {event.pattern_broken ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              <span className="text-amber-400/80">Pattern broken: </span>
              {event.pattern_broken}
            </p>
          ) : null}
          {trigger ? (
            <div className="mt-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Trigger (graph input)
              </p>
              <pre className="mt-1 max-h-[min(50svh,28rem)] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/20 p-2 font-sans text-[11px] leading-relaxed text-muted-foreground">
                {trigger}
              </pre>
            </div>
          ) : null}
          {evidenceByFlag ? (
            <div className="mt-3 space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Evidence by flag
              </p>
              {evidenceByFlag.map(({ marker, items }) => (
                <div
                  key={`${event.id}-flag-${marker}`}
                  className="rounded-lg border border-border/70 bg-muted/15 px-3 py-2.5"
                >
                  <div className="text-xs font-semibold leading-snug text-foreground">{marker}</div>
                  {items.length === 0 ? (
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                      No excerpt stored for this flag (re-run the pipeline to refresh quotes).
                    </p>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {items.map((ev, i) => (
                        <blockquote
                          key={`${event.id}-ev-${marker}-${i}`}
                          className="border-l-2 border-pink-500/45 pl-3 text-xs leading-relaxed text-foreground/90"
                        >
                          <div className="mb-0.5 text-[10px] text-muted-foreground">
                            <span className="font-medium text-foreground/85">{ev.source}</span>
                          </div>
                          <q className="not-italic block max-h-[min(55svh,32rem)] overflow-y-auto whitespace-pre-wrap break-words">
                            {ev.quote}
                          </q>
                        </blockquote>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {orphanEvidenceItems.length > 0 ? (
                <div className="mt-2 space-y-2 border-t border-border/50 pt-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Additional source quotes
                  </p>
                  {orphanEvidenceItems.map((ev, i) => (
                    <blockquote
                      key={`${event.id}-orphan-${i}`}
                      className="border-l-2 border-pink-500/35 pl-3 text-xs leading-relaxed text-foreground/90"
                    >
                      <div className="mb-0.5 text-[10px] text-muted-foreground">
                        <span className="font-medium text-foreground/80">{ev.marker}</span>
                        <span className="text-muted-foreground/80"> · {ev.source}</span>
                      </div>
                      <q className="not-italic block max-h-[min(55svh,32rem)] overflow-y-auto whitespace-pre-wrap break-words">
                        {ev.quote}
                      </q>
                    </blockquote>
                  ))}
                </div>
              ) : null}
            </div>
          ) : evidenceItems.length > 0 ? (
            <div className="mt-3 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Source quotes</p>
              {evidenceItems.map((ev, i) => (
                <blockquote
                  key={`${event.id}-ev-${i}`}
                  className="border-l-2 border-pink-500/40 pl-3 text-xs leading-relaxed text-foreground/90"
                >
                  <div className="mb-0.5 text-[10px] text-muted-foreground">
                    <span className="font-medium text-foreground/80">{ev.marker}</span>
                    <span className="text-muted-foreground/80"> · {ev.source}</span>
                  </div>
                  <q className="not-italic block max-h-[min(55svh,32rem)] overflow-y-auto whitespace-pre-wrap break-words">
                    {ev.quote}
                  </q>
                </blockquote>
              ))}
            </div>
          ) : null}
          {expanded && snapshot ? (
            <div className="mt-3 max-h-[min(70svh,40rem)] overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/30 p-3 text-xs leading-relaxed text-foreground/80 break-words">
              {snapshot}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          {isPending ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs text-emerald-400 hover:text-emerald-300"
                disabled={reviewBusy}
                onClick={() => void onDecide(event.id, 'approved')}
              >
                {reviewBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ThumbsUp className="h-3 w-3" />} Approve
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs text-muted-foreground hover:text-rose-300"
                disabled={reviewBusy}
                onClick={() => void onDecide(event.id, 'rejected')}
              >
                <ThumbsDown className="h-3 w-3" /> Reject
              </Button>
            </>
          ) : null}
          {snapshot ? (
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setExpanded((e) => !e)}>
              {expanded ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {expanded ? 'Hide' : 'Output'}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function EmergencePage() {
  const { EmergenceEvent, PipelineRun, ConversationMessage } = useScopedEntities();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [reviewingId, setReviewingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let list = await EmergenceEvent.list('-created_date', 100);
      await backfillEmergenceEvidenceFromPipelineRuns(list, { PipelineRun, EmergenceEvent });
      list = await EmergenceEvent.list('-created_date', 100);
      setEvents(list);
    } finally {
      setLoading(false);
    }
  }, [EmergenceEvent, PipelineRun]);

  useEffect(() => {
    void load();
  }, [load]);

  const scanForEmergence = async () => {
    setScanning(true);
    try {
      const [runs, convRows] = await Promise.all([
        PipelineRun.list('-created_date', 20),
        ConversationMessage.list('-created_date', 120),
      ]);

      const convSorted = [...convRows].sort(
        (a, b) => new Date(a.created_date).getTime() - new Date(b.created_date).getTime()
      );
      const nConv = convSorted.length;
      const recentConvMsgs = convSorted.slice(-8);
      const olderConvMsgs = convSorted.slice(Math.max(0, nConv - 28), Math.max(0, nConv - 8));
      const recentConvText = flattenConversationMessagesForEmergence(recentConvMsgs);
      const olderConvText = flattenConversationMessagesForEmergence(olderConvMsgs);
      const assistantCount = convSorted.filter((m) => m.role === 'assistant').length;
      const streamBaselineOk = olderConvMsgs.length >= 2 && recentConvMsgs.length >= 2;
      const streamRichOk = assistantCount >= 3 && streamBaselineOk;

      const runBased = runs.length >= 3;
      if (!runBased && !streamRichOk) {
        toast({
          title: 'Need more history',
          description:
            'Run Graph Pipeline at least three times, or hold several conversation turns there so we can compare a recent dialogue window to an earlier one.',
        });
        return;
      }

      const recent = runs.slice(0, 3);
      const older = runs.slice(3, 10);
      let recentOutputs = '';
      let olderOutputs = '';
      if (runBased) {
        recentOutputs = recent.map(flattenPipelineOutputsForEmergence).join('\n\n---\n\n');
        olderOutputs = older.map(flattenPipelineOutputsForEmergence).join('\n\n---\n\n');
      }

      const olderSections = [];
      if (olderConvText.trim()) {
        olderSections.push(`GRAPH PIPELINE CHAT (earlier turns, user + Voice + modules when saved):\n${olderConvText}`);
      }
      if (olderOutputs.trim()) {
        olderSections.push(
          `SAVED PIPELINE RUNS (baseline — graph):\n${olderOutputs}`
        );
      }
      const recentSections = [];
      if (recentConvText.trim()) {
        recentSections.push(`GRAPH PIPELINE CHAT (most recent turns):\n${recentConvText}`);
      }
      if (recentOutputs.trim()) {
        recentSections.push(
          `SAVED PIPELINE RUNS (newest — graph):\n${recentOutputs}`
        );
      }

      const olderBundle = olderSections.join('\n\n').slice(0, 3200);
      const recentBundle = recentSections.join('\n\n').slice(0, 3200);

      if (!olderBundle.trim() || !recentBundle.trim()) {
        toast({
          title: 'Not enough comparable text',
          description:
            'Add more Graph Pipeline chat dialogue or saved pipeline runs so both a baseline and a recent window have substance.',
          variant: 'destructive',
        });
        return;
      }

      const result = await invokeLLM({
        prompt: `You analyze MetaSelf-CognitiveStack cognitive output from two sources: (1) saved Graph Pipeline chat turns (User and Voice) with Voice sometimes including per-module traces; (2) saved PipelineRun records from graph runs (module outputs and a final voice line). Metacognitive reruns are normal.

Detect EMERGENCE EVENTS — moments where RECENT material differs meaningfully from the BASELINE (style, reasoning, self-model, novel connections, emotional depth, or metacognitive texture). Weight saved pipeline chat heavily when it is the richer record of interaction. Module bundles prioritize Identity and Narrative when present — treat shifts in self-model, values, name, or boundaries as especially salient.

OLDER / BASELINE:
${olderBundle}

RECENT (check for deviation):
${recentBundle}

Look for:
- Concepts or links not present in the baseline
- Unusual self-reference, goals, or belief-like statements vs baseline
- Surprising integration across modules or voice vs prior pattern
- Deeper uncertainty, conflict awareness, or temporal self-comparison

For each event, set "category" to exactly one of: identity_shift (self-model, values, name, identity narrative), reasoning_shift, style_shift, other. Prefer identity_shift when the main deviation is about who-this-mind-is, values, or explicit identity narrative vs baseline.

For each event, include supporting_quotes: 1–4 objects with source_label (e.g. "RECENT Voice", "RECENT Identity module", "BASELINE Narrative") and quote: copy one or more complete sentences verbatim from the OLDER or RECENT bundles above (not paraphrased, not truncated mid-sentence). Each quote must be an exact substring of the provided text, including punctuation.

Return JSON only, schema as given.`,
        response_json_schema: {
          type: 'object',
          properties: {
            events: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  description: { type: 'string' },
                  deviation_score: { type: 'number' },
                  pattern_broken: { type: 'string' },
                  output_snapshot: { type: 'string' },
                  module_id: { type: 'string' },
                  category: {
                    type: 'string',
                    enum: ['identity_shift', 'reasoning_shift', 'style_shift', 'other'],
                  },
                  supporting_quotes: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        source_label: { type: 'string' },
                        quote: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      const rawList = Array.isArray(result?.events) ? result.events : [];
      const found = rawList.filter((e) => (Number(e.deviation_score) || 0) > 0.4);
      const anchorRun = runBased ? recent[0] : runs[0] || null;
      const lastUserTurn = [...recentConvMsgs].reverse().find((m) => m.role === 'user');
      const triggerFromStream = lastUserTurn?.content != null ? String(lastUserTurn.content) : '';

      /** Keep LLM quotes/snapshots intact for Emergence Log reading; soft cap avoids pathological JSON payloads. */
      const emergenceQuoteCap = 100_000;
      const emergenceSnapshotCap = 200_000;
      const emergenceDetailsCap = 120_000;

      for (const e of found) {
        const desc = String(e.description || '').trim() || 'Emergence signal';
        const dev = Number(e.deviation_score) || 0.5;
        const emergence_category = normalizeEmergenceCategory(e.category);
        const sq = Array.isArray(e.supporting_quotes) ? e.supporting_quotes : [];
        const fromQuotes = sq
          .map((row) => ({
            marker: 'LLM scan',
            source: String(row.source_label || 'Source').slice(0, 160),
            quote: String(row.quote || '').trim(),
          }))
          .filter((row) => row.quote);
        const snap = String(e.output_snapshot || '').trim();
        const evidence_items =
          fromQuotes.length > 0
            ? fromQuotes.map((row) => ({ ...row, quote: row.quote.slice(0, emergenceQuoteCap) }))
            : snap
              ? [{ marker: 'LLM scan (snapshot)', source: 'output_snapshot', quote: snap.slice(0, emergenceQuoteCap) }]
              : [];
        await EmergenceEvent.create({
          title: truncate(desc, 96),
          description: desc,
          details:
            [e.pattern_broken, e.output_snapshot].filter(Boolean).join('\n\n').slice(0, emergenceDetailsCap) || desc,
          severity: dev > 0.7 ? 'high' : 'medium',
          deviation_score: dev,
          pattern_broken: e.pattern_broken || '',
          output_snapshot: snap.slice(0, emergenceSnapshotCap),
          module_id: String(e.module_id || '').slice(0, 120),
          emergence_category,
          pipeline_run_id: anchorRun?.id,
          trigger_input:
            typeof anchorRun?.input === 'string' && anchorRun.input.trim()
              ? anchorRun.input
              : triggerFromStream,
          signal_type: 'emergence_llm',
          evidence_items,
          review_status: 'pending',
          reviewed: false,
        });
      }

      notifyMindStorageChanged({ source: 'emergence' });
      toast({
        title: 'Emergence scan complete',
        description: `${found.length} event(s) flagged above threshold.`,
      });
    } catch (err) {
      console.error(err);
      toast({
        title: 'Emergence scan failed',
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setScanning(false);
      await load();
    }
  };

  const pending = events.filter((e) => emergenceReviewState(e) === 'pending');
  const approved = events.filter((e) => emergenceReviewState(e) === 'approved');
  const rejected = events.filter((e) => emergenceReviewState(e) === 'rejected');
  const scored = events.filter((e) => typeof e.deviation_score === 'number');
  const avgDeviationPct =
    scored.length > 0
      ? Math.round((scored.reduce((s, e) => s + (e.deviation_score || 0), 0) / scored.length) * 100)
      : null;

  const markDecision = async (id, decision) => {
    setReviewingId(id);
    try {
      await EmergenceEvent.update(id, {
        review_status: decision,
        reviewed: true,
      });
      notifyMindStorageChanged({ source: 'emergence' });
      await load();
    } finally {
      setReviewingId(null);
    }
  };

  return (
    <PageShell
      icon={Gauge}
      title="Emergence Log"
      description="Emergence and identity tracking: heuristic markers after each pipeline (with source quotes), optional LLM deviation scan, and Mind Biography identity deltas. Approve or reject each flag — pending items stay highlighted."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => void load()}
            disabled={loading || scanning}
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </Button>
          <Button
            type="button"
            onClick={() => void scanForEmergence()}
            disabled={scanning}
            className="gap-2 border border-pink-500/30 bg-pink-500/10 text-pink-200 hover:bg-pink-500/20"
          >
            {scanning ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            Scan for emergence
          </Button>
        </div>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <MindScopeTabs />
      </div>
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-pink-500/20 bg-pink-500/5 p-4 text-center">
            <div className="text-2xl font-bold text-pink-400">{events.length}</div>
            <div className="text-xs text-muted-foreground">Total events</div>
          </div>
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-center">
            <div className="text-2xl font-bold text-amber-400">{pending.length}</div>
            <div className="text-xs text-muted-foreground">Pending review</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4 text-center">
            <div className="text-2xl font-bold text-foreground">{avgDeviationPct != null ? `${avgDeviationPct}%` : '—'}</div>
            <div className="text-xs text-muted-foreground">Avg deviation (scored)</div>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          </div>
        ) : events.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-16 text-center">
            <Zap className="mx-auto mb-3 h-10 w-10 text-muted-foreground/25" />
            <p className="text-sm text-muted-foreground">
              No emergence events yet. Use Graph Pipeline for several chat turns and/or run it a few times, then scan here.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {pending.length > 0 ? (
              <div>
                <h3 className="mb-3 flex items-center gap-2 text-xs uppercase tracking-wider text-amber-400">
                  <AlertTriangle className="h-3 w-3" /> Awaiting review ({pending.length})
                </h3>
                <div className="space-y-3">
                  {pending.map((e) => (
                    <EmergenceEventCard
                      key={e.id}
                      event={e}
                      onDecide={markDecision}
                      reviewState="pending"
                      reviewBusy={reviewingId === e.id}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            {approved.length > 0 ? (
              <div>
                <h3 className="mb-3 flex items-center gap-2 text-xs uppercase tracking-wider text-emerald-500/90">
                  <CheckCircle2 className="h-3 w-3" /> Approved ({approved.length})
                </h3>
                <div className="space-y-3">
                  {approved.map((e) => (
                    <EmergenceEventCard key={e.id} event={e} onDecide={markDecision} reviewState="approved" />
                  ))}
                </div>
              </div>
            ) : null}
            {rejected.length > 0 ? (
              <div>
                <h3 className="mb-3 flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
                  <ThumbsDown className="h-3 w-3" /> Rejected ({rejected.length})
                </h3>
                <div className="space-y-3">
                  {rejected.map((e) => (
                    <EmergenceEventCard key={e.id} event={e} onDecide={markDecision} reviewState="rejected" />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </PageShell>
  );
}
export function DatasetPage() {
  const [datasets, setDatasets] = useState([]);
  const [fromRunBusy, setFromRunBusy] = useState(false);
  const [fromFeedbackBusy, setFromFeedbackBusy] = useState(false);

  const load = async () => {
    setDatasets(await Dataset.listAll('-created_date'));
  };

  useEffect(() => {
    load();
  }, []);

  const createFromLatestRun = async () => {
    setFromRunBusy(true);
    try {
      const [run] = await PipelineRun.list('-created_date', 1);
      if (!run) {
        toast({ title: 'No pipeline run', description: 'Save a graph or stream run first.', variant: 'destructive' });
        return;
      }
      await Dataset.create({
        name: `Pipeline dataset ${new Date().toLocaleString()}`,
        source: 'pipeline-run',
        record_count: Object.keys(run.module_outputs || {}).length,
        payload: run,
      });
      await load();
      toast({ title: 'Dataset created', description: 'From latest pipeline run.' });
    } finally {
      setFromRunBusy(false);
    }
  };

  const createFromFeedback = async () => {
    setFromFeedbackBusy(true);
    try {
      const feedback = await FeedbackItem.list('-created_date', 20);
      if (feedback.length === 0) {
        toast({ title: 'No feedback', description: 'Rate candidates on the RLHF page first.', variant: 'destructive' });
        return;
      }
      await Dataset.create({
        name: `Feedback dataset ${new Date().toLocaleString()}`,
        source: 'rlhf',
        record_count: feedback.length,
        payload: feedback,
      });
      await load();
      toast({ title: 'Dataset created', description: 'From saved feedback.' });
    } finally {
      setFromFeedbackBusy(false);
    }
  };

  const removeDataset = async (id) => {
    await Dataset.delete(id);
    await load();
  };

  return (
    <PageShell
      icon={Database}
      title="Datasets"
      description="Package saved runs and feedback into local datasets for future tuning workflows."
      actions={
        <>
          <Button
            variant="outline"
            onClick={() => void createFromFeedback()}
            disabled={fromFeedbackBusy || fromRunBusy}
            className="gap-2"
          >
            {fromFeedbackBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} From Feedback
          </Button>
          <Button onClick={() => void createFromLatestRun()} disabled={fromRunBusy || fromFeedbackBusy} className="gap-2">
            {fromRunBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} From Latest Run
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {datasets.length === 0 ? <EmptyState title="No datasets yet" description="Create one from the latest pipeline run or your RLHF feedback." /> : null}
        {datasets.map((dataset) => (
          <Panel key={dataset.id}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">{dataset.name}</div>
                <div className="mt-1 text-xs text-muted-foreground">{dataset.source} · {dataset.record_count || 0} records · {formatRelative(dataset.created_date)}</div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => removeDataset(dataset.id)}><Trash2 className="h-4 w-4" /></Button>
            </div>
          </Panel>
        ))}
      </div>
    </PageShell>
  );
}

/** Matches DreamingPage + scheduled task `dreaming` input window (six newest each). */
const DREAM_SOURCE_LIMIT = 6;

export function DreamingPage() {
  const { isMirror } = useMindScope();
  const { DreamRun, LongTermMemory, BeliefStore } = useScopedEntities();
  const [dreams, setDreams] = useState([]);
  const [running, setRunning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [source, setSource] = useState({ memoryCount: 0, beliefCount: 0 });

  const loadDreams = useCallback(async () => {
    setDreams(await DreamRun.list('-created_date', 50));
  }, [DreamRun]);

  const refreshSources = useCallback(async () => {
    const [memories, beliefs] = await Promise.all([
      LongTermMemory.list('-created_date', DREAM_SOURCE_LIMIT),
      BeliefStore.list('-created_date', DREAM_SOURCE_LIMIT),
    ]);
    setSource({ memoryCount: memories.length, beliefCount: beliefs.length });
  }, [LongTermMemory, BeliefStore]);

  const refreshDreamPage = async () => {
    setRefreshing(true);
    try {
      await loadDreams();
      await refreshSources();
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadDreams();
    void refreshSources();
  }, [loadDreams, refreshSources]);

  const runDream = async () => {
    const [memories, beliefs] = await Promise.all([
      LongTermMemory.list('-created_date', DREAM_SOURCE_LIMIT),
      BeliefStore.list('-created_date', DREAM_SOURCE_LIMIT),
    ]);
    if (memories.length === 0 && beliefs.length === 0) {
      toast({
        title: 'Nothing to dream with yet',
        description: 'Run the graph pipeline (or add memories) and seed the Belief Map first.',
        variant: 'destructive',
      });
      return;
    }

    setRunning(true);
    try {
      const dreamText = await llmService.InvokeLLM({
        prompt: `Enter a dreaming mode. Recombine these memories and beliefs into a surreal but useful reflection.\n\nMemories:\n${memories.map((memory) => `- ${memory.title}: ${truncate(memory.content, 120)}`).join('\n')}\n\nBeliefs:\n${beliefs.map((belief) => `- ${belief.statement}`).join('\n')}`,
        max_tokens: 500,
      });
      await DreamRun.create({ output: dreamText });
      await LongTermMemory.create({
        title: `Dream synthesis ${new Date().toLocaleString()}`,
        content: dreamText,
        memory_type: 'dream',
        source: 'dreaming-mode',
      });
      notifyMindStorageChanged({ source: 'dreams' });
      notifyMindStorageChanged({ source: 'long-term-memory' });
    } catch (err) {
      console.error(err);
      toast({
        title: 'Dream run failed',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    } finally {
      setRunning(false);
      await loadDreams();
      await refreshSources();
    }
  };

  const canDream = source.memoryCount > 0 || source.beliefCount > 0;

  const memPath = isMirror ? '/memory/mirror' : '/memory';
  const beliefsPath = isMirror ? '/beliefs/mirror' : '/beliefs';
  const healthPath = isMirror ? '/health/mirror' : '/health';

  return (
    <PageShell
      icon={Moon}
      title="Dreaming Mode"
      description={
        isMirror
          ? 'System B mirror: DreamRun and dream memories persist to the isolated mirror store.'
          : 'Idle-style synthesis: one LLM pass that recombines your six newest long-term memories and six beliefs into a reflection, stores a DreamRun, and appends a dream-type memory. This is not the full graph pipeline — use Graph Pipeline or System Chat for per-module cycles.'
      }
      actions={
        <>
          <MindScopeTabs />
          <Button
            variant="outline"
            type="button"
            disabled={running || refreshing}
            onClick={() => void refreshDreamPage()}
            className="gap-2"
          >
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} /> Refresh
          </Button>
          <Button onClick={runDream} disabled={running || !canDream} className="gap-2" title={!canDream ? 'Need at least one memory or belief in the recent window' : undefined}>
            {running ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Moon className="h-4 w-4" />}
            Start Dream Run
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Panel className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Sparkles className="h-4 w-4 text-amber-400" />
              Where this sits in the mind
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded-md bg-muted/60 px-2 py-1">Graph / stream</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
              <span className="rounded-md bg-muted/60 px-2 py-1">LTM & beliefs accrue</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
              <span className="rounded-md bg-muted/60 px-2 py-1">Dreaming pass</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
              <span className="rounded-md bg-muted/60 px-2 py-1">DreamRun + dream memory</span>
            </div>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
              <li>
                Pulls up to <strong className="text-foreground">{DREAM_SOURCE_LIMIT}</strong> most recent long-term memories and the same number of beliefs (same slice the{' '}
                <strong className="text-foreground">dreaming</strong> scheduler task uses).
              </li>
              <li>
                Sends one prompt to your configured LLM: surreal but useful recombination — not a step-through of every cognitive module (that is{' '}
                <Link className="text-primary underline-offset-4 hover:underline" to="/graph-pipeline">
                  Graph Pipeline
                </Link>{' '}
                /{' '}
                <Link className="text-primary underline-offset-4 hover:underline" to="/playground">
                  System Chat
                </Link>
                ).
              </li>
              <li>
                Writes a <strong className="text-foreground">DreamRun</strong> record (this list) and a <strong className="text-foreground">dream</strong> row in Long-Term Memory with source{' '}
                <code className="rounded bg-muted px-1 text-foreground/90">dreaming-mode</code> (scheduled runs use{' '}
                <code className="rounded bg-muted px-1 text-foreground/90">scheduled-dreaming</code>).
              </li>
            </ol>
            <div className="border-t border-border pt-3 text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">Related:</span>{' '}
              <Link className="text-primary underline-offset-4 hover:underline" to={memPath}>
                Long-Term Memory
              </Link>
              {' · '}
              <Link className="text-primary underline-offset-4 hover:underline" to={beliefsPath}>
                Belief Map
              </Link>
              {' · '}
              <Link className="text-primary underline-offset-4 hover:underline" to="/scheduler">
                Scheduler
              </Link>
              {' · '}
              <Link className="text-primary underline-offset-4 hover:underline" to={healthPath}>
                Cognitive Health
              </Link>{' '}
              (dream runs count toward readiness snapshots).
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard label="Dream runs (listed)" value={dreams.length} hint="Latest 50 shown" />
            <StatCard
              label="Memories in window"
              value={source.memoryCount}
              hint={`Up to ${DREAM_SOURCE_LIMIT} newest pulled`}
            />
            <StatCard
              label="Beliefs in window"
              value={source.beliefCount}
              hint={`Up to ${DREAM_SOURCE_LIMIT} newest pulled`}
            />
          </div>

          {!canDream ? (
            <EmptyState
              title="No recent sources yet"
              description="Run a few graph or stream sessions with memories enabled, or add beliefs, then return. Dreaming needs at least one item in the six-slot memory or belief window."
            />
          ) : null}

          {dreams.length === 0 && canDream ? (
            <EmptyState
              title="No dream runs yet"
              description="Start a run to create the first DreamRun and dream-type memory from your current memory and belief slice."
            />
          ) : null}

          {dreams.map((dream) => (
            <Panel key={dream.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">{formatRelative(dream.created_date)}</div>
                <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-500/90">
                  DreamRun
                </span>
              </div>
              <div className="mt-2 whitespace-pre-wrap text-sm text-foreground/85">{dream.output}</div>
            </Panel>
          ))}
        </div>
      </div>
    </PageShell>
  );
}

export function RLHFPage() {
  const [candidates, setCandidates] = useState([]);
  const [feedback, setFeedback] = useState([]);
  const [ratingBusyKey, setRatingBusyKey] = useState(null);

  const load = async () => {
    const [runs, items] = await Promise.all([
      PipelineRun.list('-created_date', 12),
      FeedbackItem.list('-created_date', 100),
    ]);

    setCandidates(
      runs.map((run) => ({
        id: run.id,
        type: 'pipeline',
        prompt: run.input,
        output: run.final_output || '',
      }))
    );
    setFeedback(items);
  };

  useEffect(() => {
    load();
  }, []);

  const rate = async (candidate, rating) => {
    const key = `${candidate.type}-${candidate.id}-${rating}`;
    setRatingBusyKey(key);
    try {
      await FeedbackItem.create({
        candidate_id: candidate.id,
        candidate_type: candidate.type,
        prompt: candidate.prompt,
        output: candidate.output,
        rating,
      });
      await load();
    } finally {
      setRatingBusyKey(null);
    }
  };

  return (
    <PageShell icon={ThumbsUp} title="RLHF Feedback" description="Rate saved outputs so you can reuse them later as local preference data.">
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="space-y-3">
          <div className="text-sm font-semibold">Rate Candidates</div>
          {candidates.length === 0 ? (
            <EmptyState title="No candidates yet" description="Create graph or stream pipeline runs first." />
          ) : null}
          {candidates.map((candidate) => {
            const cid = `${candidate.type}-${candidate.id}`;
            const busyUp = ratingBusyKey === `${cid}-up`;
            const busyDown = ratingBusyKey === `${cid}-down`;
            const rowBusy = busyUp || busyDown;
            return (
            <Panel key={cid}>
              <div className="text-xs text-muted-foreground">{candidate.type}</div>
              <div className="mt-1 text-sm font-semibold">{candidate.prompt || 'Untitled prompt'}</div>
              <div className="mt-2 text-sm text-foreground/80">{truncate(candidate.output, 280)}</div>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="outline"
                  disabled={rowBusy}
                  onClick={() => void rate(candidate, 'up')}
                  className="gap-2"
                >
                  {busyUp ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsUp className="h-4 w-4" />} Useful
                </Button>
                <Button
                  variant="outline"
                  disabled={rowBusy}
                  onClick={() => void rate(candidate, 'down')}
                  className="gap-2"
                >
                  {busyDown ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsDown className="h-4 w-4" />} Weak
                </Button>
              </div>
            </Panel>
          );
          })}
        </div>
        <div className="space-y-3">
          <div className="text-sm font-semibold">Saved Feedback</div>
          {feedback.length === 0 ? <EmptyState title="No feedback yet" description="Ratings will be stored here for dataset creation." /> : null}
          {feedback.map((item) => (
            <Panel key={item.id}>
              <div className="text-xs text-muted-foreground">{item.candidate_type} · {item.rating} · {formatRelative(item.created_date)}</div>
              <div className="mt-1 text-sm font-semibold">{item.prompt || 'Untitled prompt'}</div>
            </Panel>
          ))}
        </div>
      </div>
    </PageShell>
  );
}

export function TrainingPage() {
  const [runs, setRuns] = useState([]);
  const [form, setForm] = useState({ name: '', objective: '', datasetCount: '0' });
  const [creatingTrainingRun, setCreatingTrainingRun] = useState(false);
  const [statusUpdatingId, setStatusUpdatingId] = useState(null);

  const load = async () => {
    setRuns(await TrainingRun.listAll('-created_date'));
  };

  useEffect(() => {
    load();
  }, []);

  const createRun = async () => {
    if (!form.name.trim()) return;
    setCreatingTrainingRun(true);
    try {
      await TrainingRun.create({
        name: form.name,
        objective: form.objective,
        dataset_count: Number(form.datasetCount) || 0,
        status: 'draft',
      });
      setForm({ name: '', objective: '', datasetCount: '0' });
      await load();
    } finally {
      setCreatingTrainingRun(false);
    }
  };

  const updateStatus = async (run, status) => {
    setStatusUpdatingId(run.id);
    try {
      await TrainingRun.update(run.id, { status });
      await load();
    } finally {
      setStatusUpdatingId(null);
    }
  };

  return (
    <PageShell
      icon={Brain}
      title="Training Config"
      description="Track local fine-tuning experiments, objectives, and status changes. Use Training and System Chat in the sidebar for the run log and per-module prompts."
    >
      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <Panel className="space-y-3">
          <div className="text-sm font-semibold">New Training Run</div>
          <Input value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} placeholder="Run name" />
          <Input value={form.datasetCount} onChange={(e) => setForm((prev) => ({ ...prev, datasetCount: e.target.value }))} placeholder="Dataset count" />
          <Textarea value={form.objective} onChange={(e) => setForm((prev) => ({ ...prev, objective: e.target.value }))} placeholder="Objective" className="min-h-[180px]" />
          <Button
            onClick={() => void createRun()}
            disabled={creatingTrainingRun || !form.name.trim()}
            className="w-full gap-2"
          >
            {creatingTrainingRun ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create Run
          </Button>
        </Panel>
        <div className="space-y-3">
          {runs.length === 0 ? <EmptyState title="No training runs yet" description="Create a local training plan to track it here." /> : null}
          {runs.map((run) => (
            <Panel key={run.id}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">{run.name}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{run.status} · {run.dataset_count || 0} datasets · {formatRelative(run.created_date)}</div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={statusUpdatingId === run.id}
                    onClick={() => void updateStatus(run, 'running')}
                    className="gap-1"
                  >
                    {statusUpdatingId === run.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    Start
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={statusUpdatingId === run.id}
                    onClick={() => void updateStatus(run, 'completed')}
                    className="gap-1"
                  >
                    {statusUpdatingId === run.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    Complete
                  </Button>
                </div>
              </div>
              {run.objective ? <div className="mt-3 text-sm text-foreground/80">{run.objective}</div> : null}
            </Panel>
          ))}
        </div>
      </div>
    </PageShell>
  );
}

/** Keys shown under Settings → “Mind constitution & user model” — re-sync from IndexedDB when pipeline persistence updates them. */
function pickMindConstitutionPanelFromRuntime(rs, isMirror) {
  if (!rs || typeof rs !== 'object') return {};
  const profile = isMirror ? MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR : MIND_STORAGE_PROFILE_PRIMARY;
  const slice = getPipelineIdentityRuntimeSlice(rs, profile);
  const umDefault = isMirror ? DEFAULT_RUNTIME_SETTINGS.userModelPlaygroundMirror : DEFAULT_RUNTIME_SETTINGS.userModel;
  const pinnedDefault = isMirror
    ? DEFAULT_RUNTIME_SETTINGS.pinnedWorkingMemoryPlaygroundMirror
    : DEFAULT_RUNTIME_SETTINGS.pinnedWorkingMemory;
  return {
    defaultMindPhase: rs.defaultMindPhase,
    pinnedWorkingMemory: Array.isArray(slice.pinnedWorkingMemory) ? [...slice.pinnedWorkingMemory] : [...pinnedDefault],
    mindConstitution: slice.mindConstitution ?? '',
    mindDisplayName: slice.mindDisplayName ?? '',
    userModel: {
      ...umDefault,
      ...(slice.userModel && typeof slice.userModel === 'object' ? slice.userModel : {}),
    },
  };
}

/**
 * Which engine runs the graph pipeline: the Express backend, or a model loaded
 * directly into this browser via WebGPU (see src/lib/localPipeline/). Kept as
 * its own panel rather than folded into the big Runtime Settings form below —
 * this is an execution-transport switch (localPipeline/executionBackend.js),
 * not a mind/pipeline behavior setting.
 */
function LlmExecutionPanel() {
  const browserOnlyForced = import.meta.env.VITE_BROWSER_ONLY === '1';
  const [backend, setBackend] = useState(() => getPipelineExecutionBackend());
  const [webgpuOk, setWebgpuOk] = useState(null);
  const [selectedModel, setSelectedModel] = useState(AVAILABLE_MODELS[0].id);
  const [engineStatus, setEngineStatus] = useState(() => (getLoadedModelId() ? 'ready' : 'idle'));
  const [loadProgress, setLoadProgress] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setWebgpuOk(isWebGPUAvailable());
  }, []);

  function handleSelectBackend(next) {
    setPipelineExecutionBackend(next);
    setBackend(next);
  }

  async function handleLoadModel() {
    setEngineStatus('loading');
    setError(null);
    try {
      await loadEngine(selectedModel, (report) => setLoadProgress(report));
      setEngineStatus('ready');
    } catch (e) {
      setEngineStatus('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const showModelPicker = browserOnlyForced || backend === EXECUTION_BACKEND_BROWSER;

  return (
    <Panel className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Laptop className="h-4 w-4 text-primary" /> LLM execution
      </div>
      <p className="text-xs text-muted-foreground">
        Run the graph pipeline against your local LM Studio/HF/OpenRouter backend, or entirely
        in this browser via WebGPU — same pipeline, no server or API keys needed. Note:
        embedding-ranked retrieval, web search enrichment, attachment OCR, and the background
        scheduler are unavailable in browser execution (they need a secret key or an always-on
        process); the pipeline falls back to its recency-based defaults for those.
      </p>
      {browserOnlyForced ? (
        <p className="text-xs text-amber-600 dark:text-amber-300">
          This deployment has no backend — browser execution is always on.
        </p>
      ) : (
        <div className="flex gap-2">
          <Button
            type="button"
            variant={backend === EXECUTION_BACKEND_SERVER ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleSelectBackend(EXECUTION_BACKEND_SERVER)}
          >
            Local server
          </Button>
          <Button
            type="button"
            variant={backend === EXECUTION_BACKEND_BROWSER ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleSelectBackend(EXECUTION_BACKEND_BROWSER)}
          >
            In-browser (WebGPU)
          </Button>
        </div>
      )}
      {showModelPicker && (
        <div className="space-y-3 border-t border-border pt-3">
          {webgpuOk === false && (
            <p className="text-xs text-red-600 dark:text-red-300">
              This browser doesn't expose WebGPU — try Chrome/Edge on desktop or Safari 17+ on
              iOS/macOS.
            </p>
          )}
          <ModelPicker
            selectedId={selectedModel}
            disabled={engineStatus === 'loading'}
            onSelect={setSelectedModel}
          />
          <Button
            type="button"
            size="sm"
            disabled={engineStatus === 'loading' || webgpuOk === false}
            onClick={handleLoadModel}
          >
            {engineStatus === 'ready'
              ? 'Reload model'
              : engineStatus === 'loading'
                ? 'Downloading…'
                : 'Download & load model'}
          </Button>
          <LoadProgress status={engineStatus} progress={loadProgress} />
          {error && <p className="text-xs text-red-600 dark:text-red-300">{error}</p>}
        </div>
      )}
    </Panel>
  );
}

export function SettingsPage() {
  const { isMirror } = useMindScope();
  const [settings, setSettings] = useState(DEFAULT_RUNTIME_SETTINGS);
  const [savedAt, setSavedAt] = useState(null);
  const [moduleDefaults, setModuleDefaults] = useState([]);
  const [moduleDrafts, setModuleDrafts] = useState({});
  /** 'api' = from GET /api/pipeline/module-defaults; 'bundled' = same text from shared/pipelineModules.mjs (API missing or error). */
  const [moduleDefaultsSource, setModuleDefaultsSource] = useState(null);
  /** Bumps when user syncs from browser storage so controlled fields remount with fresh values. */
  const [mindConstitutionPanelKey, setMindConstitutionPanelKey] = useState(0);

  const moduleMetaByName = useMemo(() => {
    const map = {};
    for (const m of COGNITIVE_MODULES) {
      map[m.name] = m;
    }
    return map;
  }, []);

  const refreshMindConstitutionPanelFromStorage = useCallback(() => {
    const rs = getRuntimeSettings();
    setSettings((prev) => ({ ...prev, ...pickMindConstitutionPanelFromRuntime(rs, isMirror) }));
    setMindConstitutionPanelKey((k) => k + 1);
  }, [isMirror]);

  useMindStorageRefresh(refreshMindConstitutionPanelFromStorage);

  useEffect(() => {
    setSettings(getRuntimeSettings());
  }, []);

  useEffect(() => {
    refreshMindConstitutionPanelFromStorage();
  }, [isMirror, refreshMindConstitutionPanelFromStorage]);

  useEffect(() => {
    let cancelled = false;
    const bundled = pipelineModulesToDefaultsList(BUNDLED_PIPELINE_MODULES);

    const apply = (modules, source) => {
      if (cancelled || !Array.isArray(modules) || modules.length === 0) return;
      setModuleDefaults(modules);
      setModuleDefaultsSource(source);
    };

    fetch('/api/pipeline/module-defaults')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data.modules) && data.modules.length > 0) {
          apply(data.modules, 'api');
          return;
        }
        throw new Error('Invalid response');
      })
      .catch(() => {
        if (cancelled) return;
        apply(bundled, 'bundled');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (moduleDefaults.length === 0) return;
    const rs = getRuntimeSettings();
    const ov = isMirror ? rs.modulePromptOverridesPlaygroundMirror : rs.modulePromptOverrides;
    setModuleDrafts(initializeModulePromptDrafts(moduleDefaults, ov));
  }, [moduleDefaults, isMirror]);

  const persistSettings = () => {
    const modulePromptOverrides =
      moduleDefaults.length > 0
        ? buildModulePromptOverridesForSave(moduleDefaults, moduleDrafts)
        : (isMirror ? settings.modulePromptOverridesPlaygroundMirror : settings.modulePromptOverrides) || {};

    /** Form state maps both scopes onto `mindConstitution` / `userModel` etc.; restore the inactive scope from storage so we never cross-write. */
    const cur = getRuntimeSettings();
    const crossScopeRestore = isMirror
      ? {
          mindConstitution: cur.mindConstitution,
          mindDisplayName: cur.mindDisplayName,
          userModel: cur.userModel,
          pinnedWorkingMemory: cur.pinnedWorkingMemory,
          modulePromptOverrides: cur.modulePromptOverrides,
        }
      : {
          mindConstitutionPlaygroundMirror: cur.mindConstitutionPlaygroundMirror,
          mindDisplayNamePlaygroundMirror: cur.mindDisplayNamePlaygroundMirror,
          userModelPlaygroundMirror: cur.userModelPlaygroundMirror,
          pinnedWorkingMemoryPlaygroundMirror: cur.pinnedWorkingMemoryPlaygroundMirror,
          modulePromptOverridesPlaygroundMirror: cur.modulePromptOverridesPlaygroundMirror,
        };

    const next = saveRuntimeSettings({
      ...settings,
      ...crossScopeRestore,
      pipelineDelayMs: Number(settings.pipelineDelayMs) || DEFAULT_RUNTIME_SETTINGS.pipelineDelayMs,
      pipelineMaxTokens: Number(settings.pipelineMaxTokens) || DEFAULT_RUNTIME_SETTINGS.pipelineMaxTokens,
      pipelineProfile: ['unified', 'classic'].includes(String(settings.pipelineProfile))
        ? settings.pipelineProfile
        : DEFAULT_RUNTIME_SETTINGS.pipelineProfile,
      pipelineGating: ['off', 'aggressive', 'default'].includes(String(settings.pipelineGating))
        ? settings.pipelineGating
        : DEFAULT_RUNTIME_SETTINGS.pipelineGating,
      forkJoinWave: settings.forkJoinWave === true,
      maxMetacognitionReruns: resolveMaxMetacognitionReruns({
        maxMetacognitionReruns: Number(settings.maxMetacognitionReruns),
      }),
      metacognitionRerunDelayMinutes: resolveMetacognitionRerunDelayMinutes({
        metacognitionRerunDelayMinutes: Number(settings.metacognitionRerunDelayMinutes),
      }),
      autoQueueBeliefTensionReviewDelayMinutes: Math.max(
        1,
        Math.floor(Number(settings.autoQueueBeliefTensionReviewDelayMinutes) || 3)
      ),
      autoQueueCuriosityPursuitDelayMinutes: Math.max(
        1,
        Math.floor(Number(settings.autoQueueCuriosityPursuitDelayMinutes) || 2)
      ),
      curiosityPursuitMaxPerDay: Math.max(
        0,
        Math.floor(Number(settings.curiosityPursuitMaxPerDay) || 0)
      ),
      curiosityDeepPursuitMaxRunsPerAction: Math.max(
        1,
        Math.floor(Number(settings.curiosityDeepPursuitMaxRunsPerAction) || 3)
      ),
      curiosityDeepPursuitMaxDepth: Math.max(
        1,
        Math.floor(Number(settings.curiosityDeepPursuitMaxDepth) || 4)
      ),
      curiositySchedulePursuitDelayMinutes: Math.max(
        1,
        Math.floor(Number(settings.curiositySchedulePursuitDelayMinutes) || 15)
      ),
      curiosityClusterScheduleStaggerMinutes: Math.max(
        1,
        Math.floor(Number(settings.curiosityClusterScheduleStaggerMinutes) || 30)
      ),
      curiosityPursuitDeferWhenBusyMinutes: Math.max(
        1,
        Math.floor(Number(settings.curiosityPursuitDeferWhenBusyMinutes) || 10)
      ),
      goalPursuitMaxPerDay: Math.max(0, Math.floor(Number(settings.goalPursuitMaxPerDay) || 0)),
      goalDeepPursuitMaxRunsPerAction: Math.max(
        1,
        Math.floor(Number(settings.goalDeepPursuitMaxRunsPerAction) || 3)
      ),
      goalDeepPursuitMaxDepth: Math.max(1, Math.floor(Number(settings.goalDeepPursuitMaxDepth) || 4)),
      goalSchedulePursuitDelayMinutes: Math.max(
        1,
        Math.floor(Number(settings.goalSchedulePursuitDelayMinutes) || 18)
      ),
      goalClusterScheduleStaggerMinutes: Math.max(
        1,
        Math.floor(Number(settings.goalClusterScheduleStaggerMinutes) || 35)
      ),
      goalPursuitDeferWhenBusyMinutes: Math.max(
        1,
        Math.floor(Number(settings.goalPursuitDeferWhenBusyMinutes) || 10)
      ),
      graphPipelineReconnectResumeCooldownMs: Math.max(
        60_000,
        Number(settings.graphPipelineReconnectResumeCooldownMs) ||
          DEFAULT_RUNTIME_SETTINGS.graphPipelineReconnectResumeCooldownMs
      ),
      graphPipelineReconnectResumeMaxPerCooldown: Math.max(
        1,
        Math.floor(
          Number(settings.graphPipelineReconnectResumeMaxPerCooldown) ||
            DEFAULT_RUNTIME_SETTINGS.graphPipelineReconnectResumeMaxPerCooldown
        )
      ),
      schedulerAutoRetryUnlimited: settings.schedulerAutoRetryUnlimited !== false,
      schedulerAutoRetryMaxAttempts: Math.max(
        0,
        Math.floor(
          Number(settings.schedulerAutoRetryMaxAttempts) ||
            DEFAULT_RUNTIME_SETTINGS.schedulerAutoRetryMaxAttempts
        )
      ),
      schedulerAutoRetryBaseDelayMinutes: Math.max(
        1,
        Math.floor(
          Number(settings.schedulerAutoRetryBaseDelayMinutes) ||
            DEFAULT_RUNTIME_SETTINGS.schedulerAutoRetryBaseDelayMinutes
        )
      ),
      schedulerAutoRetryMaxDelayMinutes: Math.max(
        1,
        Math.floor(
          Number(settings.schedulerAutoRetryMaxDelayMinutes) ||
            DEFAULT_RUNTIME_SETTINGS.schedulerAutoRetryMaxDelayMinutes
        )
      ),
      staleRunningScheduledTaskMinutes: Math.max(
        5,
        Math.min(
          1440,
          Math.floor(
            Number(settings.staleRunningScheduledTaskMinutes) ||
              DEFAULT_RUNTIME_SETTINGS.staleRunningScheduledTaskMinutes
          )
        )
      ),
      schedulerHeartbeatIntervalMs: Math.max(
        0,
        Math.min(
          3_600_000,
          Math.floor(
            Number(settings.schedulerHeartbeatIntervalMs) ??
              DEFAULT_RUNTIME_SETTINGS.schedulerHeartbeatIntervalMs
          )
        )
      ),
      schedulerMaxConcurrentRunningTasks: (() => {
        const raw = settings.schedulerMaxConcurrentRunningTasks;
        const n =
          raw === '' || raw == null
            ? DEFAULT_RUNTIME_SETTINGS.schedulerMaxConcurrentRunningTasks
            : Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
          return DEFAULT_RUNTIME_SETTINGS.schedulerMaxConcurrentRunningTasks;
        }
        return Math.min(32, Math.floor(n));
      })(),
      ...(isMirror
        ? {
            userModelPlaygroundMirror: {
              ...DEFAULT_RUNTIME_SETTINGS.userModelPlaygroundMirror,
              ...(settings.userModel || {}),
            },
            mindConstitutionPlaygroundMirror: settings.mindConstitution ?? '',
            mindDisplayNamePlaygroundMirror: settings.mindDisplayName ?? '',
            pinnedWorkingMemoryPlaygroundMirror: Array.isArray(settings.pinnedWorkingMemory)
              ? settings.pinnedWorkingMemory
              : [],
            modulePromptOverridesPlaygroundMirror: modulePromptOverrides,
          }
        : {
            userModel: {
              ...DEFAULT_RUNTIME_SETTINGS.userModel,
              ...(settings.userModel || {}),
            },
            mindConstitution: settings.mindConstitution,
            mindDisplayName: settings.mindDisplayName,
            pinnedWorkingMemory: settings.pinnedWorkingMemory,
            modulePromptOverrides,
          }),
    });
    /** Map persisted primary vs mirror identity back onto form keys (`mindConstitution` etc.); avoid showing primary text on System B after save. */
    setSettings({
      ...next,
      ...pickMindConstitutionPanelFromRuntime(next, isMirror),
    });
    if (moduleDefaults.length > 0) {
      const ovNext = isMirror ? next.modulePromptOverridesPlaygroundMirror : next.modulePromptOverrides;
      setModuleDrafts(initializeModulePromptDrafts(moduleDefaults, ovNext));
    }
    setSavedAt(new Date().toISOString());
  };

  const saveModulePrompts = () => {
    try {
      persistSettings();
      const rs = getRuntimeSettings();
      const ovKey = isMirror ? rs.modulePromptOverridesPlaygroundMirror : rs.modulePromptOverrides;
      const overrideCount = Object.keys(ovKey || {}).length;
      toast({
        title: 'Module prompts saved',
        description:
          overrideCount > 0
            ? `${overrideCount} custom prompt${overrideCount === 1 ? '' : 's'} will apply on the next pipeline run.`
            : 'Stored locally. All module prompts match the built-in defaults.',
      });
    } catch (err) {
      console.error(err);
      toast({
        title: 'Could not save module prompts',
        description:
          err instanceof Error ? err.message : 'Writing settings to local storage failed (e.g. quota or private mode).',
        variant: 'destructive',
      });
    }
  };

  const resetModulePrompt = (name) => {
    const m = moduleDefaults.find((x) => x.name === name);
    if (!m) return;
    setModuleDrafts((prev) => ({ ...prev, [name]: m.systemPrompt }));
  };

  const umDefault = isMirror ? DEFAULT_RUNTIME_SETTINGS.userModelPlaygroundMirror : DEFAULT_RUNTIME_SETTINGS.userModel;
  const um = settings.userModel || umDefault;

  return (
    <PageShell icon={Settings} title="Settings" description="Adjust runtime preferences that affect the graph pipeline and related local behavior.">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <MindScopeTabs />
      </div>
      {isMirror ? (
        <p className="mb-4 rounded-lg border border-border/80 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          System B: core values, user model, pinned working memory, and module prompt overrides below apply only to the
          playground mirror mind — not the primary pipeline.
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Panel className="space-y-2 border-dashed xl:col-span-2">
          <div className="text-sm font-semibold">Epistemic note</div>
          <p className="text-xs text-muted-foreground">
            Pipeline and chat outputs are simulated cognitive stances from LLM modules. They are not private phenomenal
            experience, consciousness, or sentience in the philosophical sense—useful metaphors and structured processing only.
          </p>
        </Panel>
        <LlmExecutionPanel />
        <Panel className="space-y-4">
          <div className="text-sm font-semibold">Runtime Settings</div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Preferred model label</div>
            <Input
              value={settings.preferredModelLabel}
              onChange={(e) => setSettings((prev) => ({ ...prev, preferredModelLabel: e.target.value }))}
              placeholder="e.g. NeuralDareDevil-8B-Abliterated"
              className="bg-muted/30"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Display only. Real routing is in <code className="text-[10px]">.env</code> (HF router, OpenRouter, local) and{' '}
              <code className="text-[10px]">LLM_LOCAL_FIRST</code> / <code className="text-[10px]">LLM_HF_FIRST</code> on the
              backend.
            </p>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">OpenRouter API key (optional)</div>
            <Input
              type="password"
              autoComplete="off"
              value={settings.openrouterApiKey ?? ''}
              onChange={(e) => setSettings((prev) => ({ ...prev, openrouterApiKey: e.target.value }))}
              placeholder="sk-or-… (stored in this browser only)"
              className="bg-muted/30 font-mono text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Sent to your local API with each LLM request so OpenRouter can sit in the provider chain. Prefer{' '}
              <code className="text-[10px]">OPENROUTER_API_KEY</code> in <code className="text-[10px]">.env</code> for multiple
              machines. Never exported in mind backups; not stored on pipeline run rows.
            </p>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Pipeline delay (ms)</div>
            <Input
              value={settings.pipelineDelayMs}
              onChange={(e) => setSettings((prev) => ({ ...prev, pipelineDelayMs: e.target.value }))}
              placeholder="e.g. 500"
              className="bg-muted/30"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Reserved for pacing between stages in custom tooling. The built-in graph pipeline transcript does not currently
              wait on this value.
            </p>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Pipeline max tokens (per module)</div>
            <Input
              value={settings.pipelineMaxTokens}
              onChange={(e) => setSettings((prev) => ({ ...prev, pipelineMaxTokens: e.target.value }))}
              placeholder="e.g. 800"
              className="bg-muted/30"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Sent as <code className="text-[10px]">max_tokens</code> for each module in graph pipeline runs; the server may
              clamp to fit <code className="text-[10px]">LLM_CONTEXT_TOKENS_MAX</code> (match LM Studio n_ctx). Default 800
              favors stable runs on 4k–8k context; raise for larger models or richer module text.
            </p>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Pipeline profile</div>
            <select
              value={settings.pipelineProfile ?? DEFAULT_RUNTIME_SETTINGS.pipelineProfile}
              onChange={(e) => setSettings((prev) => ({ ...prev, pipelineProfile: e.target.value }))}
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="unified">Unified (one early call for layers 1–4, faster)</option>
              <option value="classic">Classic (separate LLM per module, debug / compatibility)</option>
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              <span className="font-mono">PIPELINE_PROFILE</span> in <code className="text-[10px]">.env</code> can force classic
              for the whole server.
            </p>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Pipeline gating</div>
            <select
              value={settings.pipelineGating ?? DEFAULT_RUNTIME_SETTINGS.pipelineGating}
              onChange={(e) => setSettings((prev) => ({ ...prev, pipelineGating: e.target.value }))}
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="default">Default (no skipping)</option>
              <option value="aggressive">Aggressive (may skip self-relation on very short turns)</option>
              <option value="off">Off (same as default)</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="forkJoinWave"
              type="checkbox"
              checked={settings.forkJoinWave === true}
              onChange={(e) => setSettings((prev) => ({ ...prev, forkJoinWave: e.target.checked }))}
            />
            <label htmlFor="forkJoinWave" className="text-sm text-foreground/90">
              Parallel epistemic similarity at Integration (finalize) — <span className="font-mono">forkJoinWave</span>
            </label>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              Max supervisor reruns before Voice (0–20)
            </div>
            <Input
              value={String(
                settings.maxMetacognitionReruns ?? DEFAULT_RUNTIME_SETTINGS.maxMetacognitionReruns
              )}
              onChange={(e) => setSettings((prev) => ({ ...prev, maxMetacognitionReruns: e.target.value }))}
              placeholder="e.g. 1"
              className="bg-muted/30"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Total supervisor rework legs allowed for <strong>one user message</strong> (replay layers 1–4 via inline, chained SSE,
              or deferred schedule)—the count carries across continuation POSTs; it is not reset each leg. Metacognition and
              Workspace Metacognition share this budget. At <span className="font-mono">0</span>, explicit RERUN does not start
              another leg—the pipeline continues toward Voice in the same HTTP leg. Structural gaps over the cap still log “would
              rerun” and continue. When a counted rerun runs, delay below chooses a scheduled task (minutes &gt; 0) or immediate
              chained SSE legs (0).
            </p>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              Supervisor RERUN delay (minutes, 0–120)
            </div>
            <Input
              value={String(
                settings.metacognitionRerunDelayMinutes ??
                  DEFAULT_RUNTIME_SETTINGS.metacognitionRerunDelayMinutes
              )}
              onChange={(e) =>
                setSettings((prev) => ({ ...prev, metacognitionRerunDelayMinutes: e.target.value }))
              }
              placeholder="e.g. 0"
              className="bg-muted/30"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              The default (<span className="font-mono">0</span>) means that on RERUN the client immediately chains the next SSE
              POST (<span className="font-mono">pipeline_continuation</span>, no scheduler) and restarts from Perception through
              Voice in the same session.               Values of <span className="font-mono">1</span> or more minutes end the first leg with{' '}
              <span className="font-mono">complete</span> (partial, no Voice yet) and enqueue an IndexedDB scheduled task to run
              the continuation at least <span className="font-mono">2</span> minutes later (
              <span className="font-mono">1</span> is treated as <span className="font-mono">2</span>) with the same input +
              shared memory—Mind graph, curiosity/goal pursuits, and every other graph entry path. Keep the app open near the
              due time when using delayed mode.
            </p>
          </div>
          <div className="space-y-2 rounded-md border border-border/60 bg-muted/10 p-3">
            <div className="text-xs font-medium text-muted-foreground">Scheduled task runner (stale detection)</div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Stale threshold (min)
                </div>
                <Input
                  value={String(
                    settings.staleRunningScheduledTaskMinutes ??
                      DEFAULT_RUNTIME_SETTINGS.staleRunningScheduledTaskMinutes
                  )}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, staleRunningScheduledTaskMinutes: e.target.value }))
                  }
                  placeholder="120"
                  className="h-8 bg-muted/30 text-sm"
                />
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Progress heartbeat (ms)
                </div>
                <Input
                  value={String(
                    settings.schedulerHeartbeatIntervalMs ??
                      DEFAULT_RUNTIME_SETTINGS.schedulerHeartbeatIntervalMs
                  )}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, schedulerHeartbeatIntervalMs: e.target.value }))
                  }
                  placeholder="300000"
                  className="h-8 bg-muted/30 text-sm"
                />
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Max concurrent runs
                </div>
                <Input
                  value={String(
                    settings.schedulerMaxConcurrentRunningTasks ??
                      DEFAULT_RUNTIME_SETTINGS.schedulerMaxConcurrentRunningTasks
                  )}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, schedulerMaxConcurrentRunningTasks: e.target.value }))
                  }
                  placeholder="3"
                  className="h-8 bg-muted/30 text-sm"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              If a task stays <span className="font-mono">running</span> longer than the stale threshold without finishing,
              the runner treats it as a crashed tab (or hung pipeline) and fails or auto-requeues it. Heartbeats update{' '}
              <span className="font-mono text-[10px]">scheduler_last_progress_at</span> while SSE is active so long graph runs
              are not cut off at the threshold. Set <span className="font-mono">0</span> heartbeat to disable bumps (not
              recommended). Max concurrent caps how many due tasks start at once (empty or invalid falls back to default{' '}
              <span className="font-mono">3</span>; use <span className="font-mono">1</span> to serialize). Also tune{' '}
              <span className="font-mono">LOCAL_LLM_TIMEOUT_MS</span> in <span className="font-mono">.env</span> for per-module
              caps.
            </p>
          </div>
          <div className="space-y-2 rounded-md border border-border/60 bg-muted/10 p-3">
            <div className="text-xs font-medium text-muted-foreground">Scheduled task auto-retry</div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.schedulerAutoRetryEnabled !== false}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, schedulerAutoRetryEnabled: e.target.checked }))
                }
              />
              Re-queue failed runs with exponential backoff
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.schedulerAutoRetryUnlimited !== false}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, schedulerAutoRetryUnlimited: e.target.checked }))
                }
              />
              Unlimited retries until a run succeeds
            </label>
            <div className="grid gap-2 sm:grid-cols-3">
              {settings.schedulerAutoRetryUnlimited === false ? (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Max attempts</div>
                  <Input
                    value={String(
                      settings.schedulerAutoRetryMaxAttempts ?? DEFAULT_RUNTIME_SETTINGS.schedulerAutoRetryMaxAttempts
                    )}
                    onChange={(e) =>
                      setSettings((prev) => ({ ...prev, schedulerAutoRetryMaxAttempts: e.target.value }))
                    }
                    placeholder="10"
                    className="h-8 bg-muted/30 text-sm"
                  />
                </div>
              ) : (
                <div className="flex items-end pb-2 text-[11px] text-muted-foreground sm:col-span-1">
                  No cap — backoff still applies between tries.
                </div>
              )}
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Base delay (min)</div>
                <Input
                  value={String(
                    settings.schedulerAutoRetryBaseDelayMinutes ??
                      DEFAULT_RUNTIME_SETTINGS.schedulerAutoRetryBaseDelayMinutes
                  )}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, schedulerAutoRetryBaseDelayMinutes: e.target.value }))
                  }
                  placeholder="5"
                  className="h-8 bg-muted/30 text-sm"
                />
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Max delay (min)</div>
                <Input
                  value={String(
                    settings.schedulerAutoRetryMaxDelayMinutes ??
                      DEFAULT_RUNTIME_SETTINGS.schedulerAutoRetryMaxDelayMinutes
                  )}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, schedulerAutoRetryMaxDelayMinutes: e.target.value }))
                  }
                  placeholder="60"
                  className="h-8 bg-muted/30 text-sm"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Failed or stale runs return to <span className="font-mono">pending</span> with backoff between tries. With
              unlimited retries on, they keep requeueing until one succeeds (or turn off &ldquo;Re-queue failed runs&rdquo;).
              With unlimited off, set max attempts; use <span className="font-mono">0</span> there to stop after the first
              failure. Per-task opt-out:{' '}
              <span className="font-mono text-[10px]">scheduler_auto_retry: false</span> on the scheduled row.
            </p>
          </div>
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.preserveModuleTrace === true}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, preserveModuleTrace: e.target.checked }))
                }
              />
              Preserve full module trace across turns (deep continuation)
            </label>
            <p className="ml-6 text-xs text-muted-foreground">
              Off by default. When off, each new graph or stream run clears prior Perception→Voice outputs from shared memory so
              the model prioritizes your latest message and <span className="font-mono">RECENT_EXCHANGE</span> without replaying
              the last run’s intermediate modules. Turn on only if you intentionally want the next run to build on the exact
              prior module text.
            </p>
          </div>
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.strictGlobalWorkspaceBroadcast === true}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, strictGlobalWorkspaceBroadcast: e.target.checked }))
                }
              />
              Strict global-workspace broadcast (Language → Narrative → Voice)
            </label>
            <p className="ml-6 text-xs text-muted-foreground">
              When on, downstream expression stages see a <strong className="text-foreground/90">reduced</strong>{' '}
              <span className="font-mono">moduleOutputs</span> slice in{' '}
              <span className="font-mono">SHARED_MEMORY_JSON</span> (Attention, Contradiction Engine, Reasoning, supervisors,
              Integration, and modules referenced in the workspace). They are steered to treat{' '}
              <span className="font-mono">GLOBAL_WORKSPACE_JSON</span> as the conscious packet for the turn. Use for
              GWT-style discipline; turn off if replies lose needed detail on belief-heavy inputs.
            </p>
          </div>
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.autoSaveMemories}
                onChange={(e) => setSettings((prev) => ({ ...prev, autoSaveMemories: e.target.checked }))}
              />
              Auto-save pipeline output as long-term memory
            </label>
            <p className="ml-6 text-xs text-muted-foreground">
              When enabled, completed runs in <span className="font-mono">focus</span>, <span className="font-mono">drift</span>, or{' '}
              <span className="font-mono">sleep</span> can append episodic/semantic memories from Voice or Narrative (phase
              rules in persistence). <span className="font-mono">wake</span> still records a short timeline event even if this
              is off.
            </p>
          </div>
          <div className="space-y-1">
            <div className="text-sm font-medium text-foreground">Auto-extract beliefs after pipeline runs</div>
            <p className="text-xs text-muted-foreground">
              Always on: after each saved pipeline run (graph, stream, or scheduled), the app runs the same structured
              belief merge as <span className="font-mono">belief_extraction</span> on the five most recent runs. Failures are
              logged to the console; the Beliefs page still has a manual extract button.
            </p>
          </div>
          <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
            <div className="text-sm font-semibold">Mind follow-through (scheduler)</div>
            <p className="text-xs text-muted-foreground">
              When enabled, the app queues one-shot Scheduler tasks after certain events. Requires the app open for the
              Scheduler tick to run. No duplicate pending task of the same type is created.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.autoQueueBeliefTensionReview === true}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, autoQueueBeliefTensionReview: e.target.checked }))
                }
              />
              Auto-queue belief tension review after pipeline flags contradictions
            </label>
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Delay before tension review (minutes)</div>
              <Input
                value={String(settings.autoQueueBeliefTensionReviewDelayMinutes ?? 3)}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, autoQueueBeliefTensionReviewDelayMinutes: e.target.value }))
                }
                className="bg-muted/30"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.autoQueueCuriosityPursuitAfterGeneration === true}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    autoQueueCuriosityPursuitAfterGeneration: e.target.checked,
                  }))
                }
              />
              Auto-queue curiosity pursuit after scheduled curiosity generation
            </label>
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Delay before curiosity pursuit (minutes)</div>
              <Input
                value={String(settings.autoQueueCuriosityPursuitDelayMinutes ?? 2)}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, autoQueueCuriosityPursuitDelayMinutes: e.target.value }))
                }
                className="bg-muted/30"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.curiosityPursuitUseGraphPipeline === true}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, curiosityPursuitUseGraphPipeline: e.target.checked }))
                }
              />
              Scheduled curiosity pursuit uses full graph pipeline (vs single LLM — default)
            </label>
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                Max curiosity pursuits per day (0 = unlimited)
              </div>
              <Input
                value={String(settings.curiosityPursuitMaxPerDay ?? 12)}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, curiosityPursuitMaxPerDay: e.target.value }))
                }
                className="bg-muted/30"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Deep pursue max runs per click</div>
                <Input
                  value={String(settings.curiosityDeepPursuitMaxRunsPerAction ?? 3)}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, curiosityDeepPursuitMaxRunsPerAction: e.target.value }))
                  }
                  className="bg-muted/30"
                />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Deep pursue max depth (root = 0)</div>
                <Input
                  value={String(settings.curiosityDeepPursuitMaxDepth ?? 4)}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, curiosityDeepPursuitMaxDepth: e.target.value }))
                  }
                  className="bg-muted/30"
                />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Schedule single pursuit delay (min)</div>
                <Input
                  value={String(settings.curiositySchedulePursuitDelayMinutes ?? 15)}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, curiositySchedulePursuitDelayMinutes: e.target.value }))
                  }
                  className="bg-muted/30"
                />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Cluster schedule stagger (min)</div>
                <Input
                  value={String(settings.curiosityClusterScheduleStaggerMinutes ?? 30)}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, curiosityClusterScheduleStaggerMinutes: e.target.value }))
                  }
                  className="bg-muted/30"
                />
              </div>
              <div className="sm:col-span-2">
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  Defer due pursuit when pipeline busy (min)
                </div>
                <Input
                  value={String(settings.curiosityPursuitDeferWhenBusyMinutes ?? 10)}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, curiosityPursuitDeferWhenBusyMinutes: e.target.value }))
                  }
                  className="bg-muted/30"
                />
              </div>
            </div>
            <div className="mt-4 border-t border-border/60 pt-3 text-sm font-semibold">Goal pursuit (stack)</div>
            <p className="text-xs text-muted-foreground">
              Same pattern as curiosity: <span className="font-mono">goal_pursuit</span> tasks, full graph optional, daily
              cap, deep chain limits. Goals are also suggested on the Scheduler when the stack has open rows.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.goalPursuitUseGraphPipeline === true}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, goalPursuitUseGraphPipeline: e.target.checked }))
                }
              />
              Scheduled goal pursuit uses full graph pipeline (vs single LLM — default)
            </label>
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Max goal pursuits per day (0 = unlimited)</div>
              <Input
                value={String(settings.goalPursuitMaxPerDay ?? 8)}
                onChange={(e) => setSettings((prev) => ({ ...prev, goalPursuitMaxPerDay: e.target.value }))}
                className="bg-muted/30"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Deep goal pursue max runs per click</div>
                <Input
                  value={String(settings.goalDeepPursuitMaxRunsPerAction ?? 3)}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, goalDeepPursuitMaxRunsPerAction: e.target.value }))
                  }
                  className="bg-muted/30"
                />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Deep goal pursue max depth (root = 0)</div>
                <Input
                  value={String(settings.goalDeepPursuitMaxDepth ?? 4)}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, goalDeepPursuitMaxDepth: e.target.value }))
                  }
                  className="bg-muted/30"
                />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Schedule single goal pursuit delay (min)</div>
                <Input
                  value={String(settings.goalSchedulePursuitDelayMinutes ?? 18)}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, goalSchedulePursuitDelayMinutes: e.target.value }))
                  }
                  className="bg-muted/30"
                />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Goal cluster schedule stagger (min)</div>
                <Input
                  value={String(settings.goalClusterScheduleStaggerMinutes ?? 35)}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, goalClusterScheduleStaggerMinutes: e.target.value }))
                  }
                  className="bg-muted/30"
                />
              </div>
              <div className="sm:col-span-2">
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  Defer due goal pursuit when pipeline busy (min)
                </div>
                <Input
                  value={String(settings.goalPursuitDeferWhenBusyMinutes ?? 10)}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, goalPursuitDeferWhenBusyMinutes: e.target.value }))
                  }
                  className="bg-muted/30"
                />
              </div>
            </div>
            <div className="mt-4 border-t border-border/60 pt-3 text-sm font-semibold">API reconnect recovery</div>
            <p className="text-xs text-muted-foreground">
              When the API was down and returns, or after a tab reload with an interrupted run, the app tries saved
              checkpoints first, then reconnect replay — without a second user line (rate-limited per tab). Cooperative
              pauses (Continue) are unchanged.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.autoResumeGraphPipelineOnReconnect !== false}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, autoResumeGraphPipelineOnReconnect: e.target.checked }))
                }
              />
              Auto-resume checkpoints on reconnect / reload (interrupted runs)
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Resume cooldown window (ms)</div>
                <Input
                  value={String(settings.graphPipelineReconnectResumeCooldownMs ?? 600_000)}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, graphPipelineReconnectResumeCooldownMs: e.target.value }))
                  }
                  className="bg-muted/30"
                />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Max resumes per cooldown</div>
                <Input
                  value={String(settings.graphPipelineReconnectResumeMaxPerCooldown ?? 2)}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, graphPipelineReconnectResumeMaxPerCooldown: e.target.value }))
                  }
                  className="bg-muted/30"
                />
              </div>
            </div>
          </div>
          <Button onClick={persistSettings} className="w-full gap-2"><Save className="h-4 w-4" /> Save Settings</Button>
          {savedAt ? <div className="text-xs text-muted-foreground">Saved {formatRelative(savedAt)}</div> : null}
        </Panel>
        <Panel key={mindConstitutionPanelKey} className="space-y-4 xl:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="text-sm font-semibold">Core values & user model</div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              onClick={() => {
                refreshMindConstitutionPanelFromStorage();
                toast({
                  title: 'Synced from storage',
                  description:
                    'Reloaded this panel from browser storage (same as after a pipeline save). If fields look unchanged, storage already matched the form.',
                });
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Sync core values & user model
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            These fields are merged into every pipeline POST as <code className="text-[10px]">options</code> and appear in
            CONTEXT_AND_POLICY / USER_MODEL_JSON. They steer Identity, Voice, Theory of Mind, rhythm-aware policies, and DMN
            carryover when you use drift or sleep.
          </p>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Default cognitive phase</div>
            <select
              value={settings.defaultMindPhase || 'focus'}
              onChange={(e) => setSettings((prev) => ({ ...prev, defaultMindPhase: e.target.value }))}
              className="h-9 w-full max-w-xs rounded-md border border-input bg-muted/30 px-2 text-sm"
            >
              {MIND_PHASE_OPTIONS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="mt-1 max-w-prose text-xs text-muted-foreground">
              <span className="font-mono">wake</span>: orient, narrow memory. <span className="font-mono">focus</span>: normal
              task engagement. <span className="font-mono">drift</span>: wider retrieval, DMN-like association; loads latest DMN
              carryover when available. <span className="font-mono">sleep</span>: consolidation tone, lighter belief churn.
              Scheduler and per-page controls can override this for individual runs.
            </p>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              Pinned working memory (one line per slot)
            </div>
            <Textarea
              value={(settings.pinnedWorkingMemory || []).join('\n')}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  pinnedWorkingMemory: e.target.value
                    .split('\n')
                    .map((l) => l.trim())
                    .filter(Boolean),
                }))
              }
              placeholder="e.g. Current project: …&#10;User prefers concise answers"
              className="min-h-[88px] bg-muted/30 text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Non-empty lines become initial WORKING_MEMORY_SLOTS at the start of each run (volatile desk the Memory and
              Reasoning modules can cite). They are not persisted as long-term memory unless promoted by the pipeline.
            </p>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Core values (norms & boundaries)</div>
            <Textarea
              value={settings.mindConstitution ?? ''}
              onChange={(e) => setSettings((prev) => ({ ...prev, mindConstitution: e.target.value }))}
              placeholder="Lines this mind treats as integrity constraints (e.g. never claim medical authority)."
              className="min-h-[120px] bg-muted/30 text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              This mind's evolved norms, refusals, and priorities — shaped through prior runs and human collaboration. Used by
              Identity and Voice, and in boundary checks against final output. After each run, Identity may append or replace via{' '}
              <code className="text-[10px]">CONSTITUTION_DELTA</code> (same storage as this field).
            </p>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Mind persona label (optional)</div>
            <Input
              value={settings.mindDisplayName ?? ''}
              onChange={(e) => setSettings((prev) => ({ ...prev, mindDisplayName: e.target.value }))}
              placeholder="e.g. a name for this app’s digital mind"
              className="bg-muted/30"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Shown in pipeline prompts as the <span className="font-medium">digital mind persona</span> so the model keeps
              you (the human) distinct from the mind’s first-person “I”.
            </p>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">User model (theory of mind — human interlocutor)</div>
            <p className="mb-2 text-xs text-muted-foreground">
              Rough working model of the person using the app. Shown as USER_MODEL_JSON to modules; Theory of Mind can emit
              USER_MODEL_DELTA to refine these fields after runs (snapshots stored on the Mind Self page). Empty strings in
              that delta are treated as “no change” for that field.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Your name (for prompts)
                </div>
                <Input
                  value={um.display_name ?? ''}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      userModel: {
                        ...umDefault,
                        ...prev.userModel,
                        display_name: e.target.value,
                      },
                    }))
                  }
                  placeholder="How the mind should refer to you — helps disambiguate you vs the model"
                  className="bg-muted/30"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Stored in USER_MODEL_JSON and PARTICIPANT_ROLES on each pipeline run.
                </p>
              </div>
              <div className="sm:col-span-2">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Goals</div>
                <Textarea
                  value={um.goals ?? ''}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      userModel: { ...umDefault, ...prev.userModel, goals: e.target.value },
                    }))
                  }
                  placeholder="What they are trying to accomplish"
                  className="min-h-[88px] bg-muted/30 text-sm"
                  rows={4}
                />
                <p className="mt-1 text-[10px] text-muted-foreground">Stated or inferred objectives for tailoring responses.</p>
              </div>
              <div className="sm:col-span-2">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Expertise</div>
                <Textarea
                  value={um.expertise ?? ''}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      userModel: { ...umDefault, ...prev.userModel, expertise: e.target.value },
                    }))
                  }
                  placeholder="Domain familiarity, jargon level"
                  className="min-h-[88px] bg-muted/30 text-sm"
                  rows={4}
                />
                <p className="mt-1 text-[10px] text-muted-foreground">Helps calibrate depth vs. explanation.</p>
              </div>
              <div className="sm:col-span-2">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Emotional state (working guess)
                </div>
                <Textarea
                  value={um.emotional_state ?? ''}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      userModel: { ...umDefault, ...prev.userModel, emotional_state: e.target.value },
                    }))
                  }
                  placeholder="e.g. stressed, curious, grieving"
                  className="min-h-[72px] bg-muted/30 text-sm"
                  rows={3}
                />
                <p className="mt-1 text-[10px] text-muted-foreground">Hypothesis only—modules should not treat it as fact.</p>
              </div>
              <div className="sm:col-span-2">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Communication style
                </div>
                <Textarea
                  value={um.communication_style ?? ''}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      userModel: {
                        ...umDefault,
                        ...prev.userModel,
                        communication_style: e.target.value,
                      },
                    }))
                  }
                  placeholder="e.g. direct, narrative, needs examples"
                  className="min-h-[120px] bg-muted/30 text-sm"
                  rows={5}
                />
                <p className="mt-1 text-[10px] text-muted-foreground">How they like information paced and formatted.</p>
              </div>
            </div>
          </div>
          <Button onClick={persistSettings} variant="outline" className="gap-2">
            <Save className="h-4 w-4" /> Save mind settings
          </Button>
        </Panel>
        <Panel className="space-y-3 xl:col-span-2">
          <div className="text-sm font-semibold">Pipeline module prompts</div>
          <p className="text-xs text-muted-foreground">
            Each box shows the built-in system prompt for that stage (canonical copy in{' '}
            <code className="mx-0.5">shared/pipelineModules.mjs</code>, re-exported by the API server). Edit and save to override; reset
            restores the built-in text (click Save to clear a stored override). Overrides are sent on each pipeline run. Max{' '}
            {MODULE_PROMPT_OVERRIDE_MAX_LEN.toLocaleString()} characters per module.
          </p>
          {moduleDefaultsSource === 'bundled' ? (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              Loaded prompts from the app bundle (GET <code className="mx-0.5">/api/pipeline/module-defaults</code> failed — e.g. backend
              not running, preview-only build, or an older server without that route). Use <code className="mx-0.5">npm run dev</code> for
              full stack; editing here still works.
            </div>
          ) : null}
          {moduleDefaults.length === 0 ? (
            <div className="text-sm text-muted-foreground">Loading module list…</div>
          ) : null}
          <div className="max-h-[min(70svh,720px)] space-y-2 overflow-y-auto pr-1">
            {moduleDefaults.map((m) => {
              const meta = moduleMetaByName[m.name];
              const value = moduleDrafts[m.name] ?? m.systemPrompt;
              return (
                <details
                  key={m.name}
                  className="rounded-lg border border-border bg-muted/20 [&_summary]:cursor-pointer [&_summary]:list-none [&_summary]:select-none"
                >
                  <summary className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm font-medium">
                    <span>{m.name}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        resetModulePrompt(m.name);
                      }}
                    >
                      Reset to built-in
                    </Button>
                  </summary>
                  {meta?.description ? (
                    <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{meta.description}</div>
                  ) : null}
                  <div className="border-t border-border p-3">
                    <Textarea
                      value={value}
                      onChange={(e) =>
                        setModuleDrafts((prev) => ({
                          ...prev,
                          [m.name]: e.target.value,
                        }))
                      }
                      className="min-h-[140px] bg-background font-mono text-xs leading-relaxed"
                      spellCheck={false}
                    />
                  </div>
                </details>
              );
            })}
          </div>
          <Button onClick={saveModulePrompts} variant="outline" className="gap-2">
            <Save className="h-4 w-4" /> Save module prompts
          </Button>
        </Panel>
        <Panel className="space-y-3 xl:col-span-2">
          <div className="text-sm font-semibold">Local LLM (LM Studio)</div>
          <p className="text-xs text-muted-foreground">
            Inference runs only on your machine via an OpenAI-compatible local server (<strong>LM Studio</strong> or{' '}
            <strong>Ollama</strong>). Put <code className="mx-1">LOCAL_LLM_BASE_URL</code> and{' '}
            <code className="mx-1">LOCAL_LLM_MODELS</code> in <code className="mx-1">.env</code> on the machine that runs the
            API server, not in the browser.
          </p>
          <pre className="max-h-[28rem] overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
            {LOCAL_LLM_SETUP_TEXT}
          </pre>
        </Panel>
        <Panel className="space-y-3 xl:col-span-2">
          <div className="text-sm font-semibold">Environment Notes</div>
          <div className="text-sm text-foreground/80">
            The server reads <code>LOCAL_LLM_BASE_URL</code>, <code>LOCAL_LLM_MODELS</code>, and{' '}
            <code>LM_API_TOKEN</code> (Bearer for LM Studio) from <code>.env</code> in the project root.
          </div>
          <div className="text-sm text-foreground/80">
            Pipeline delay and token budget are applied the next time you run the graph pipeline.
          </div>
          <div className="text-sm text-foreground/80">
            Browser-side settings here are local to this machine and profile.
          </div>
        </Panel>
        <Panel className="space-y-3 xl:col-span-2">
          <div className="text-sm font-semibold">Probabilistic Pipeline Features</div>
          <p className="text-xs text-muted-foreground">
            These features bridge the gap between the LLM&apos;s inherent stochasticity and the system&apos;s structured processing.
            All are configured in <code className="text-[10px]">.env</code> and degrade gracefully when disabled or unavailable.
          </p>
          <div className="mt-1 space-y-1.5 text-xs text-foreground/80">
            <div>
              <strong>Embeddings</strong> &mdash; <code className="text-[10px]">EMBEDDING_MODEL</code>,{' '}
              <code className="text-[10px]">EMBEDDING_BASE_URL</code>,{' '}
              <code className="text-[10px]">EMBEDDING_CACHE_SIZE</code>,{' '}
              <code className="text-[10px]">EMBEDDING_DISABLED</code>. Semantic cosine similarity replaces lexical Jaccard in
              epistemic fusion, personality facet ranking, and memory retrieval.
            </div>
            <div>
              <strong>Adaptive temperature</strong> &mdash; <code className="text-[10px]">ADAPTIVE_TEMPERATURE_DISABLED</code>.
              LLM temperature adjusts based on interoception (uncertainty, curiosity, tension) and cognitive phase.
            </div>
            <div>
              <strong>Soft metacognition</strong> &mdash; <code className="text-[10px]">METACOGNITION_RERUN_THRESHOLD</code>{' '}
              (default 0.5). Supervisors emit confidence scores; the rerun decision is modulated by entropy.
            </div>
            <div>
              <strong>Multi-sample</strong> &mdash;{' '}
              <code className="text-[10px]">PIPELINE_INTEGRATION_MULTI_SAMPLE</code>,{' '}
              <code className="text-[10px]">PIPELINE_CONTRADICTION_MULTI_SAMPLE</code>,{' '}
              <code className="text-[10px]">PIPELINE_MULTI_SAMPLE_MERGE</code> (llm or mechanical).
            </div>
            <div>
              <strong>Stochastic policy</strong> &mdash; <code className="text-[10px]">STOCHASTIC_POLICY_DISABLED</code>.
              Cognitive policy uses distribution sampling modulated by interoception instead of a fixed lookup table.
            </div>
            <div>
              <strong>Calibration</strong> &mdash;{' '}
              <code className="text-[10px]">CALIBRATED_THRESHOLDS_PATH</code>,{' '}
              <code className="text-[10px]">PIPELINE_TELEMETRY_PATH</code>. Decision thresholds self-adjust from telemetry via{' '}
              <code className="text-[10px]">POST /api/calibrate</code>. View current values at{' '}
              <code className="text-[10px]">GET /api/thresholds</code>.
            </div>
          </div>
        </Panel>
      </div>
    </PageShell>
  );
}

export { GoalStackPage as GoalsPage } from './GoalStackPage';
