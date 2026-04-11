import {
  backendModuleNameToUiId,
  COGNITIVE_MODULES_PIPELINE_ORDER,
  parseModuleCompleteExecutionLogLine,
} from '../../lib/cognitiveModules';

/** Threshold above which detail is collapsed behind a disclosure (readable scan of the timeline). */
const DETAIL_COLLAPSE_CHARS = 480;

/**
 * Prefer full text from live `moduleOutputs` when the log line's `detail` was truncated or evicted from persist.
 * @param {{ msg: string, detail?: string }} line
 * @param {Record<string, string> | undefined} moduleOutputs
 */
function effectiveDetailForLogLine(line, moduleOutputs) {
  const d = line.detail != null && String(line.detail).trim() ? String(line.detail) : '';
  const mo = moduleOutputs && typeof moduleOutputs === 'object' ? moduleOutputs : null;
  if (!mo || Object.keys(mo).length === 0) return d;
  const backendName = parseModuleCompleteExecutionLogLine(line.msg);
  if (!backendName) return d;
  const uiId = backendModuleNameToUiId(backendName);
  if (!uiId) return d;
  const full = mo[uiId];
  if (typeof full !== 'string' || !full.trim()) return d;
  if (!d || full.length > d.length) return full;
  return d;
}

/**
 * Module completions still in `moduleOutputs` but with no matching `✓ … complete` line (usually rolled off the persisted tail).
 * @param {Array<{ msg: string, detail?: string }>} entries
 * @param {Record<string, string> | undefined} moduleOutputs
 * @returns {Array<{ msg: string, detail: string, modId: string }>}
 */
function syntheticRolledOffCompletionEntries(entries, moduleOutputs) {
  const seen = new Set();
  for (const e of entries) {
    const n = parseModuleCompleteExecutionLogLine(e.msg);
    if (n) seen.add(n);
  }
  const out = [];
  for (const mod of COGNITIVE_MODULES_PIPELINE_ORDER) {
    const text = moduleOutputs?.[mod.id];
    if (typeof text !== 'string' || !text.trim()) continue;
    if (seen.has(mod.name)) continue;
    out.push({ msg: `✓ ${mod.name} complete`, detail: text, modId: mod.id });
  }
  return out;
}

/**
 * Renders pipeline execution.log lines with room for long module bodies.
 * @param {{
 *   entries: Array<{ time?: number, msg: string, detail?: string }>,
 *   lineKeyPrefix?: string,
 *   moduleOutputs?: Record<string, string>,
 * }} props
 */
export default function PipelineExecutionLogEntries({ entries, lineKeyPrefix = 'log', moduleOutputs }) {
  const list = Array.isArray(entries) ? entries : [];
  const rolledOff = syntheticRolledOffCompletionEntries(list, moduleOutputs);

  const renderRow = (line, i, keyExtra) => {
    const detail = effectiveDetailForLogLine(line, moduleOutputs);
    const collapse = detail.length > DETAIL_COLLAPSE_CHARS;
    return (
      <div
        key={`${lineKeyPrefix}-${keyExtra}-${line.time ?? i}-${i}`}
        className="border-b border-border/50 bg-card/40 px-3 py-2.5 last:border-b-0 odd:bg-muted/[0.08]"
      >
        <div className="text-[11px] font-medium leading-snug text-foreground/90">{line.msg}</div>
        {detail && collapse ? (
          <details className="group/logdetail mt-2 rounded-md border border-border/60 bg-muted/15">
            <summary className="cursor-pointer list-none px-2.5 py-2 text-[10px] font-medium text-primary hover:bg-muted/25 [&::-webkit-details-marker]:hidden">
              <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                Show output
                <span className="font-mono text-[9px] font-normal text-muted-foreground">
                  ({detail.length.toLocaleString()} chars)
                </span>
              </span>
            </summary>
            <pre className="max-h-[min(52vh,520px)] overflow-auto border-t border-border/50 bg-background/40 p-3 font-sans text-[11px] leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">
              {detail}
            </pre>
          </details>
        ) : detail ? (
          <pre className="mt-2 max-h-[min(42vh,380px)] overflow-auto rounded-md border border-border/40 bg-muted/10 p-2.5 font-sans text-[11px] leading-relaxed text-foreground/85 whitespace-pre-wrap break-words">
            {detail}
          </pre>
        ) : null}
      </div>
    );
  };

  return (
    <>
      {list.map((line, i) => renderRow(line, i, 'main'))}
      {rolledOff.length > 0 ? (
        <div className="border-t border-border/70 bg-muted/[0.06]">
          <p className="border-b border-border/40 px-3 py-2 text-[10px] leading-snug text-muted-foreground">
            Full text for some modules is still available below — their completion line rolled off the saved log tail
            (e.g. long ingest progress).
          </p>
          {rolledOff.map((line, i) => renderRow(line, i, `roll-${line.modId}`))}
        </div>
      ) : null}
    </>
  );
}
