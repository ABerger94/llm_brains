import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { BeliefStore, BeliefTension } from "../lib/data";
import { useMindStorageRefresh, notifyMindStorageChanged } from "../lib/mindStorageEvents";
import { Network, RefreshCw, AlertTriangle, Loader2, Sparkles, ZoomIn, ZoomOut, RotateCcw, Unlink } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { suggestContradictionPairs } from "../../shared/beliefContradictionUtils.mjs";
import { splitAggregateBeliefRowsInStore, mergeBeliefsFromRecentPipelineRuns } from "../lib/mindPersistence";
import { removeBeliefIdFromOthersContradicts } from "../lib/beliefStoreContradictionUtils";
import { beliefStatementAsPlainText } from "../lib/beliefReportParse";
import moment from "moment";

const CATEGORY_COLORS = {
  factual: "#06b6d4",
  normative: "#8b5cf6",
  self: "#f59e0b",
  causal: "#10b981",
  predictive: "#ec4899",
};

/** Same key the map uses for node fills (default factual). */
function beliefCategoryColor(category) {
  const key = String(category || "factual").toLowerCase();
  return CATEGORY_COLORS[key] ?? CATEGORY_COLORS.factual;
}

const MAP_MIN_SCALE = 0.35;
const MAP_MAX_SCALE = 4;

/** Normalize missing/legacy status so the active filter matches Extract / pipeline defaults. */
function beliefStatusForFilter(b) {
  return b.status || "active";
}

/** Deterministic pseudo-random in [0,1) from string (stable graph layout). */
function stableUnit(id, salt = "") {
  let h = 2166136261;
  const s = String(id) + salt;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

export default function BeliefMapPage() {
  const [beliefs, setBeliefs] = useState([]);
  const [tensions, setTensions] = useState([]);
  const [extracting, setExtracting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [filterStatus, setFilterStatus] = useState("all");
  const [tensionFilter, setTensionFilter] = useState("active");
  const canvasRef = useRef(null);
  const animFrameRef = useRef(null);
  const viewRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const graphNodesRef = useRef([]);
  const pointerDragRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await splitAggregateBeliefRowsInStore(400);
      const [data, ten] = await Promise.all([
        BeliefStore.list("-created_date", 200),
        BeliefTension.list("-created_date", 120),
      ]);
      setBeliefs(data);
      setTensions(ten);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useMindStorageRefresh(load);

  const markBeliefResolved = async (id) => {
    await BeliefStore.update(id, { status: "resolved", contradicts: [] });
    await removeBeliefIdFromOthersContradicts(id);
    await load();
    notifyMindStorageChanged({ source: "beliefs" });
  };

  const markBeliefActive = async (id) => {
    await BeliefStore.update(id, { status: "active" });
    await load();
    notifyMindStorageChanged({ source: "beliefs" });
  };

  const resetMapView = useCallback(() => {
    viewRef.current = { scale: 1, tx: 0, ty: 0 };
  }, []);

  const drawGraph = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = (canvas.width = canvas.offsetWidth);
    const H = (canvas.height = 420);

    const filtered =
      filterStatus === "all" ? beliefs : beliefs.filter((b) => beliefStatusForFilter(b) === filterStatus);
    const { scale, tx, ty } = viewRef.current;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    if (filtered.length === 0) {
      graphNodesRef.current = [];
      return;
    }

    const categories = [...new Set(filtered.map((b) => b.category || "factual"))];
    const nCats = Math.max(1, categories.length);
    const clusterR = Math.min(W, H) * (0.22 + 0.05 * Math.min(8, Math.sqrt(filtered.length)));

    const nodes = filtered.map((b) => {
      const catIdx = categories.indexOf(b.category || "factual");
      const catAngle = (catIdx / nCats) * Math.PI * 2;
      const u = stableUnit(b.id, "u");
      const v = stableUnit(b.id, "v");
      const wedge = (u - 0.5) * 1.35;
      const angle = catAngle + wedge;
      const radiusJitter = 0.65 + v * 0.7;
      return {
        id: b.id,
        x: W / 2 + Math.cos(angle) * clusterR * radiusJitter,
        y: H / 2 + Math.sin(angle) * clusterR * 0.88 * radiusJitter,
        r: 8 + (b.confidence || 0.5) * 18,
        color: CATEGORY_COLORS[b.category || "factual"] || "#06b6d4",
        belief: b,
        isContradicted: b.status === "contradicted" || (b.contradicts?.length > 0),
        isSelected: expandedId === b.id,
      };
    });

    ctx.setTransform(scale, 0, 0, scale, tx, ty);

    const invScale = 1 / scale;
    const edgeW = Math.max(0.8, 1.5 * invScale);
    const ringW = Math.max(1, 2 * invScale);
    const nodeStroke = Math.max(1, 1.5 * invScale);

    nodes.forEach((n) => {
      if (!n.belief.contradicts?.length) return;
      n.belief.contradicts.forEach((cid) => {
        const target = nodes.find((nd) => nd.id === cid);
        if (!target) return;
        ctx.beginPath();
        ctx.moveTo(n.x, n.y);
        ctx.lineTo(target.x, target.y);
        ctx.strokeStyle = "rgba(239,68,68,0.5)";
        ctx.lineWidth = edgeW;
        ctx.setLineDash([4 * invScale, 4 * invScale]);
        ctx.stroke();
        ctx.setLineDash([]);
      });
    });

    nodes.forEach((n) => {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = n.color + (n.isSelected ? "ff" : "33");
      ctx.fill();
      ctx.strokeStyle = n.isContradicted ? "#ef4444" : (n.isSelected ? n.color : n.color + "88");
      ctx.lineWidth = n.isSelected ? nodeStroke * 1.3 : nodeStroke;
      ctx.stroke();

      const conf = n.belief.confidence || 0.5;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + 3 * invScale, -Math.PI / 2, -Math.PI / 2 + conf * Math.PI * 2);
      ctx.strokeStyle = n.color;
      ctx.lineWidth = ringW;
      ctx.stroke();

      if (n.r > 14 || n.isSelected) {
        ctx.font = `${Math.max(8, 10 * invScale)}px Inter, sans-serif`;
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const plain = beliefStatementAsPlainText(n.belief.statement).trim();
        const label = plain.slice(0, 20) + (plain.length > 20 ? "…" : "");
        ctx.fillText(label, n.x, n.y + n.r + 12 * invScale);
      }
    });

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    graphNodesRef.current = nodes;
    canvas._nodes = nodes;
  }, [beliefs, expandedId, filterStatus]);

  useEffect(() => {
    drawGraph();
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [beliefs, expandedId, filterStatus, drawGraph]);

  const clientToCanvas = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * (canvas.width / rect.width);
    const y = (clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
  }, []);

  const graphPointFromCanvas = useCallback((cx, cy) => {
    const { scale, tx, ty } = viewRef.current;
    return { gx: (cx - tx) / scale, gy: (cy - ty) / scale };
  }, []);

  const hitTestNode = useCallback((gx, gy) => {
    const pad = 10;
    return graphNodesRef.current.find((n) => Math.hypot(n.x - gx, n.y - gy) < n.r + pad);
  }, []);

  const applyZoomAtCanvasPoint = useCallback(
    (canvasX, canvasY, factor) => {
      let { scale, tx, ty } = viewRef.current;
      const newScale = Math.min(MAP_MAX_SCALE, Math.max(MAP_MIN_SCALE, scale * factor));
      const gx = (canvasX - tx) / scale;
      const gy = (canvasY - ty) / scale;
      tx = canvasX - gx * newScale;
      ty = canvasY - gy * newScale;
      viewRef.current = { scale: newScale, tx, ty };
      drawGraph();
    },
    [drawGraph]
  );

  const zoomAtCenterBy = useCallback(
    (factor) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      applyZoomAtCanvasPoint(canvas.width / 2, canvas.height / 2, factor);
    },
    [applyZoomAtCanvasPoint]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e) => {
      e.preventDefault();
      const { x, y } = clientToCanvas(e.clientX, e.clientY);
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      applyZoomAtCanvasPoint(x, y, factor);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [clientToCanvas, applyZoomAtCanvasPoint]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => drawGraph());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [drawGraph]);

  const handleResetMapView = useCallback(() => {
    resetMapView();
    drawGraph();
  }, [resetMapView, drawGraph]);

  const onCanvasPointerDown = useCallback(
    (e) => {
      if (e.button !== 0) return;
      const el = canvasRef.current;
      if (!el) return;
      const { x, y } = clientToCanvas(e.clientX, e.clientY);
      const { gx, gy } = graphPointFromCanvas(x, y);
      const hit = hitTestNode(gx, gy);
      pointerDragRef.current = {
        hit,
        lastX: x,
        lastY: y,
        originClientX: e.clientX,
        originClientY: e.clientY,
        hasPanned: false,
      };
      el.setPointerCapture(e.pointerId);
    },
    [clientToCanvas, graphPointFromCanvas, hitTestNode]
  );

  const onCanvasPointerMove = useCallback(
    (e) => {
      if (!pointerDragRef.current) return;
      const d = pointerDragRef.current;
      const { x, y } = clientToCanvas(e.clientX, e.clientY);
      const dx = x - d.lastX;
      const dy = y - d.lastY;
      d.lastX = x;
      d.lastY = y;
      if (Math.hypot(dx, dy) > 0.25) d.hasPanned = true;
      viewRef.current.tx += dx;
      viewRef.current.ty += dy;
      drawGraph();
    },
    [clientToCanvas, drawGraph]
  );

  const endCanvasPointer = useCallback((e) => {
    const d = pointerDragRef.current;
    pointerDragRef.current = null;
    const el = canvasRef.current;
    if (el && e.pointerId != null) {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    }
    if (!d) return;
    const moved = Math.hypot(e.clientX - d.originClientX, e.clientY - d.originClientY);
    if (!d.hasPanned && moved < 8 && d.hit) {
      setExpandedId((prev) => (prev === d.hit.belief.id ? null : d.hit.belief.id));
    }
  }, []);

  const setTensionState = async (row, tension_state) => {
    await BeliefTension.update(row.id, { tension_state });
    await load();
    notifyMindStorageChanged({ source: "belief-tension" });
  };

  const extractBeliefs = async () => {
    setExtracting(true);
    try {
      await mergeBeliefsFromRecentPipelineRuns();
      await load();
    } finally {
      setExtracting(false);
    }
  };

  const deleteBelief = async (id) => {
    await BeliefStore.delete(id);
    if (expandedId === id) setExpandedId(null);
    await load();
    notifyMindStorageChanged({ source: "beliefs" });
  };

  const filtered =
    filterStatus === "all" ? beliefs : beliefs.filter((b) => beliefStatusForFilter(b) === filterStatus);
  const contradicted = beliefs.filter(b => b.status === "contradicted").length;
  const filteredTensions =
    tensionFilter === "all" ? tensions : tensions.filter((t) => (t.tension_state || "active") === tensionFilter);
  const mergeCandidates = useMemo(
    () => suggestContradictionPairs(beliefs, { maxPairs: 14, minJaccard: 0.2 }),
    [beliefs]
  );

  const linkContradictionEdge = async (a, b) => {
    const aCon = [...new Set([...(a.contradicts || []), b.id])];
    const bCon = [...new Set([...(b.contradicts || []), a.id])];
    await BeliefStore.update(a.id, { contradicts: aCon, status: a.status || "active" });
    await BeliefStore.update(b.id, { contradicts: bCon, status: "contradicted" });
    await load();
    notifyMindStorageChanged({ source: "beliefs" });
  };

  /** Remove the contradiction edge between two beliefs (both sides of `contradicts` + status when appropriate). */
  const unlinkContradictionBetween = async (idA, idB) => {
    const [a, b] = await Promise.all([BeliefStore.retrieve(idA), BeliefStore.retrieve(idB)]);
    if (!a) return;
    const aCon = (a.contradicts || []).filter((id) => id !== idB);
    const statusA =
      aCon.length === 0 && a.status === "contradicted" ? "active" : a.status || "active";
    await BeliefStore.update(idA, { contradicts: aCon, status: statusA });
    if (b) {
      const bCon = (b.contradicts || []).filter((id) => id !== idA);
      const statusB =
        bCon.length === 0 && b.status === "contradicted" ? "active" : b.status || "active";
      await BeliefStore.update(idB, { contradicts: bCon, status: statusB });
    }
    await load();
    notifyMindStorageChanged({ source: "beliefs" });
  };

  const pairIsLinked = (a, b) =>
    (a.contradicts || []).includes(b.id) || (b.contradicts || []).includes(a.id);

  return (
    <div className="min-h-screen p-4 sm:p-6">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Network className="w-6 h-6 text-green-400" /> Belief Map
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              One node per atomic belief — scroll to zoom, drag to pan. Node size = confidence, red edges = contradictions.
              When the graph pipeline&apos;s Belief Store module emits{' '}
              <span className="font-mono text-[11px] text-foreground/75">BELIEF_REVISIONS</span> with{' '}
              <span className="text-foreground/85">strengthen</span> or <span className="text-foreground/85">reinforce</span>, matching
              rows update here (confidence and <span className="text-foreground/85">times reinforced</span>). The same module ends
              with <span className="font-mono text-[11px] text-foreground/75">EPISTEMIC_CLAIMS</span> for provenance-tagged claims
              Voice and Narrative can use.
            </p>
          </div>
          <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
            {contradicted > 0 && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-destructive/10 border border-destructive/30 text-xs text-destructive">
                <AlertTriangle className="w-3 h-3" /> {contradicted} contradictions
              </div>
            )}
            <Button variant="outline" size="sm" onClick={() => load()} disabled={loading} className="gap-2">
              <RefreshCw className={cn("w-3 h-3", loading && "animate-spin")} />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={() => void extractBeliefs()} disabled={extracting || loading} className="gap-2">
              {extracting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              Extract from Pipeline
            </Button>
          </div>
        </div>

        {/* Filter */}
        <div className="mb-4 flex flex-wrap gap-2">
          {["all", "active", "contradicted", "resolved"].map(s => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className={cn("px-3 py-1 rounded-full text-xs border transition-all",
                filterStatus === s ? "bg-primary/10 border-primary/40 text-primary" : "border-border text-muted-foreground hover:text-foreground")}>
              {s} {s !== "all" && `(${beliefs.filter((b) => beliefStatusForFilter(b) === s).length})`}
            </button>
          ))}
        </div>

        <div className="mb-6 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4">
          <h2 className="text-sm font-semibold text-foreground">Overlap & tension candidates</h2>
          <p className="text-xs text-muted-foreground mt-0.5 mb-3">
            Heuristic pairs (token overlap / negation hint) — not proof of contradiction. Link nodes to draw red edges on the graph.
          </p>
          {mergeCandidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">No candidates at current thresholds.</p>
          ) : (
            <ul className="space-y-2 max-h-40 overflow-y-auto">
              {mergeCandidates.map((p, idx) => (
                <li key={`${p.a.id}-${p.b.id}-${idx}`} className="rounded-lg border border-border/80 bg-card/40 p-2 text-[11px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-muted-foreground">
                      score {(p.score * 100).toFixed(0)}% · {p.reason}
                    </span>
                    {pairIsLinked(p.a, p.b) ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1 text-[10px]"
                        onClick={() => void unlinkContradictionBetween(p.a.id, p.b.id)}
                      >
                        <Unlink className="w-3 h-3" />
                        Unlink
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-[10px]"
                        onClick={() => void linkContradictionEdge(p.a, p.b)}
                      >
                        Link contradiction edge
                      </Button>
                    )}
                  </div>
                  <p className="mt-1 text-foreground/85 line-clamp-3 text-sm leading-relaxed">
                    {beliefStatementAsPlainText(p.a.statement)}
                  </p>
                  <p className="mt-0.5 text-foreground/85 line-clamp-3 text-sm leading-relaxed">
                    {beliefStatementAsPlainText(p.b.statement)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mb-6 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Open worldview threads</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Tensions from the Contradiction Engine (active / suspended / integrated). Not the same as belief nodes —
                these are unresolved threads you may revisit after new memories.
              </p>
            </div>
            <div className="flex gap-1">
              {["all", "active", "suspended", "integrated"].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setTensionFilter(s)}
                  className={cn(
                    "px-2 py-1 rounded-md text-[10px] border transition-all",
                    tensionFilter === s ? "border-amber-400/50 bg-amber-500/10 text-amber-200" : "border-border text-muted-foreground"
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-3 space-y-2 max-h-48 overflow-y-auto">
            {filteredTensions.length === 0 ? (
              <p className="text-xs text-muted-foreground">No tensions in this filter.</p>
            ) : (
              filteredTensions.map((t) => (
                <div key={t.id} className="rounded-lg border border-border/80 bg-card/50 p-2 text-xs">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="text-foreground/90 leading-relaxed flex-1 min-w-0">{t.description}</p>
                    <select
                      value={t.tension_state || "active"}
                      onChange={(e) => setTensionState(t, e.target.value)}
                      className="shrink-0 rounded border border-input bg-background px-1 py-0.5 text-[10px]"
                    >
                      <option value="active">active</option>
                      <option value="suspended">suspended</option>
                      <option value="integrated">integrated</option>
                    </select>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                    {t.phase ? <span>phase: {t.phase}</span> : null}
                    {t.revisit_after ? <span>revisit: {moment(t.revisit_after).fromNow()}</span> : null}
                    <span>{t.created_date ? moment(t.created_date).fromNow() : ""}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Graph */}
          <div className="lg:col-span-2 rounded-xl border border-border bg-card overflow-hidden relative">
            <div className="absolute top-2 right-2 z-10 flex gap-1">
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
            </div>
            <canvas
              ref={canvasRef}
              className="w-full cursor-grab touch-none active:cursor-grabbing block"
              style={{ height: 420 }}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={endCanvasPointer}
              onPointerCancel={endCanvasPointer}
            />
            <div className="px-4 py-2 border-t border-border flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground shrink-0">
                Scroll or pinch-trackpad to zoom · drag to pan · click a node for details
              </span>
              <div className="flex gap-4 flex-wrap">
                {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
                  <div key={cat} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                    {cat}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Beliefs List — one row = one atomic belief */}
          <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1">
            {filtered.map((b) => {
              const catColor = beliefCategoryColor(b.category);
              return (
                <div
                  key={b.id}
                  className={cn(
                    "rounded-lg border transition-colors flex overflow-hidden min-h-0",
                    expandedId === b.id ? "border-primary/35 bg-primary/[0.06]" : "border-border/80 bg-card/80",
                    b.status === "contradicted" && "border-destructive/25"
                  )}
                >
                  <div
                    className="w-1 shrink-0 self-stretch min-h-[2.75rem]"
                    style={{ backgroundColor: catColor }}
                    aria-hidden
                  />
                  <div className="flex-1 min-w-0">
                  <button
                    type="button"
                    onClick={() => setExpandedId(expandedId === b.id ? null : b.id)}
                    className="w-full text-left p-3.5 flex items-start gap-2.5"
                  >
                    {b.status === "contradicted" ? (
                      <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" aria-hidden />
                    ) : (
                      <span
                        className="w-2 h-2 shrink-0 mt-2 rounded-full border border-white/10 shadow-sm"
                        style={{ backgroundColor: catColor }}
                        aria-hidden
                      />
                    )}
                    <p className="flex-1 min-w-0 text-sm text-foreground leading-relaxed">
                      {beliefStatementAsPlainText(b.statement) || "—"}
                    </p>
                  </button>
                  {expandedId === b.id && (
                    <div className="px-3.5 pb-3.5 pt-0 space-y-3 text-sm border-t border-border/40">
                      {b.reasoning ? (
                        <p className="text-muted-foreground leading-relaxed">{beliefStatementAsPlainText(b.reasoning)}</p>
                      ) : null}
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>Confidence {Math.round((b.confidence || 0.5) * 100)}%</span>
                        {typeof b.times_reinforced === 'number' && b.times_reinforced > 0 ? (
                          <span className="text-emerald-600/90 dark:text-emerald-400/90">
                            Reinforced ×{b.times_reinforced}
                          </span>
                        ) : null}
                        {b.category ? (
                          <span className="font-medium capitalize" style={{ color: catColor }}>
                            {b.category}
                          </span>
                        ) : null}
                        {b.status ? (
                          <span className={b.status === "contradicted" ? "text-destructive" : undefined}>{b.status}</span>
                        ) : null}
                        {b.source_module || b.source ? (
                          <span>Source: {b.source_module || b.source}</span>
                        ) : null}
                        {b.created_date ? <span>{moment(b.created_date).fromNow()}</span> : null}
                      </div>
                      <div className="flex flex-wrap gap-3">
                        {b.status === "resolved" || b.status === "deprecated" ? (
                          <button
                            type="button"
                            onClick={() => void markBeliefActive(b.id)}
                            className="text-xs text-muted-foreground hover:underline"
                          >
                            Mark active
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void markBeliefResolved(b.id)}
                            className="text-emerald-600/90 text-xs hover:underline dark:text-emerald-400/90"
                          >
                            Mark resolved
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => deleteBelief(b.id)}
                          className="text-destructive text-xs hover:underline"
                        >
                          Delete belief
                        </button>
                      </div>
                    </div>
                  )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}