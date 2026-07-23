/**
 * Parse Belief Store module dumps (BELIEF_UPDATE_REPORT, numbered Reasoning lines, BELIEF: | …)
 * into atomic { statement, confidence, reasoning?, category? } for storage and display.
 */

import { normalizeBeliefMapCategory } from '../../shared/beliefMapCategory.mjs';
import { clipTextComplete } from '../../shared/textClip.mjs';

const PIPELINE_DIGEST_PREFIX = '[Pipeline belief digest] ';
const EPISTEMIC_CLAIM_PREFIX = '[Epistemic claim] ';

const JUNK_CUT_RE = [
  /\bBELIEF_REVISIONS\s*:/i,
  /\bWEB_REQUEST\s*:/i,
  /\{\s*"revisions"\s*:/,
];

const JUNK_STATEMENT_RE = /^\*{0,3}\s*(belief\s*store\s*update|updated?\s*beliefs?|new\s*beliefs?|belief\s*summary|belief\s*revision|section\s*\d+|summary|overview)\s*\*{0,3}$/i;

/**
 * True when `s` is a section header / markdown decoration rather than an actual belief.
 * Strips markdown bold/italic/heading markers before testing.
 */
export function isJunkBeliefStatement(s) {
  const t = String(s || '')
    .replace(/^#+\s*/, '')
    .replace(/\*+/g, '')
    .replace(/^[-–—•]\s*/, '')
    .trim();
  if (!t || t.length < 8) return true;
  if (JUNK_STATEMENT_RE.test(t)) return true;
  if (/^belief\s*store\b/i.test(t) && t.length < 40) return true;
  return false;
}

const SECTION_HEADER_RE =
  /(Confirmed beliefs|Revised beliefs|New beliefs formed|Challenged beliefs)(\s*\(([^)]*)\))?\s*:/gi;

const NUMBERED_REASONING_RE = /(\d+)\.\s*(.+?)\s*\(\s*Reasoning:\s*([^)]+)\)/gi;

/** Legacy: CONFIDENCE without MAP (no category). */
const PIPE_BELIEF_RE =
  /BELIEF\s*:\s*([^|]+)\|\s*CONFIDENCE\s*:\s*([\d.]+)(?:\s*\|\s*REASONING\s*:\s*([^|]+))?/gi;

function truncateBeliefReportJunk(s) {
  let out = String(s || '');
  for (const re of JUNK_CUT_RE) {
    const m = out.match(re);
    if (m && m.index != null) out = out.slice(0, m.index);
  }
  return out.trim();
}

function defaultConfFromSectionParen(inner) {
  if (inner == null || inner === '') return null;
  const m = String(inner).match(/confidence\s*([\d.]+)/i);
  if (m) return Math.min(1, Math.max(0, parseFloat(m[1])));
  return null;
}

function confidenceFromReasoningBlob(blob, sectionDefault) {
  const cInline = String(blob).match(/confidence\s*([\d.]+)/i);
  if (cInline) return Math.min(1, Math.max(0.05, parseFloat(cInline[1])));
  const sd = sectionDefault != null && Number.isFinite(sectionDefault) ? sectionDefault : 0.75;
  return Math.min(1, Math.max(0.05, sd));
}

function reasoningWithoutInlineConfidence(blob) {
  return String(blob)
    .replace(/,\s*confidence\s*[\d.]+\s*$/i, '')
    .replace(/\s*confidence\s*[\d.]+\s*$/i, '')
    .trim();
}

function stripStoragePrefixes(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith(PIPELINE_DIGEST_PREFIX)) {
    s = s.slice(PIPELINE_DIGEST_PREFIX.length).trim();
  } else if (s.startsWith(EPISTEMIC_CLAIM_PREFIX)) {
    s = s.slice(EPISTEMIC_CLAIM_PREFIX.length).trim();
    const kindMatch = s.match(/^\[([^\]]+)\]\s*/);
    if (kindMatch) s = s.slice(kindMatch[0].length).trim();
  }
  return s;
}

function splitReportSections(body) {
  const matches = [...body.matchAll(new RegExp(SECTION_HEADER_RE.source, 'gi'))];
  if (matches.length === 0) return null;

  const sections = [];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    const name = String(matches[i][1] || '').toLowerCase();
    const innerParen = matches[i][3];
    const chunk = body.slice(start, end).trim();
    if (name.includes('challenged') && /^none\b/i.test(chunk)) continue;

    const sectionConf = defaultConfFromSectionParen(innerParen);
    sections.push({
      defaultConf: sectionConf,
      chunk,
    });
  }
  return sections.length ? sections : null;
}

function parseNumberedItems(text, sectionDefault) {
  const items = [];
  const re = new RegExp(NUMBERED_REASONING_RE.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const statement = String(m[2] || '').trim();
    const reasonBlob = String(m[3] || '').trim();
    if (statement.length < 3) continue;
    const confidence = confidenceFromReasoningBlob(reasonBlob, sectionDefault);
    const reasoning = reasoningWithoutInlineConfidence(reasonBlob);
    items.push({ statement, confidence, reasoning: reasoning || undefined });
  }
  return items;
}

/**
 * One BELIEF: line with pipe-separated KEY: value segments after the statement.
 * @returns {{ statement: string, confidence: number, reasoning?: string, category?: string } | null}
 */
function parseBeliefPipeLine(line) {
  const m = line.match(/^\s*BELIEF\s*:\s*(.+)$/i);
  if (!m) return null;
  const rest = m[1].trim();
  const parts = rest.split('|').map((p) => p.trim());
  if (parts.length === 0) return null;
  const statement = parts[0];
  if (statement.length < 3) return null;
  /** @type {Record<string, string>} */
  const fields = {};
  for (let i = 1; i < parts.length; i += 1) {
    const seg = parts[i];
    const kv = seg.match(/^([A-Za-z_]+)\s*:\s*(.*)$/s);
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim();
  }
  const conf = parseFloat(fields.confidence);
  const confidence = Number.isFinite(conf) ? Math.min(1, Math.max(0.05, conf)) : 0.75;
  const mapCanon = normalizeBeliefMapCategory(fields.map);
  const reasoning = fields.reasoning || fields.note || undefined;
  const out = { statement, confidence, ...(reasoning ? { reasoning } : {}) };
  if (mapCanon) out.category = mapCanon;
  return out;
}

function parsePipeFormat(text) {
  const items = [];
  const lines = String(text).split(/\r?\n/);
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;
    line = line.replace(/^[-*•\d.)]+\s*/, '').trim();
    const parsed = parseBeliefPipeLine(line);
    if (parsed) items.push(parsed);
  }
  if (items.length) return items;

  const re = new RegExp(PIPE_BELIEF_RE.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const statement = String(m[1] || '').trim();
    const conf = parseFloat(m[2]);
    const reasoning = m[3] ? String(m[3]).trim() : undefined;
    if (statement.length < 3) continue;
    items.push({
      statement,
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0.05, conf)) : 0.75,
      reasoning,
    });
  }
  return items;
}

/**
 * @param {string} raw
 * @returns {Array<{ statement: string, confidence: number, reasoning?: string, category?: string }>}
 */
export function parseBeliefModuleOutput(raw) {
  const stripped = stripStoragePrefixes(raw);
  let body = truncateBeliefReportJunk(stripped);
  body = body.replace(/^\s*BELIEF_UPDATE_REPORT\s*:\s*/i, '').trim();
  if (!body || body.length < 8) return [];

  const sections = splitReportSections(body);
  if (sections) {
    const out = [];
    for (const { defaultConf, chunk } of sections) {
      if (chunk.length < 6) continue;
      out.push(...parseNumberedItems(chunk, defaultConf));
    }
    if (out.length) return out;
  }

  const pipeItems = parsePipeFormat(body);
  if (pipeItems.length) return pipeItems;

  const loose = parseNumberedItems(body, 0.75);
  return loose;
}

/**
 * True when text looks like a belief *module report* but did not yield parseable atomic claims.
 * Used to drop monolithic blobs from BeliefStore.
 */
export function isUnparsedBeliefModuleReport(raw) {
  if (parseBeliefModuleOutput(raw).length > 0) return false;
  const s = String(raw || '');
  if (/\bBELIEF_UPDATE_REPORT\b/i.test(s)) return true;
  if (/\bBELIEF_REVISIONS\b/i.test(s)) return true;
  if (s.startsWith(PIPELINE_DIGEST_PREFIX) && s.length > 80) return true;
  return false;
}

/**
 * Human-facing sentences for UI (handles legacy one-blob rows).
 * @returns {string[]}
 */
export function beliefStatementsForDisplay(raw) {
  const fromParse = parseBeliefModuleOutput(raw);
  if (fromParse.length > 0) {
    return fromParse.map((p) => p.statement.trim()).filter(Boolean);
  }
  const stripped = stripStoragePrefixes(String(raw || ''));
  const body = truncateBeliefReportJunk(stripped).replace(/^\s*BELIEF_UPDATE_REPORT\s*:\s*/i, '').trim();
  const loose = parseNumberedItems(body, 0.75);
  if (loose.length > 0) {
    return loose.map((p) => p.statement.trim()).filter(Boolean);
  }
  const fallback = body.replace(/\s+/g, ' ').trim();
  return fallback ? [fallback] : [];
}

/** @deprecated Prefer beliefStatementsForDisplay; single flattened string for tiny labels */
export function beliefStatementAsPlainText(raw) {
  const parts = beliefStatementsForDisplay(raw);
  if (!parts.length) return '';
  return parts.join(' · ');
}

/**
 * Primary line for belief lists and map labels: structured text when possible, otherwise a clipped raw fallback
 * (mirror / legacy blobs often omit parseable BELIEF: lines but still have readable prose).
 */
export function beliefListPrimaryLine(raw) {
  const plain = beliefStatementAsPlainText(raw);
  if (plain && plain.trim()) return plain.trim();
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return clipTextComplete(s, 2000, { ellipsis: true });
}
