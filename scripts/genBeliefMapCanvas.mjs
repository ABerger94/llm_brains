import fs from "fs";

const src = fs.readFileSync("src/pages/BeliefMapPage.jsx", "utf8");
const lines = src.split(/\r?\n/);

const take = (start, end) => lines.slice(start - 1, end).join("\n");

const header = `import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  X,
  LayoutGrid,
  PieChart,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { BELIEF_MAP_CATEGORY_ORDER } from "../../shared/beliefMapCategory.mjs";
import { jaccardSimilarity } from "../../shared/beliefContradictionUtils.mjs";
import { beliefStatementAsPlainText } from "../lib/beliefReportParse";
import { buildGridBeliefMapLayout } from "../lib/beliefMapGridLayout";
import { buildCircularBorderBeliefMapLayout } from "../lib/beliefMapCircularBorderLayout";
`;

const helpers = take(36, 273);

let drawAndPointers = take(353, 856);
drawAndPointers = drawAndPointers.replace(/setExpandedId\(b\.id\)/g, "onExpandedIdChange?.(b.id)");

const body = `
/**
 * Interactive belief map canvas (grid + circular layouts). Shared by Belief Map page and Dashboard.
 */
export default function BeliefMapCanvas({
  beliefs,
  filterStatus = "all",
  expandedId,
  onExpandedIdChange,
  variant = "page",
  className,
  mapWrapClassName,
}) {
  const [mapPopup, setMapPopup] = useState(null);
  const canvasRef = useRef(null);
  const animFrameRef = useRef(null);
  const viewRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const graphNodesRef = useRef([]);
  const pointerDragRef = useRef(null);
  const pendingMobileFitRef = useRef(true);

  const [mapLayout, setMapLayout] = useState(() => {
    if (typeof window === "undefined") return "grid";
    const v = window.localStorage.getItem("beliefMapLayout");
    return v === "circular" ? "circular" : "grid";
  });

  useLayoutEffect(() => {
    pendingMobileFitRef.current = true;
  }, [mapLayout]);

  useEffect(() => {
    pendingMobileFitRef.current = true;
  }, [beliefs, filterStatus]);

  const resetMapView = useCallback(() => {
    pendingMobileFitRef.current = true;
  }, []);

${drawAndPointers}

  const isDashboard = variant === "dashboard";

  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card",
        isDashboard && "rounded-none border-0 bg-transparent",
        className
      )}
    >
      <div className="absolute top-2 right-2 z-10 flex flex-wrap justify-end gap-1 max-w-[min(100%,calc(100%-1rem))]">
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="h-8 w-8 bg-card/95 shadow-sm border border-border"
          title="Zoom in"
          onClick={() => zoomAtCenterBy(1.15)}
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="h-8 w-8 bg-card/95 shadow-sm border border-border"
          title="Zoom out"
          onClick={() => zoomAtCenterBy(1 / 1.15)}
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="h-8 w-8 bg-card/95 shadow-sm border border-border"
          title="Reset pan & zoom"
          onClick={handleResetMapView}
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className={cn(
            "h-8 w-8 bg-card/95 shadow-sm border border-border",
            mapLayout === "circular" && "ring-1 ring-primary/35"
          )}
          title={mapLayout === "grid" ? "Circular belief map" : "Column grid map"}
          onClick={() => {
            setMapLayout((prev) => {
              const next = prev === "grid" ? "circular" : "grid";
              try {
                window.localStorage.setItem("beliefMapLayout", next);
              } catch {
                /* ignore */
              }
              return next;
            });
          }}
        >
          {mapLayout === "grid" ? (
            <PieChart className="w-3.5 h-3.5" />
          ) : (
            <LayoutGrid className="w-3.5 h-3.5" />
          )}
        </Button>
      </div>
      <div
        className={cn(
          mapLayout === "grid" && "max-lg:max-h-[min(38vh,520px)] max-lg:overflow-y-auto overscroll-contain",
          mapWrapClassName
        )}
      >
        <canvas
          ref={canvasRef}
          className="w-full cursor-grab touch-none active:cursor-grabbing block"
          style={mapLayout === "circular" ? undefined : { minHeight: 420 }}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={endCanvasPointer}
          onPointerCancel={endCanvasPointer}
        />
      </div>
      {mapPopup ? (
        <div
          className="pointer-events-auto fixed z-[60] w-[min(22rem,calc(100vw-1.5rem))] max-h-[min(50vh,22rem)] overflow-y-auto rounded-lg border border-border bg-card/95 p-3 pr-10 text-sm shadow-xl backdrop-blur-sm"
          style={{
            left: (() => {
              const vw = typeof window !== "undefined" ? window.innerWidth : 400;
              const w = Math.min(352, vw - 16);
              return Math.max(8, Math.min(mapPopup.left + 12, vw - w - 8));
            })(),
            top: (() => {
              const vh = typeof window !== "undefined" ? window.innerHeight : 600;
              return Math.max(8, Math.min(mapPopup.top + 12, vh - 200));
            })(),
          }}
          role="dialog"
          aria-label="Belief text"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
            onClick={() => setMapPopup(null)}
          >
            <X className="h-4 w-4" />
          </button>
          <p className="leading-relaxed text-foreground pr-1">{mapPopup.text}</p>
          <p className="mt-2 text-[11px] text-muted-foreground tabular-nums">
            Confidence {Math.round(mapPopup.confidence * 100)}%
          </p>
        </div>
      ) : null}
      {!isDashboard ? (
        <div className="px-4 py-2 border-t border-border flex flex-wrap items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground shrink-0">
            Scroll or pinch-trackpad to zoom · drag to pan · click a circle for full belief text
          </span>
          <div className="flex gap-4 flex-wrap items-center">
            {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
              <div key={cat} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                {cat}
              </div>
            ))}
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="whitespace-nowrap">Reinforced</span>
              <span
                className="h-2 w-14 shrink-0 rounded-full bg-gradient-to-r from-amber-200 via-amber-500 to-amber-900 ring-1 ring-border/40"
                title="Amber: lighter = fewer × reinforced, darker = more"
                aria-hidden
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="pointer-events-none absolute bottom-2 left-2 right-2 z-[2] flex justify-center">
          <span className="pointer-events-none rounded-md border border-border/60 bg-background/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur-sm">
            Pinch or scroll to zoom · drag to pan · tap a belief for text
          </span>
        </div>
      )}
    </div>
  );
}

export {
  CATEGORY_COLORS,
  beliefCategoryColor,
  beliefCategoryColorSemiTransparent,
  beliefMapNodeFillColor,
  beliefMapCircleRadius,
  beliefStatusForFilter,
  beliefCategoryKey,
  orderedCategoriesPresent,
  computeLineGroupsForBeliefList,
  deriveThreadRowTitle,
};
`;

const out = `${header}\n${helpers}\n${body}`;
fs.mkdirSync("src/components/beliefMap", { recursive: true });
fs.writeFileSync("src/components/beliefMap/BeliefMapCanvas.jsx", out);
console.log("written bytes", out.length);
