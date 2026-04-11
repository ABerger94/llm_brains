/**
 * Canonical world-model shape (aligned with app schema: key, category, label, value, history, …).
 * Maps legacy categories from extract/consolidation/schedulers into the enum:
 * self | environment | relationship | goal | belief | event
 */

export const WORLD_MODEL_CATEGORY_ORDER = [
  'self',
  'environment',
  'relationship',
  'goal',
  'belief',
  'event',
];

/** UI copy per category */
export const WORLD_MODEL_CATEGORY_META = {
  self: {
    label: 'Self (structural)',
    blurb:
      'Slow-updating constraints: capabilities, boundaries, values, non-goals. Distinct from narrative self (ledger / biography).',
  },
  environment: {
    label: 'Environment',
    blurb: 'Context the mind operates in: tools, session setting, external facts it treats as stable.',
  },
  relationship: {
    label: 'Relationship',
    blurb: 'How it models ongoing rapport with the user or other parties.',
  },
  goal: {
    label: 'Goal',
    blurb: 'Active or standing objectives inferred from runs, memory, or consolidation.',
  },
  belief: {
    label: 'Belief',
    blurb: 'Held propositions (including constraints and norms) with confidence.',
  },
  event: {
    label: 'Event',
    blurb: 'Notable happenings or milestones worth tracking over time.',
  },
};

const LEGACY_TO_CANON = {
  self: 'self',
  environment: 'environment',
  relationship: 'relationship',
  relationships: 'relationship',
  goal: 'goal',
  goals: 'goal',
  belief: 'belief',
  beliefs: 'belief',
  event: 'event',
  events: 'event',
  significant_events: 'event',
  significant_event: 'event',
  constraints: 'belief',
  constraint: 'belief',
  capabilities: 'self',
  capability: 'self',
};

/** Internal sentinel from older server builds when Integration JSON could not be parsed. */
export const LEGACY_INTEGRATION_UNITY_SENTINEL = 'server_fallback_unparseable_integration_json';

/** Map legacy/internal unity rationale strings to text safe for Self / World Model UI. */
export function humanizeUnityRationaleForDisplay(raw) {
  const s = String(raw || '').trim();
  if (s === LEGACY_INTEGRATION_UNITY_SENTINEL) {
    return 'Integration did not emit parseable INTEGRATION_JSON (formatting, truncation, or model error). The server reconstructed a minimal workspace from Integration prose and earlier modules and set phenomenal unity to partial.';
  }
  return s;
}

export function normalizeWorldModelCategory(raw) {
  const k = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (LEGACY_TO_CANON[k]) return LEGACY_TO_CANON[k];
  const nos = k.replace(/s$/, '');
  if (LEGACY_TO_CANON[nos]) return LEGACY_TO_CANON[nos];
  return WORLD_MODEL_CATEGORY_ORDER.includes(k) ? k : 'belief';
}

export function displayWorldModelLabel(item) {
  return String(item?.label || item?.name || '').trim() || '(untitled)';
}

export function stableWorldModelKey(category, label) {
  const c = normalizeWorldModelCategory(category);
  const l = displayWorldModelLabel({ label, name: label }).toLowerCase().slice(0, 120);
  return `${c}::${l}`.slice(0, 160);
}

export function itemKeyForRecord(rec) {
  if (rec?.key && String(rec.key).trim()) return String(rec.key).trim();
  return stableWorldModelKey(rec?.category, displayWorldModelLabel(rec));
}

export function newWorldModelHistoryEntry({
  source,
  value,
  description,
  confidence,
  evidence,
  note,
} = {}) {
  const entry = {
    at: new Date().toISOString(),
    source: source != null && String(source).trim() ? String(source).trim() : 'unknown',
  };
  if (value != null && String(value).trim()) entry.value = String(value).trim();
  if (description != null && String(description).trim()) entry.description = String(description).trim();
  if (typeof confidence === 'number' && Number.isFinite(confidence)) entry.confidence = confidence;
  if (evidence != null && String(evidence).trim()) entry.evidence = String(evidence).trim();
  if (note != null && String(note).trim()) entry.note = String(note).trim();
  return entry;
}

export function appendWorldModelHistory(existingHistory, entry) {
  const prev = Array.isArray(existingHistory) ? existingHistory : [];
  return [...prev, entry];
}

/** Build create payload with dual name/label for older code paths. */
export function buildWorldModelCreatePayload({
  category,
  label,
  description,
  value,
  confidence,
  last_updated_by,
  evidence,
  history,
  extra = {},
}) {
  const cat = normalizeWorldModelCategory(category);
  const lab = String(label || '').trim();
  const key = stableWorldModelKey(cat, lab);
  const hist = Array.isArray(history) && history.length ? history : [newWorldModelHistoryEntry({
      source: last_updated_by || 'manual',
      description,
      value,
      confidence,
      evidence,
      note: 'Initial version',
    })];
  return {
    key,
    category: cat,
    label: lab,
    name: lab,
    description: String(description || '').trim(),
    value: value != null && String(value).trim() ? String(value).trim() : undefined,
    confidence: typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 0.8,
    last_updated_by: last_updated_by != null ? String(last_updated_by).trim() : 'manual',
    evidence: evidence != null && String(evidence).trim() ? String(evidence).trim() : undefined,
    history: hist,
    ...extra,
  };
}

export function buildWorldModelUpdatePayload(existing, nextFields, historySource, historyNote) {
  const nextDesc =
    nextFields.description != null ? String(nextFields.description).trim() : String(existing.description || '');
  const nextConf =
    typeof nextFields.confidence === 'number' ? nextFields.confidence : existing.confidence;
  const nextVal =
    nextFields.value != null ? String(nextFields.value).trim() : String(existing.value || '');
  const nextEv =
    nextFields.evidence != null ? String(nextFields.evidence).trim() : String(existing.evidence || '');

  const prevDesc = String(existing.description || '');
  const prevConf = existing.confidence;
  const prevVal = String(existing.value || '');
  const prevEv = String(existing.evidence || '');

  const changed =
    nextDesc !== prevDesc ||
    nextConf !== prevConf ||
    nextVal !== prevVal ||
    nextEv !== prevEv;

  const metaChanged =
    (nextFields.label != null &&
      String(nextFields.label).trim() !== displayWorldModelLabel(existing)) ||
    (nextFields.category != null &&
      normalizeWorldModelCategory(nextFields.category) !== normalizeWorldModelCategory(existing.category)) ||
    (nextFields.key != null &&
      String(nextFields.key).trim() !== String(existing.key || itemKeyForRecord(existing)).trim());

  const out = {};
  if (nextFields.category != null) out.category = normalizeWorldModelCategory(nextFields.category);
  if (nextFields.label != null) {
    const lab = String(nextFields.label).trim();
    out.label = lab;
    out.name = lab;
  }
  if (nextFields.key != null && String(nextFields.key).trim()) out.key = String(nextFields.key).trim();
  if (nextFields.description != null) out.description = nextDesc;
  if (typeof nextFields.confidence === 'number') out.confidence = nextConf;
  if (nextFields.value !== undefined) out.value = nextVal || undefined;
  if (nextFields.evidence !== undefined) out.evidence = nextEv || undefined;
  if (nextFields.last_updated_by != null) out.last_updated_by = String(nextFields.last_updated_by).trim();

  if (changed || metaChanged) {
    const entry = newWorldModelHistoryEntry({
      source: historySource || out.last_updated_by || 'update',
      description: nextDesc,
      value: nextVal || undefined,
      confidence: typeof nextConf === 'number' ? nextConf : undefined,
      evidence: nextEv || undefined,
      note:
        historyNote ||
        (metaChanged && !changed ? 'Label or category normalized' : 'State updated'),
    });
    out.history = appendWorldModelHistory(existing.history, entry);
  }

  return out;
}
