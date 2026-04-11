import { useMemo } from 'react';
import { COGNITIVE_MODULES, getModule, getServerExecutionLayers } from '../../lib/cognitiveModules';
import { cn } from '../../lib/utils';

const NODE_GAP = 10;
/** Horizontal space reserved for stage labels (left column); keep long names from colliding with first node. */
const LABEL_W = 188;
const PADDING_X = 22;
const ROW_GAP = 36;
const TOP = 22;
const FONT_SIZE = 9;
const LINE_HEIGHT = 12;
const NODE_PAD_X = 8;
const NODE_PAD_Y = 6;
/** Target characters per line for wrapping (full name, no truncation). */
const WRAP_CHARS = 16;
const MIN_NODE_W = 92;
const MAX_NODE_W = 168;

/** Indigo processing highlight so graph nodes stay distinct when app `--primary` is neutral/white. */
const PROCESSING_MODULE_STROKE = 'hsl(239 84% 67%)';
const PROCESSING_MODULE_FILL = 'hsl(239 84% 67% / 0.12)';

function statusStroke(status) {
  if (status === 'processing') return PROCESSING_MODULE_STROKE;
  if (status === 'complete') return 'rgb(52 211 153)';
  if (status === 'error') return 'hsl(var(--destructive))';
  return 'hsl(var(--border))';
}

function statusFill(status) {
  if (status === 'processing') return PROCESSING_MODULE_FILL;
  if (status === 'complete') return 'rgb(16 185 129 / 0.12)';
  if (status === 'error') return 'hsl(var(--destructive) / 0.12)';
  return 'hsl(var(--muted) / 0.35)';
}

function edgePathStraight(x1, y1, x2, y2) {
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

/** Word-wrap to full label (no ellipsis); lines fit within maxChars where possible. */
function wrapModuleLabel(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines = [];
  let line = '';
  for (const w of words) {
    const trial = line ? `${line} ${w}` : w;
    if (trial.length <= maxChars) {
      line = trial;
    } else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Approximate monospace-ish width at FONT_SIZE for layout. */
function estimateTextWidthPx(s) {
  return Math.ceil(s.length * FONT_SIZE * 0.52);
}

function layoutNodeMetrics(fullName) {
  const lines = wrapModuleLabel(fullName, WRAP_CHARS);
  const contentW = Math.max(...lines.map((l) => estimateTextWidthPx(l)), MIN_NODE_W - NODE_PAD_X * 2);
  const w = Math.min(MAX_NODE_W, Math.max(MIN_NODE_W, contentW + NODE_PAD_X * 2));
  const h = NODE_PAD_Y * 2 + lines.length * LINE_HEIGHT;
  return { lines, w, h };
}

export default function GraphCanvas({ moduleStatuses = {}, moduleOutputs = {}, compact = false }) {
  const layout = useMemo(() => {
    const layers = getServerExecutionLayers();
    let y = TOP;
    const positions = {};
    const rows = [];
    let maxRight = LABEL_W + PADDING_X;

    for (const { layerKey, label, moduleIds } of layers) {
      const rowStartX = LABEL_W + PADDING_X;
      let xCursor = rowStartX;
      let rowMaxH = 0;

      for (const id of moduleIds) {
        const mod = getModule(id);
        const fullName = mod?.name || id;
        const { lines, w, h } = layoutNodeMetrics(fullName);
        const cx = xCursor + w / 2;
        const cy = y + h / 2;
        positions[id] = { x: cx, y: cy, w, h, lines };
        xCursor += w + NODE_GAP;
        rowMaxH = Math.max(rowMaxH, h);
      }

      const rowW = xCursor - rowStartX - (moduleIds.length ? NODE_GAP : 0);
      maxRight = Math.max(maxRight, rowStartX + rowW + PADDING_X);

      rows.push({ layerKey, label, moduleIds, y, rowStartX, rowMaxH });
      y += rowMaxH + ROW_GAP;
    }

    const H = Math.max(TOP + 28, y - ROW_GAP) + PADDING_X + 36;
    const W = Math.max(720, maxRight + 24);

    const edges = [];
    for (let r = 0; r < rows.length; r++) {
      const { moduleIds } = rows[r];
      for (let i = 0; i < moduleIds.length - 1; i++) {
        const a = moduleIds[i];
        const b = moduleIds[i + 1];
        const pA = positions[a];
        const pB = positions[b];
        if (pA && pB) {
          edges.push({
            key: `${a}-${b}-inrow`,
            d: edgePathStraight(pA.x + pA.w / 2, pA.y, pB.x - pB.w / 2, pB.y),
            dashed: false,
          });
        }
      }
      if (r < rows.length - 1) {
        const lastId = moduleIds[moduleIds.length - 1];
        const nextIds = rows[r + 1].moduleIds;
        const nextFirst = nextIds[0];
        if (lastId && nextFirst) {
          const pL = positions[lastId];
          const pN = positions[nextFirst];
          if (pL && pN) {
            edges.push({
              key: `${lastId}-${nextFirst}-stage`,
              d: edgePathStraight(pL.x, pL.y + pL.h / 2, pN.x, pN.y - pN.h / 2),
              dashed: false,
            });
          }
        }
      }
    }

    const meta = positions.metacognition;
    const perc = positions.perception;
    let rerunPath = null;
    if (meta && perc) {
      const x1 = meta.x - meta.w / 2;
      const y1 = meta.y;
      const x2 = perc.x - perc.w / 2;
      const y2 = perc.y;
      const dx = x2 - x1;
      const c1x = x1 - Math.max(140, Math.abs(dx) + 80);
      const c1y = y1;
      const c2x = x2 - Math.max(100, Math.abs(dx) * 0.4 + 40);
      const c2y = y2;
      rerunPath = `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;
    }

    const allIds = layers.flatMap((L) => L.moduleIds);

    return { positions, edges, H, W, rows, rerunPath, allIds };
  }, []);

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="border-b border-border px-3 py-2 sm:px-4">
        <h2 className="text-sm font-semibold text-foreground">Execution graph</h2>
        {compact ? (
          <p className="text-xs text-muted-foreground">
            Six stages, {COGNITIVE_MODULES.length} modules — swipe or scroll horizontally on small screens.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Six sequential stages (server order). Modules in each row run one after another. Layer 5 ends with{' '}
            <span className="font-medium text-foreground/80">Integration</span>: specialists compete for a single global-workspace
            broadcast consumed by Language → Narrative → Voice (GWT framing in prompts; not a claim of literal IIT Φ).
            Metacognition may trigger a dashed rerun of stages 1–4. Live status for {COGNITIVE_MODULES.length} modules.
          </p>
        )}
      </div>
      <div
        className={cn(
          'relative w-full max-w-full overflow-x-auto overflow-y-hidden overscroll-x-contain bg-muted/20 p-2 touch-pan-x [-webkit-overflow-scrolling:touch]',
          /* Avoid zero-height SVG layout on narrow WebKit when embedded in grid/flex parents. */
          compact && 'min-h-[13rem] sm:min-h-0'
        )}
      >
        <svg
          viewBox={`0 0 ${layout.W} ${layout.H}`}
          className="mx-auto block h-auto w-full min-w-[720px] max-w-[100%] text-foreground"
          role="img"
          aria-label="Cognitive pipeline execution stages"
        >
          <defs>
            <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="hsl(var(--muted-foreground) / 0.45)" />
            </marker>
            <marker id="arrowhead-rerun" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
              <path d="M0,0 L5,2.5 L0,5 Z" fill="hsl(var(--muted-foreground) / 0.35)" />
            </marker>
          </defs>

          {layout.rerunPath ? (
            <path
              d={layout.rerunPath}
              fill="none"
              stroke="hsl(var(--muted-foreground) / 0.32)"
              strokeWidth="1.25"
              strokeDasharray="5 4"
              markerEnd="url(#arrowhead-rerun)"
            />
          ) : null}

          {layout.edges.map((e) => (
            <path
              key={e.key}
              d={e.d}
              fill="none"
              stroke="hsl(var(--muted-foreground) / 0.38)"
              strokeWidth="1"
              strokeDasharray={e.dashed ? '4 3' : undefined}
              markerEnd="url(#arrowhead)"
            />
          ))}

          {layout.rows.map((row) => (
            <text
              key={row.layerKey}
              x={8}
              y={row.y + (row.rowMaxH || 28) / 2 + 4}
              fill="currentColor"
              className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              style={{ fontSize: '10px' }}
            >
              {row.label}
            </text>
          ))}

          {layout.rerunPath ? (
            <text
              x={8}
              y={layout.H - 10}
              fill="currentColor"
              className="text-muted-foreground"
              style={{ fontSize: '9px' }}
            >
              Dashed: Metacognition may rerun stages 1–4 (layers 1–4)
            </text>
          ) : null}

          {layout.allIds.map((id) => {
            const p = layout.positions[id];
            if (!p) return null;
            const mod = getModule(id);
            const status = moduleStatuses[id];
            const recorded =
              moduleOutputs && typeof moduleOutputs === 'object' && Object.prototype.hasOwnProperty.call(moduleOutputs, id);
            const outStr = recorded ? String(moduleOutputs[id] ?? '') : '';
            const outBlock =
              recorded && outStr.trim()
                ? `\n\n— output —\n${outStr.slice(0, 400)}`
                : recorded
                  ? '\n\n— output —\n(empty)'
                  : '';
            const x = p.x - p.w / 2;
            const y = p.y - p.h / 2;
            const lines = p.lines || [mod?.name || id];
            const firstTextY = y + NODE_PAD_Y + FONT_SIZE * 0.85;
            return (
              <g key={id}>
                <title>
                  {`${mod?.name || id}${mod?.description ? `\n${String(mod.description).slice(0, 280)}` : ''}${outBlock}`}
                </title>
                <rect
                  x={x}
                  y={y}
                  width={p.w}
                  height={p.h}
                  rx={8}
                  fill={statusFill(status)}
                  stroke={statusStroke(status)}
                  strokeWidth={status === 'processing' ? 2 : 1}
                  className={cn(status === 'processing' && 'animate-pulse')}
                />
                {lines.map((line, i) => (
                  <text
                    key={`${id}-L${i}`}
                    x={p.x}
                    y={firstTextY + i * LINE_HEIGHT}
                    textAnchor="middle"
                    fill="currentColor"
                    style={{ fontSize: `${FONT_SIZE}px`, fontWeight: 600 }}
                  >
                    {line}
                  </text>
                ))}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
