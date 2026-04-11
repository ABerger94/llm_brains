import { getKvSync, setKvSync } from './browserStorage';

const STORAGE_KEY = 'mybrain_runtime_settings';

/**
 * Optional seed facets for new installs (Identity / Voice / Narrative). Intentionally empty —
 * traits come only from user edits or Identity TRAIT_DELTA.
 */
export const BUNDLED_DEFAULT_PERSONALITY_FACETS = [];

/**
 * Ensure mind constitution / user model / phase / pinned WM fields are always complete plain values after a shallow merge
 * from persisted settings (parsed JSON often replaces whole `userModel` with a partial object).
 */
export function normalizeMindConstitutionUserModelFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const d = DEFAULT_RUNTIME_SETTINGS;
  obj.mindConstitution = obj.mindConstitution == null ? '' : String(obj.mindConstitution);
  obj.mindDisplayName = obj.mindDisplayName == null ? '' : String(obj.mindDisplayName);
  obj.defaultMindPhase =
    typeof obj.defaultMindPhase === 'string' && String(obj.defaultMindPhase).trim()
      ? String(obj.defaultMindPhase).trim()
      : d.defaultMindPhase;
  obj.pinnedWorkingMemory = Array.isArray(obj.pinnedWorkingMemory)
    ? [...obj.pinnedWorkingMemory]
    : [...d.pinnedWorkingMemory];
  const umStored = obj.userModel && typeof obj.userModel === 'object' ? obj.userModel : {};
  const um = { ...d.userModel, ...umStored };
  /** Empty / whitespace from storage should not wipe bundled defaults (settings UI shows full profile). */
  const USER_MODEL_TEXT_KEYS = [
    'display_name',
    'goals',
    'expertise',
    'emotional_state',
    'communication_style',
  ];
  for (const k of USER_MODEL_TEXT_KEYS) {
    const raw = um[k];
    if (raw == null || !String(raw).trim()) {
      um[k] = d.userModel[k];
    } else {
      um[k] = String(raw);
    }
  }
  um.version =
    typeof umStored.version === 'number' && Number.isFinite(umStored.version)
      ? umStored.version
      : d.userModel.version;
  obj.userModel = um;
  return obj;
}

export const DEFAULT_RUNTIME_SETTINGS = {
  /** Display-only name for the LM you use locally (LM Studio / API model is configured outside this app). */
  preferredModelLabel:
    'Venice Dolphin 24B HF (dphn/…:featherless-ai) + OpenRouter · Neural Daredevil HF fallback · local LM Studio',
  /**
   * OpenRouter API key (sk-or-…). Stored in IndexedDB (KV); sent to your local Express API per request.
   * Prefer OPENROUTER_API_KEY in .env for multi-device setups.
   */
  openrouterApiKey: '',
  /** Milliseconds; reserved for tooling—default graph/stream pipeline does not throttle on this today. */
  pipelineDelayMs: 500,
  /** Per-module completion cap (server clamps to context). Default 800 keeps typical 4k–8k n_ctx locals stable; raise for larger models. */
  pipelineMaxTokens: 800,
  /** When true, focus/drift/sleep may persist voice/narrative into long-term memory per phase rules (wake still logs a timeline event). */
  autoSaveMemories: true,
  /** Always on: after each saved pipeline run the app merges structured beliefs from recent outputs (see mindPersistence). */
  autoExtractBeliefs: true,
  /** Optional display label for the digital mind (disambiguates you vs the app’s mind in pipeline prompts). */
  mindDisplayName: '',
  /** Binding principles injected into Identity/Voice and CONTEXT_AND_POLICY on the server. */
  mindConstitution: '',
  /** Default rhythm: wake (orient), focus (engage), drift (wide memory / DMN-like), sleep (consolidation tone). */
  defaultMindPhase: 'focus',
  /** Amendable interpersonal / expressive facets (TRAIT_DELTA from Identity); distinct from WorldModel structural self. */
  personalityProfile: {
    version: 1,
    facets: BUNDLED_DEFAULT_PERSONALITY_FACETS.map((f) => ({ ...f })),
    relationalStance: null,
    systemTreatmentNotes: '',
    /** When true, an empty facet list stays empty (reset / user cleared traits). */
    suppressBundledPersonalityDefaults: false,
  },
  /** Working profile of the human user: fed to Theory of Mind, USER_MODEL_JSON, and refined by USER_MODEL_DELTA from runs. */
  userModel: {
    /** How the model should refer to the human user (PARTICIPANT_ROLES / USER_MODEL_JSON). */
    display_name: 'Alek',
    goals:
      'Ship and refine a local cognitive-pipeline stack: multi-module graph, local/HF inference, and memory/belief flows that stay honest about limits. Prefer working, inspectable behavior—clear server semantics, prompts, and settings that behave predictably.',
    expertise:
      'Software development (JS/Node, browser + local API workflows). Comfortable with LLM APIs, streaming pipelines, and reading/changing prompt and policy code. Not a novice; skip basic tutorials unless asked.',
    emotional_state:
      'Values clarity and completeness; low tolerance for skipped steps or "just run X" without doing the work. Otherwise neutral—no need for motivational tone.',
    communication_style:
      'Direct, structured answers (headings/bullets when it helps). Use proper code citations with paths/lines when referencing a repo. Full commands when suggesting CLI steps. Proportional length—short for simple questions, deeper when the task is complex. Minimal bold and filler; no engagement-bait closers. If something\'s uncertain or out of scope, say so plainly.',
    version: 0,
  },
  /** Keys = pipeline module names (e.g. "Voice"); values = custom system prompts only when different from server defaults. */
  modulePromptOverrides: {},
  /** Lines seeded into WORKING_MEMORY_SLOTS at the start of each pipeline run (volatile; not long-term memory). */
  pinnedWorkingMemory: [],
  /**
   * Max counted supervisor rework legs (Metacognition / Workspace Metacognition) before Voice is required (server clamps 0–20).
   * At 0 or when exhausted, explicit RERUN no longer defers or splits legs — the pipeline proceeds toward Voice in the same leg.
   */
  maxMetacognitionReruns: 0,
  /**
   * Minutes to wait before running a deferred supervisor RERUN (browser ScheduledTask in IndexedDB).
   * Default 3: supervisor continuation runs after a short cooldown instead of immediate chained SSE legs.
   * 0 = immediate chained SSE POSTs (`pipeline_continuation`) from Perception through Voice.
   * When non-zero, the effective delay is at least 2 minutes (entering 1 uses 2).
   */
  metacognitionRerunDelayMinutes: 3,
  /**
   * When true, each new graph/stream pipeline POST keeps prior `moduleOutputs` in shared memory (deep continuation).
   * Default false: server clears prior module/layer trace so the latest user turn is not fought by last run’s Perception→Voice text;
   * beliefs, RECENT_EXCHANGE, constitution, user model, etc. still apply.
   */
  preserveModuleTrace: false,
  /**
   * When true, Language / Narrative / Voice receive a trimmed SHARED_MEMORY_JSON.moduleOutputs (supporting summaries only)
   * and prompts treat GLOBAL_WORKSPACE_JSON as the primary broadcast. Off by default to avoid dropping nuance on dense turns.
   */
  strictGlobalWorkspaceBroadcast: false,
  /** When true, completing a pipeline that sets followupHints.beliefTensionReview queues a one-shot belief_tension_review task. */
  autoQueueBeliefTensionReview: false,
  autoQueueBeliefTensionReviewDelayMinutes: 3,
  /** When true, curiosity_generation enqueues a one-shot curiosity_pursuit after a short delay. */
  autoQueueCuriosityPursuitAfterGeneration: false,
  autoQueueCuriosityPursuitDelayMinutes: 2,
  /** Scheduled curiosity_pursuit uses full graph pipeline instead of a single LLM call (higher cost). */
  curiosityPursuitUseGraphPipeline: false,
  /** Max completed curiosity_pursuit scheduled tasks per local calendar day (0 = no limit). */
  curiosityPursuitMaxPerDay: 12,
  /** On-demand deep curiosity: max graph runs per Pursue click (including the first). */
  curiosityDeepPursuitMaxRunsPerAction: 3,
  /** Do not auto-chain pursuits at or beyond this depth (root = 0). */
  curiosityDeepPursuitMaxDepth: 4,
  /** Default delay before a single scheduled curiosity pursuit (minutes). */
  curiositySchedulePursuitDelayMinutes: 15,
  /** Stagger between cluster scheduled pursuits (minutes). */
  curiosityClusterScheduleStaggerMinutes: 30,
  /** When a blocking pipeline is active, defer due curiosity_pursuit by this many minutes. */
  curiosityPursuitDeferWhenBusyMinutes: 10,
  /** Scheduled goal_pursuit uses full graph pipeline instead of a single LLM call (higher cost). */
  goalPursuitUseGraphPipeline: false,
  /** Max completed goal_pursuit scheduled tasks per local calendar day (0 = no limit). */
  goalPursuitMaxPerDay: 8,
  /** On-demand deep goal: max graph runs per Pursue click (including the first). */
  goalDeepPursuitMaxRunsPerAction: 3,
  /** Do not auto-chain goal pursuits at or beyond this depth (root = 0). */
  goalDeepPursuitMaxDepth: 4,
  /** Default delay before a single scheduled goal pursuit (minutes). */
  goalSchedulePursuitDelayMinutes: 18,
  /** Stagger between cluster scheduled goal pursuits (minutes). */
  goalClusterScheduleStaggerMinutes: 35,
  /** When a blocking pipeline is active, defer due goal_pursuit by this many minutes. */
  goalPursuitDeferWhenBusyMinutes: 10,
  /** When the API recovers, silently resume interrupted graph/stream if gates pass. */
  autoResumeGraphPipelineOnReconnect: true,
  /** Rolling window for silent graph reconnect resumes (anti-loop). */
  graphPipelineReconnectResumeCooldownMs: 600_000,
  /** Max silent graph resumes per cooldown window per tab. */
  graphPipelineReconnectResumeMaxPerCooldown: 2,
  /** When true, failed scheduled runs requeue as pending with exponential backoff (see schedulerAutoRetry). */
  schedulerAutoRetryEnabled: true,
  /**
   * When true (default), there is no cap — tasks keep requeueing until a run succeeds.
   * When false, {@link schedulerAutoRetryMaxAttempts} applies.
   */
  schedulerAutoRetryUnlimited: true,
  /** Max failure→retry cycles per task when unlimited is off (after this many failures, status stays failed). */
  schedulerAutoRetryMaxAttempts: 10,
  /** Base delay in minutes for first auto-retry (doubles each time, capped). */
  schedulerAutoRetryBaseDelayMinutes: 5,
  /** Max single backoff delay in minutes. */
  schedulerAutoRetryMaxDelayMinutes: 60,
};

/**
 * Supervisor (Metacognition / Workspace Metacognition) deferred reruns: 0 = immediate SSE continuation legs;
 * otherwise clamp to 120 and require at least 2 minutes before the IndexedDB scheduled task (1 coerces to 2).
 */
function normalizeMetacognitionRerunDelayMinutesValue(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_RUNTIME_SETTINGS.metacognitionRerunDelayMinutes;
  const floored = Math.min(120, Math.max(0, Math.floor(n)));
  if (floored === 0) return 0;
  return Math.max(2, floored);
}

/** Max length per override when saving or sending to the pipeline (storage / request size guard). */
export const MODULE_PROMPT_OVERRIDE_MAX_LEN = 32000;

/**
 * Build persisted overrides from Settings drafts: omit empty, omit when equal to default (trimmed), clip length.
 */
export function buildModulePromptOverridesForSave(moduleDefaults, moduleDrafts) {
  const overrides = {};
  if (!Array.isArray(moduleDefaults)) return overrides;
  for (const m of moduleDefaults) {
    const raw = moduleDrafts[m.name];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const def = (m.systemPrompt || '').trim();
    if (trimmed === def) continue;
    const clipped =
      raw.length > MODULE_PROMPT_OVERRIDE_MAX_LEN ? raw.slice(0, MODULE_PROMPT_OVERRIDE_MAX_LEN) : raw;
    overrides[m.name] = clipped;
  }
  return overrides;
}

/** Textarea value per module: saved override or built-in prompt. */
export function initializeModulePromptDrafts(moduleDefaults, savedOverrides) {
  const drafts = {};
  if (!Array.isArray(moduleDefaults)) return drafts;
  const ov = savedOverrides || {};
  for (const m of moduleDefaults) {
    const s = ov[m.name];
    drafts[m.name] = typeof s === 'string' && s.trim() ? s : m.systemPrompt;
  }
  return drafts;
}

export function getRuntimeSettings() {
  try {
    const raw = getKvSync(STORAGE_KEY);
    if (!raw) {
      const out = {
        ...DEFAULT_RUNTIME_SETTINGS,
        personalityProfile: {
          version: DEFAULT_RUNTIME_SETTINGS.personalityProfile.version,
          facets: BUNDLED_DEFAULT_PERSONALITY_FACETS.map((f) => ({ ...f })),
          relationalStance: DEFAULT_RUNTIME_SETTINGS.personalityProfile.relationalStance,
          systemTreatmentNotes: DEFAULT_RUNTIME_SETTINGS.personalityProfile.systemTreatmentNotes,
          suppressBundledPersonalityDefaults: false,
        },
      };
      normalizeMindConstitutionUserModelFields(out);
      return out;
    }

    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_RUNTIME_SETTINGS, ...parsed };
    if (!merged.personalityProfile || typeof merged.personalityProfile !== 'object') {
      merged.personalityProfile = {
        version: DEFAULT_RUNTIME_SETTINGS.personalityProfile.version,
        facets: BUNDLED_DEFAULT_PERSONALITY_FACETS.map((f) => ({ ...f })),
        relationalStance: null,
        systemTreatmentNotes: '',
        suppressBundledPersonalityDefaults: false,
      };
    } else {
      const suppressBundled =
        merged.personalityProfile.suppressBundledPersonalityDefaults === true;
      merged.personalityProfile = {
        ...DEFAULT_RUNTIME_SETTINGS.personalityProfile,
        ...merged.personalityProfile,
        facets: Array.isArray(merged.personalityProfile.facets)
          ? merged.personalityProfile.facets.map((f) => (f && typeof f === 'object' ? { ...f } : f))
          : [],
        suppressBundledPersonalityDefaults: suppressBundled,
      };
    }

    delete merged.multiMindMaxTokens;
    merged.autoExtractBeliefs = true;
    merged.preserveModuleTrace = parsed.preserveModuleTrace === true;
    merged.strictGlobalWorkspaceBroadcast = parsed.strictGlobalWorkspaceBroadcast === true;
    merged.autoQueueBeliefTensionReview = parsed.autoQueueBeliefTensionReview === true;
    merged.autoQueueCuriosityPursuitAfterGeneration = parsed.autoQueueCuriosityPursuitAfterGeneration === true;
    merged.curiosityPursuitUseGraphPipeline = parsed.curiosityPursuitUseGraphPipeline === true;
    if (Number.isFinite(Number(parsed.autoQueueBeliefTensionReviewDelayMinutes))) {
      merged.autoQueueBeliefTensionReviewDelayMinutes = Math.max(
        1,
        Math.floor(Number(parsed.autoQueueBeliefTensionReviewDelayMinutes))
      );
    }
    if (Number.isFinite(Number(parsed.autoQueueCuriosityPursuitDelayMinutes))) {
      merged.autoQueueCuriosityPursuitDelayMinutes = Math.max(
        1,
        Math.floor(Number(parsed.autoQueueCuriosityPursuitDelayMinutes))
      );
    }
    if (Number.isFinite(Number(parsed.curiosityPursuitMaxPerDay))) {
      merged.curiosityPursuitMaxPerDay = Math.max(0, Math.floor(Number(parsed.curiosityPursuitMaxPerDay)));
    }
    if (Number.isFinite(Number(parsed.curiosityDeepPursuitMaxRunsPerAction))) {
      merged.curiosityDeepPursuitMaxRunsPerAction = Math.max(
        1,
        Math.floor(Number(parsed.curiosityDeepPursuitMaxRunsPerAction))
      );
    }
    if (Number.isFinite(Number(parsed.curiosityDeepPursuitMaxDepth))) {
      merged.curiosityDeepPursuitMaxDepth = Math.max(1, Math.floor(Number(parsed.curiosityDeepPursuitMaxDepth)));
    }
    if (Number.isFinite(Number(parsed.curiositySchedulePursuitDelayMinutes))) {
      merged.curiositySchedulePursuitDelayMinutes = Math.max(
        1,
        Math.floor(Number(parsed.curiositySchedulePursuitDelayMinutes))
      );
    }
    if (Number.isFinite(Number(parsed.curiosityClusterScheduleStaggerMinutes))) {
      merged.curiosityClusterScheduleStaggerMinutes = Math.max(
        1,
        Math.floor(Number(parsed.curiosityClusterScheduleStaggerMinutes))
      );
    }
    if (Number.isFinite(Number(parsed.curiosityPursuitDeferWhenBusyMinutes))) {
      merged.curiosityPursuitDeferWhenBusyMinutes = Math.max(
        1,
        Math.floor(Number(parsed.curiosityPursuitDeferWhenBusyMinutes))
      );
    }
    merged.goalPursuitUseGraphPipeline = parsed.goalPursuitUseGraphPipeline === true;
    if (Number.isFinite(Number(parsed.goalPursuitMaxPerDay))) {
      merged.goalPursuitMaxPerDay = Math.max(0, Math.floor(Number(parsed.goalPursuitMaxPerDay)));
    }
    if (Number.isFinite(Number(parsed.goalDeepPursuitMaxRunsPerAction))) {
      merged.goalDeepPursuitMaxRunsPerAction = Math.max(
        1,
        Math.floor(Number(parsed.goalDeepPursuitMaxRunsPerAction))
      );
    }
    if (Number.isFinite(Number(parsed.goalDeepPursuitMaxDepth))) {
      merged.goalDeepPursuitMaxDepth = Math.max(1, Math.floor(Number(parsed.goalDeepPursuitMaxDepth)));
    }
    if (Number.isFinite(Number(parsed.goalSchedulePursuitDelayMinutes))) {
      merged.goalSchedulePursuitDelayMinutes = Math.max(
        1,
        Math.floor(Number(parsed.goalSchedulePursuitDelayMinutes))
      );
    }
    if (Number.isFinite(Number(parsed.goalClusterScheduleStaggerMinutes))) {
      merged.goalClusterScheduleStaggerMinutes = Math.max(
        1,
        Math.floor(Number(parsed.goalClusterScheduleStaggerMinutes))
      );
    }
    if (Number.isFinite(Number(parsed.goalPursuitDeferWhenBusyMinutes))) {
      merged.goalPursuitDeferWhenBusyMinutes = Math.max(
        1,
        Math.floor(Number(parsed.goalPursuitDeferWhenBusyMinutes))
      );
    }
    merged.autoResumeGraphPipelineOnReconnect = parsed.autoResumeGraphPipelineOnReconnect !== false;
    if (Number.isFinite(Number(parsed.graphPipelineReconnectResumeCooldownMs))) {
      merged.graphPipelineReconnectResumeCooldownMs = Math.max(
        60_000,
        Number(parsed.graphPipelineReconnectResumeCooldownMs)
      );
    }
    if (Number.isFinite(Number(parsed.graphPipelineReconnectResumeMaxPerCooldown))) {
      merged.graphPipelineReconnectResumeMaxPerCooldown = Math.max(
        1,
        Math.floor(Number(parsed.graphPipelineReconnectResumeMaxPerCooldown))
      );
    }
    merged.schedulerAutoRetryEnabled = parsed.schedulerAutoRetryEnabled !== false;
    merged.schedulerAutoRetryUnlimited = parsed.schedulerAutoRetryUnlimited !== false;
    if (Number.isFinite(Number(parsed.schedulerAutoRetryMaxAttempts))) {
      merged.schedulerAutoRetryMaxAttempts = Math.max(
        0,
        Math.floor(Number(parsed.schedulerAutoRetryMaxAttempts))
      );
    }
    if (Number.isFinite(Number(parsed.schedulerAutoRetryBaseDelayMinutes))) {
      merged.schedulerAutoRetryBaseDelayMinutes = Math.max(
        1,
        Math.floor(Number(parsed.schedulerAutoRetryBaseDelayMinutes))
      );
    }
    if (Number.isFinite(Number(parsed.schedulerAutoRetryMaxDelayMinutes))) {
      merged.schedulerAutoRetryMaxDelayMinutes = Math.max(
        1,
        Math.floor(Number(parsed.schedulerAutoRetryMaxDelayMinutes))
      );
    }
    if (Number.isFinite(Number(parsed.metacognitionRerunDelayMinutes))) {
      merged.metacognitionRerunDelayMinutes = normalizeMetacognitionRerunDelayMinutesValue(
        parsed.metacognitionRerunDelayMinutes
      );
    }
    // Legacy installs kept pipelineMaxTokens: 350, which cuts long module outputs mid-sentence.
    if (Number(parsed.pipelineMaxTokens) === 350) {
      merged.pipelineMaxTokens = DEFAULT_RUNTIME_SETTINGS.pipelineMaxTokens;
    }
    // Prior default 1200 + 3 reruns often overflowed 4k–8k local context; one-time nudge unless user changed either.
    if (
      Number(parsed.pipelineMaxTokens) === 1200 &&
      Number(parsed.maxMetacognitionReruns) === 3
    ) {
      merged.pipelineMaxTokens = DEFAULT_RUNTIME_SETTINGS.pipelineMaxTokens;
      merged.maxMetacognitionReruns = DEFAULT_RUNTIME_SETTINGS.maxMetacognitionReruns;
    }

    delete merged.autoRetryFailedScheduledTasksOnReconnect;
    delete merged.schedulerAutoRetryMax;
    delete merged.staleRunningScheduledTaskMs;

    normalizeMindConstitutionUserModelFields(merged);
    return merged;
  } catch (error) {
    console.error('Failed to load runtime settings:', error);
    const out = {
      ...DEFAULT_RUNTIME_SETTINGS,
      personalityProfile: {
        version: DEFAULT_RUNTIME_SETTINGS.personalityProfile.version,
        facets: BUNDLED_DEFAULT_PERSONALITY_FACETS.map((f) => ({ ...f })),
        relationalStance: DEFAULT_RUNTIME_SETTINGS.personalityProfile.relationalStance,
        systemTreatmentNotes: DEFAULT_RUNTIME_SETTINGS.personalityProfile.systemTreatmentNotes,
        suppressBundledPersonalityDefaults: false,
      },
    };
    normalizeMindConstitutionUserModelFields(out);
    return out;
  }
}

export function saveRuntimeSettings(nextSettings) {
  const current = getRuntimeSettings();
  const merged = { ...current, ...nextSettings };
  delete merged.multiMindMaxTokens;
  delete merged.autoRetryFailedScheduledTasksOnReconnect;
  delete merged.schedulerAutoRetryMax;
  delete merged.staleRunningScheduledTaskMs;
  merged.autoExtractBeliefs = true;
  merged.metacognitionRerunDelayMinutes = normalizeMetacognitionRerunDelayMinutesValue(
    merged.metacognitionRerunDelayMinutes
  );
  normalizeMindConstitutionUserModelFields(merged);
  setKvSync(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

/** Strip secrets before persisting runtime_settings to SQLite / pipeline rows. */
export function runtimeSettingsForPersistence(rt) {
  const o = rt && typeof rt === 'object' ? { ...rt } : {};
  delete o.openrouterApiKey;
  return o;
}

/** Resolved max supervisor reruns before Voice for pipeline POST options (0–20). */
export function resolveMaxMetacognitionReruns(rt) {
  const source = rt && typeof rt === 'object' ? rt : getRuntimeSettings();
  const n = Number(source.maxMetacognitionReruns);
  if (!Number.isFinite(n)) return DEFAULT_RUNTIME_SETTINGS.maxMetacognitionReruns;
  return Math.min(20, Math.max(0, Math.floor(n)));
}

/** 0 = immediate continuation POSTs; non-zero defers via IndexedDB ScheduledTask for at least 2 minutes. */
export function resolveMetacognitionRerunDelayMinutes(rt) {
  const source = rt && typeof rt === 'object' ? rt : getRuntimeSettings();
  return normalizeMetacognitionRerunDelayMinutesValue(source.metacognitionRerunDelayMinutes);
}

/**
 * Per-run override for pipeline POST options: `undefined`/`null` uses global runtime settings.
 * @param {object} [rt] - runtime settings object (defaults to getRuntimeSettings())
 * @param {unknown} override - optional max reruns (0–20)
 */
export function effectiveMaxMetacognitionReruns(rt, override) {
  const source = rt && typeof rt === 'object' ? rt : getRuntimeSettings();
  if (override == null || override === '') return resolveMaxMetacognitionReruns(source);
  const n = Number(override);
  if (!Number.isFinite(n)) return resolveMaxMetacognitionReruns(source);
  return Math.min(20, Math.max(0, Math.floor(n)));
}

/**
 * Per-run override for deferred supervisor rerun delay: `undefined`/`null` uses global runtime settings.
 * @param {object} [rt]
 * @param {unknown} override - minutes (same rules as {@link normalizeMetacognitionRerunDelayMinutesValue})
 */
export function effectiveMetacognitionRerunDelayMinutes(rt, override) {
  const source = rt && typeof rt === 'object' ? rt : getRuntimeSettings();
  if (override == null || override === '') return resolveMetacognitionRerunDelayMinutes(source);
  return normalizeMetacognitionRerunDelayMinutesValue(override);
}

/**
 * Delay minutes for a continuation leg: prefer snapshot from the originating run, else global runtime.
 * @param {object|null|undefined} snapshot - `metacognition_rerun_pipeline_options` or pipeline options snapshot
 * @param {object} [rt]
 */
export function resolveMetacognitionRerunDelayMinutesFromSnapshot(snapshot, rt) {
  const rtSettings = rt && typeof rt === 'object' ? rt : getRuntimeSettings();
  if (snapshot && typeof snapshot === 'object') {
    const raw = snapshot.metacognitionRerunDelayMinutes;
    if (raw != null && raw !== '' && Number.isFinite(Number(raw))) {
      return normalizeMetacognitionRerunDelayMinutesValue(raw);
    }
  }
  return resolveMetacognitionRerunDelayMinutes(rtSettings);
}
