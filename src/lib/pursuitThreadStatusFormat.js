import { formatPipelineDashboardStatusLine } from './activePipelineStatusLabels';

/**
 * Matches Curiosity / Goals pipeline panel: Quick reflect lines stay as-is; deep graph pursuits get a "Deep pursue:" prefix.
 * @param {string | null | undefined} pursuitProgress
 * @returns {string}
 */
export function formatPursuitThreadProgressLine(pursuitProgress) {
  const p = String(pursuitProgress || '').trim();
  if (!p) return '';
  if (p.startsWith('Quick reflect')) return p;
  return `Deep pursue: ${p}`;
}

/**
 * Curiosity / goal active rows: first line = current module, second = pursuit progress (Run x/y, Starting…, etc.).
 * @param {{ moduleName?: string | null, pursuitProgressRaw?: string | null, idleFallback?: string }} opts
 * @returns {string}
 */
export function formatPursuitPipelineStatusDetailLines({
  moduleName,
  pursuitProgressRaw,
  idleFallback = '',
} = {}) {
  const mod = String(moduleName || '').trim();
  const pursuitLine = formatPursuitThreadProgressLine(pursuitProgressRaw);
  const moduleLine = mod ? `Module: ${mod}` : '';
  if (moduleLine && pursuitLine) return `${moduleLine}\n${pursuitLine}`;
  if (moduleLine) return moduleLine;
  if (pursuitLine) return pursuitLine;
  return String(idleFallback ?? '').trim();
}

/**
 * Same as {@link formatPursuitPipelineStatusDetailLines} but with a leading interrupted banner line.
 */
export function formatPursuitPipelineStatusDetailWithInterrupted({
  moduleName,
  pursuitProgressRaw,
  interruptedLead,
} = {}) {
  const body = formatPursuitPipelineStatusDetailLines({
    moduleName,
    pursuitProgressRaw,
    idleFallback: '',
  });
  if (!body.trim()) return interruptedLead;
  return `${interruptedLead}\n${body}`;
}

/**
 * Primary status line for active graph / scheduler pipeline cards (mirrors {@link formatPursuitThreadProgressLine} shape).
 * @param {{ uploading?: boolean, moduleName?: string | null, isActive?: boolean }} opts
 * @returns {string}
 */
export function formatGraphRunProgressLine(opts) {
  return formatPipelineDashboardStatusLine(opts);
}

/**
 * @param {string} lead Primary line (e.g. Deep pursue / Module).
 * @param {string[]} tailFragments Secondary fragments joined with " · ".
 * @param {string} whenEmpty
 * @returns {string} One or two lines (newline between lead and tail).
 */
export function formatActivePipelineDetail(lead, tailFragments, whenEmpty) {
  const l = String(lead || '').trim();
  const tail = (Array.isArray(tailFragments) ? tailFragments : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' · ');
  if (l && tail) return `${l}\n${tail}`;
  if (l) return l;
  if (tail) return tail;
  return whenEmpty;
}
