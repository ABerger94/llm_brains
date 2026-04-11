/**
 * Rule-based extraction of identity-related fields from pipeline Narrative and Identity module output.
 * Used to populate MindBiography.identity_keywords / core_values without an extra LLM call.
 */

const SECTION_HEADINGS = ['FULL NARRATIVE', 'IDENTITY', 'CORE VALUES', 'WHAT CHANGED'];

/** Line looks like a markdown or all-caps section title */
function isSectionHeadingLine(line) {
  const t = String(line || '').trim();
  if (!t) return false;
  if (/^#{1,3}\s+\S/.test(t)) return true;
  const bare = t.replace(/^#+\s*/, '').trim().toUpperCase();
  return SECTION_HEADINGS.some((h) => bare === h || bare.startsWith(`${h}:`));
}

function headingKeyFromLine(line) {
  const t = String(line || '').trim().replace(/^#+\s*/, '').trim();
  const upper = t.toUpperCase();
  for (const h of SECTION_HEADINGS) {
    if (upper === h || upper.startsWith(`${h}:`)) return h;
  }
  return null;
}

/**
 * Parse narrative text for labeled sections (FULL NARRATIVE, IDENTITY, CORE VALUES, WHAT CHANGED).
 * @param {string} narrativeText
 * @returns {{ fullNarrative: string, identity: string, coreValues: string, whatChanged: string }}
 */
export function extractNarrativeSections(narrativeText) {
  const raw = String(narrativeText || '');
  const lines = raw.split(/\r?\n/);
  const out = {
    fullNarrative: '',
    identity: '',
    coreValues: '',
    whatChanged: '',
  };
  let current = null;
  const buf = [];

  const flush = () => {
    if (!current) return;
    const text = buf.join('\n').trim();
    if (current === 'FULL NARRATIVE') out.fullNarrative = text;
    else if (current === 'IDENTITY') out.identity = text;
    else if (current === 'CORE VALUES') out.coreValues = text;
    else if (current === 'WHAT CHANGED') out.whatChanged = text;
    buf.length = 0;
  };

  for (const line of lines) {
    const key = headingKeyFromLine(line);
    if (key && isSectionHeadingLine(line)) {
      flush();
      current = key;
      continue;
    }
    if (current) buf.push(line);
  }
  flush();

  // Fallback: single block with "IDENTITY" inline (rare)
  if (!out.identity && !out.coreValues && raw.length > 0) {
    const m = raw.match(/\bIDENTITY\s*[:\n]\s*([\s\S]{3,2000}?)(?=\n(?:CORE VALUES|WHAT CHANGED|FULL NARRATIVE)\b|$)/i);
    if (m) out.identity = m[1].trim();
  }

  return out;
}

/** Split glued CamelCaseWords into tokens for keyword harvesting */
function splitCamelBoundaries(s) {
  return String(s || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

/**
 * Tokenize Identity module output into short keyword phrases (lowercase).
 * @param {string} identityText
 * @param {number} [maxItems]
 * @returns {string[]}
 */
export function deriveKeywordsFromIdentityModule(identityText, maxItems = 20) {
  const expanded = splitCamelBoundaries(String(identityText || ''));
  const parts = expanded
    .split(/[\n\r•\-–—*]+|,|;/g)
    .flatMap((p) => p.split(/\s{2,}/g))
    .map((s) => s.replace(/^[\s\-–—*.]+|[\s\-–—*.]+$/g, '').trim())
    .filter((s) => s.length >= 3 && s.length <= 80);

  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Parse CORE VALUES body into list items (lines or comma-separated).
 * @param {string} body
 * @param {number} [maxItems]
 * @returns {string[]}
 */
export function deriveCoreValuesFromSection(body, maxItems = 12) {
  const text = splitCamelBoundaries(String(body || '')).trim();
  if (!text) return [];
  const lines = text.split(/[\n\r]+/).map((l) => l.replace(/^[\s\-–—*.•\d.)]+/i, '').trim()).filter(Boolean);
  const fromLines = lines.length > 1 ? lines : text.split(/[,;|]/g).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const v of fromLines) {
    const k = v.toLowerCase();
    if (k.length < 2 || k.length > 64) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Merge previous string array with incoming; dedupe case-insensitively; cap length.
 * @param {unknown} prev
 * @param {string[]} incoming
 * @param {number} cap
 * @returns {string[]}
 */
export function mergeDedupedStrings(prev, incoming, cap = 20) {
  const prevArr = Array.isArray(prev) ? prev : [];
  const seen = new Set();
  const out = [];
  for (const x of [...prevArr, ...incoming]) {
    const s = String(x || '').trim().toLowerCase();
    if (s.length < 2) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * @param {{ identityModuleText?: string, narrativeText?: string, dmnText?: string }} opts
 * @returns {{ identity_keywords: string[], core_values: string[], notable_delta_line: string }}
 */
export function derivePipelineBiographyIdentityFields({
  identityModuleText,
  narrativeText,
  dmnText,
} = {}) {
  const sections = extractNarrativeSections(narrativeText);
  const fromIdentityMod = deriveKeywordsFromIdentityModule(identityModuleText, 16);
  const fromNarrId = sections.identity ? deriveKeywordsFromIdentityModule(sections.identity, 12) : [];
  const fromDmn = dmnText ? deriveKeywordsFromIdentityModule(dmnText, 10) : [];
  const identity_keywords = mergeDedupedStrings([], [...fromIdentityMod, ...fromNarrId, ...fromDmn], 20);

  const fromCoreSection = deriveCoreValuesFromSection(sections.coreValues, 12);
  const core_values = mergeDedupedStrings([], fromCoreSection, 12);

  let notable_delta_line = '';
  if (sections.whatChanged.trim()) {
    notable_delta_line = sections.whatChanged.replace(/\s+/g, ' ').trim().slice(0, 400);
  }

  return { identity_keywords, core_values, notable_delta_line };
}

/** Max length for stored source quotes (emergence / identity evidence). IndexedDB-backed; keep high enough for full module excerpts. */
export const EVIDENCE_QUOTE_MAX = 12000;

/**
 * @typedef {{ marker: string, source: string, quote: string }} EmergenceEvidenceItem
 */

function clipEvidenceQuote(s, maxLen = EVIDENCE_QUOTE_MAX) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
}

/**
 * Split prose into sentence-like units (punctuation or line breaks when no .?!).
 * @param {string} text
 * @returns {string[]}
 */
function splitIntoSentences(text) {
  const t = String(text || '');
  if (!t.trim()) return [];
  const rough = t
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (rough.length > 1 || /[.!?]/.test(t)) return rough;
  return t
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * First full sentence (or line) that contains the needle, preserving original wording.
 * @param {string} text
 * @param {string} needle
 */
function sentenceContainingNeedle(text, needle) {
  const n = String(needle || '').trim().toLowerCase();
  if (!n) return '';
  const sentences = splitIntoSentences(String(text || ''));
  for (const s of sentences) {
    if (s.toLowerCase().includes(n)) return s;
  }
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (line.toLowerCase().includes(n)) return line;
  }
  return '';
}

/**
 * Last resort: bounded slice around match without rewriting internal whitespace.
 * @param {string} text
 * @param {string} needle
 */
function boundedSliceAroundNeedle(text, needle, radius = 1200) {
  const t = String(text || '');
  const low = t.toLowerCase();
  const n = String(needle || '').toLowerCase();
  const idx = low.indexOf(n);
  if (idx === -1) return '';
  const a = Math.max(0, idx - radius);
  const b = Math.min(t.length, idx + n.length + radius);
  let slice = t.slice(a, b).trim();
  if (a > 0) slice = `…${slice}`;
  if (b < t.length) slice = `${slice}…`;
  return clipEvidenceQuote(slice);
}

/**
 * Verbatim excerpt for a needle: prefer one complete sentence/line, then bounded slice.
 * @param {string} text
 * @param {string} needle
 */
function exactQuoteForNeedle(text, needle) {
  const bySentence = sentenceContainingNeedle(text, needle);
  if (bySentence) return clipEvidenceQuote(bySentence);
  return boundedSliceAroundNeedle(text, needle);
}

/**
 * Leading complete sentences from text within maxLen (for section excerpts).
 * @param {string} text
 * @param {number} maxLen
 */
function leadingSentencesWithin(text, maxLen = EVIDENCE_QUOTE_MAX) {
  const sentences = splitIntoSentences(String(text || ''));
  if (!sentences.length) return '';
  const out = [];
  let len = 0;
  for (const s of sentences) {
    const sep = out.length ? 1 : 0;
    if (len + sep + s.length <= maxLen) {
      out.push(s);
      len += sep + s.length;
      continue;
    }
    if (out.length === 0) {
      return s.length <= maxLen ? s : `${s.slice(0, Math.max(1, maxLen - 1))}…`;
    }
    break;
  }
  return out.join(' ');
}

/**
 * First physical lines of module-style text up to maxLen (preserves newlines for Identity/DMN output).
 * @param {string} text
 * @param {number} maxLen
 */
function leadingLinesWithin(text, maxLen = EVIDENCE_QUOTE_MAX) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  const out = [];
  let len = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sep = out.length ? 1 : 0;
    const add = sep + line.length;
    if (len + add > maxLen && out.length > 0) break;
    if (len + add > maxLen && out.length === 0) {
      return line.length <= maxLen ? line : `${line.slice(0, Math.max(1, maxLen - 1))}…`;
    }
    out.push(line);
    len += add;
  }
  return out.join('\n');
}

/**
 * @param {Array<[string, string]>} sources [label, text]
 * @param {string} needle
 */
function firstSourceQuote(sources, needle) {
  for (const [source, txt] of sources) {
    const q = exactQuoteForNeedle(txt, needle);
    if (q) return { source, quote: q };
  }
  return null;
}

/**
 * @param {EmergenceEvidenceItem[]} list
 * @param {Set<string>} seen
 */
function pushEvidence(list, seen, marker, source, quote) {
  const q = clipEvidenceQuote(quote);
  if (!q) return;
  const key = `${marker}::${source}::${q}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push({ marker, source, quote: q });
}

/**
 * Heuristic emergence markers with verbatim quotes from the triggering source.
 * @param {{ voiceText?: string, narrativeText?: string, identityText?: string, dmnText?: string }} opts
 * @returns {{ markers: string[], evidence_items: EmergenceEvidenceItem[] }}
 */
export function collectPipelineEmergenceMarkers({
  voiceText,
  narrativeText,
  identityText,
  dmnText,
} = {}) {
  const voice = String(voiceText || '');
  const nar = String(narrativeText || '');
  const id = String(identityText || '');
  const dmn = String(dmnText || '');
  const sources = [
    ['Voice', voice],
    ['Narrative', nar],
    ['Identity module', id],
    ['DMN carryover', dmn],
  ];
  const combined = `${voice}\n${nar}\n${id}\n${dmn}`.toLowerCase();
  /** @type {EmergenceEvidenceItem[]} */
  const evidence_items = [];
  const seen = new Set();

  /** @type {string[]} */
  const markers = [];

  const needleMarkers = [
    ['i want', 'goal formation'],
    ['i believe', 'belief articulation'],
    ['i used to', 'temporal self-comparison'],
    ['conflict', 'self-conflict detection'],
  ];
  for (const [needle, label] of needleMarkers) {
    if (combined.includes(needle)) {
      markers.push(label);
      const hit = firstSourceQuote(sources, needle);
      if (hit) pushEvidence(evidence_items, seen, label, hit.source, hit.quote);
    }
  }

  const sections = extractNarrativeSections(nar);
  if (sections.fullNarrative.trim()) {
    markers.push('narrative: full narrative section');
    pushEvidence(
      evidence_items,
      seen,
      'narrative: full narrative section',
      'Narrative (FULL NARRATIVE)',
      leadingSentencesWithin(sections.fullNarrative)
    );
  }
  if (sections.identity.trim()) {
    markers.push('narrative: identity section');
    pushEvidence(
      evidence_items,
      seen,
      'narrative: identity section',
      'Narrative (IDENTITY section)',
      leadingSentencesWithin(sections.identity)
    );
  }
  if (sections.coreValues.trim()) {
    markers.push('narrative: core values section');
    pushEvidence(
      evidence_items,
      seen,
      'narrative: core values section',
      'Narrative (CORE VALUES section)',
      leadingSentencesWithin(sections.coreValues)
    );
  }
  if (sections.whatChanged.trim()) {
    markers.push('narrative: what changed section');
    pushEvidence(
      evidence_items,
      seen,
      'narrative: what changed section',
      'Narrative (WHAT CHANGED section)',
      leadingSentencesWithin(sections.whatChanged)
    );
  }
  if (id.trim().length >= 120) {
    markers.push('identity module (substantive)');
    pushEvidence(
      evidence_items,
      seen,
      'identity module (substantive)',
      'Identity module',
      leadingLinesWithin(id)
    );
  }
  if (dmn.trim().length >= 120) {
    markers.push('dmn carryover (substantive)');
    pushEvidence(
      evidence_items,
      seen,
      'dmn carryover (substantive)',
      'DMN carryover',
      leadingLinesWithin(dmn)
    );
  }

  for (const p of ['self-concept', 'emergent self', 'sense of identity', 'functional identity']) {
    if (combined.includes(p)) {
      const label = `phrase: ${p}`;
      markers.push(label);
      let hit = firstSourceQuote(sources, p);
      if (!hit) {
        for (const [source, txt] of sources) {
          if (!txt || !String(txt).toLowerCase().includes(p)) continue;
          const q = boundedSliceAroundNeedle(txt, p);
          if (q) {
            hit = { source, quote: q };
            break;
          }
        }
      }
      if (hit) pushEvidence(evidence_items, seen, label, hit.source, hit.quote);
    }
  }

  return { markers, evidence_items };
}
