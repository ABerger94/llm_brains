import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  X,
  LayoutGrid,
  PieChart,
} from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { BELIEF_MAP_CATEGORY_ORDER } from "../../../shared/beliefMapCategory.mjs";
import { jaccardSimilarity } from "../../../shared/beliefContradictionUtils.mjs";
import { beliefListPrimaryLine } from "../../lib/beliefReportParse";
import { buildGridBeliefMapLayout } from "../../lib/beliefMapGridLayout";
import { buildCircularBorderBeliefMapLayout } from "../../lib/beliefMapCircularBorderLayout";

const CATEGORY_COLORS = {
  factual: "#06b6d4",
  normative: "#8b5cf6",
  self: "#6366f1",
  causal: "#10b981",
  predictive: "#ec4899",
};

/** Same key the map uses for node fills (default factual). */
function beliefCategoryColor(category) {
  const key = String(category || "factual").toLowerCase();
  return CATEGORY_COLORS[key] ?? CATEGORY_COLORS.factual;
}

/** 8-digit `#rrggbbaa` fill for circular sector wedges (~26% opacity). */
function beliefCategoryColorSemiTransparent(category) {
  return `${beliefCategoryColor(category)}44`;
}

/**
 * Amber scale: lighter = fewer reinforcements, deeper = more (caps ~50+ as darkest).
 * Stays hex so canvas can append alpha (`#rrggbb` + `33` / `88` / `ff`).
 */
const REINFORCE_AMBER_STOPS = [
  "#fef3c7",
  "#fde68a",
  "#fcd34d",
  "#fbbf24",
  "#f59e0b",
  "#d97706",
  "#b45309",
  "#78350f",
];

function reinforcementAmberIndex(timesReinforced) {
  const tr = Math.max(1, Number(timesReinforced) || 1);
  const t = Math.min(1, Math.log1p(tr) / Math.log1p(48));
  const max = REINFORCE_AMBER_STOPS.length - 1;
  return Math.min(max, Math.floor(t * max + 1e-6));
}

/** Map / list node color: category hues unless reinforced (amber family by degree). */
function beliefMapNodeFillColor(belief) {
  const tr = Number(belief?.times_reinforced);
  if (!Number.isFinite(tr) || tr <= 0) {
    return beliefCategoryColor(belief?.category);
  }
  return REINFORCE_AMBER_STOPS[reinforcementAmberIndex(tr)];
}

/** Canvas circle radius from confidence (must match layout + draw). */
function beliefMapCircleRadius(b) {
  return 8 + (b.confidence || 0.5) * 18;
}

const MAP_MIN_SCALE = 0.35;
const MAP_MAX_SCALE = 4;
/** Same factor as the zoom-in control (Belief Map toolbar). */
const MAP_ZOOM_IN_STEP = 1.15;
/** On load, circular map zooms in as if zoom-in were pressed this many times (after fit-to-view). Keep 0 so fit-to-view is the default (hub visible). */
const MAP_CIRCULAR_INITIAL_ZOOM_STEPS = 0;
/** Desktop grid map: slight zoom-in after fit. Circular uses {@link MAP_CIRCULAR_DESKTOP_FIT_BOOST} instead. */
const MAP_DESKTOP_FIT_BOOST = 1.08;
/** Circular map on desktop: do not zoom past fit (1.08 made the hub feel cropped). */
const MAP_CIRCULAR_DESKTOP_FIT_BOOST = 1;
/** Top/left padding (px) when fitting so category titles stay under the top edge of the map card. */
const MAP_DESKTOP_FIT_PAD = 12;

/** Normalize missing/legacy status so the active filter matches Extract / pipeline defaults. */
function beliefStatusForFilter(b) {
  return b.status || "active";
}

const CATEGORY_ORDER = BELIEF_MAP_CATEGORY_ORDER;
/** Token overlap threshold for grouping beliefs into the same map row (lower = fuller rows; too low merges unrelated topics). */
const MIN_TOPIC_JACCARD = 0.3;
/** When Jaccard splits almost every belief into its own row, pack into fixed-size rows (recency) so the map stays readable. */
const PACK_ROW_SIZE = 6;
const PACK_IF_SINGLETON_ROW_FRAC = 0.55;
/** Minimum width (px) per category column when multiple columns — map grows wider + scrolls horizontally if needed. */
const MAP_MIN_INNER_COL_PX = 172;

function beliefCategoryKey(b) {
  return String(b?.category || "factual").toLowerCase();
}

/**
 * Canvas rotation (radians) so labels follow the sector arc but stay upright and read L→R.
 * `radialAngle` is the sector mid-angle from the hub (same as layout).
 */
function circularTangentTextRotation(radialAngle) {
  const tx = -Math.sin(radialAngle);
  const ty = Math.cos(radialAngle);
  let rot = Math.atan2(ty, tx);
  if (rot > Math.PI / 2) rot -= Math.PI;
  else if (rot < -Math.PI / 2) rot += Math.PI;
  return rot;
}

/** Connected components by token Jaccard within one belief list (same line = related topic). */
function computeLineGroupsForBeliefList(list) {
  const lines = [];
  const n = list.length;
  const visited = new Set();
  for (let i = 0; i < n; i++) {
    if (visited.has(list[i].id)) continue;
    const q = [list[i]];
    visited.add(list[i].id);
    const comp = [list[i]];
    let qi = 0;
    while (qi < q.length) {
      const b = q[qi++];
      const plainB = beliefListPrimaryLine(b.statement);
      for (let j = 0; j < n; j++) {
        const o = list[j];
        if (visited.has(o.id)) continue;
        const plainO = beliefListPrimaryLine(o.statement);
        if (jaccardSimilarity(plainB, plainO) >= MIN_TOPIC_JACCARD) {
          visited.add(o.id);
          comp.push(o);
          q.push(o);
        }
      }
    }
    comp.sort((a, b) => new Date(b.created_date || 0) - new Date(a.created_date || 0));
    lines.push(comp);
  }
  if (n <= 1 || lines.length <= 1) return lines;
  const singletonRows = lines.filter((g) => g.length === 1).length;
  if (singletonRows / lines.length >= PACK_IF_SINGLETON_ROW_FRAC && n >= 4) {
    const sorted = [...list].sort((a, b) => new Date(b.created_date || 0) - new Date(a.created_date || 0));
    const packed = [];
    for (let i = 0; i < sorted.length; i += PACK_ROW_SIZE) {
      packed.push(sorted.slice(i, i + PACK_ROW_SIZE));
    }
    return packed;
  }
  return lines;
}

/** Categories that appear in `filtered`, in map order, then any unknowns sorted. */
function orderedCategoriesPresent(filtered) {
  const present = new Set(filtered.map((b) => beliefCategoryKey(b)));
  const ordered = [];
  for (const c of CATEGORY_ORDER) {
    if (present.has(c)) ordered.push(c);
  }
  const extras = [...present].filter((c) => !CATEGORY_ORDER.includes(c)).sort();
  return [...ordered, ...extras];
}

/** Common English stopwords — ignored when inferring a thread theme from token overlap. */
const THREAD_TITLE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "is", "are", "was", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "may", "might",
  "must", "can", "need", "that", "this", "these", "those", "it", "its", "they", "them", "their", "there", "here",
  "as", "by", "with", "from", "than", "then", "also", "not", "no", "if", "when", "where", "which", "who", "what",
  "how", "why", "about", "into", "through", "during", "before", "after", "above", "below", "between", "under",
  "again", "further", "once", "all", "each", "every", "both", "few", "more", "most", "other", "some", "such",
  "only", "own", "same", "so", "too", "very", "just", "now", "any", "our", "out", "up", "down", "over", "well",
  "like", "one", "two", "way", "even", "still", "because", "while", "though", "without", "within", "against",
  "among", "per", "via", "etc", "rather", "quite", "into",
]);

function rowTitleTokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !THREAD_TITLE_STOPWORDS.has(w));
}

/**
 * Row title from the whole thread: category + thematic terms inferred from all beliefs
 * (words that recur across beliefs weighted heavily; otherwise strongest terms across the combined text).
 * @param {{ hideCategoryPrefix?: boolean }} [opts] — when true, omit "Category ·" (column header already shows category).
 */
function deriveThreadRowTitle(group, opts = {}) {
  const hideCat = opts.hideCategoryPrefix === true;
  if (!group?.length) return "Beliefs";
  const cat = String(group[0].category || "factual");
  const catLabel = cat.charAt(0).toUpperCase() + cat.slice(1);
  const texts = group
    .map((b) => beliefListPrimaryLine(b.statement).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (texts.length === 0) return hideCat ? "Thread" : `${catLabel} thread`;

  const perBeliefLists = texts.map((t) => rowTitleTokens(t));

  /** @type {Map<string, number>} belief count: in how many beliefs does this token appear */
  const beliefCount = new Map();
  /** @type {Map<string, number>} total token frequency across the thread */
  const totalFreq = new Map();
  for (const list of perBeliefLists) {
    const seenHere = new Set();
    for (const w of list) {
      totalFreq.set(w, (totalFreq.get(w) || 0) + 1);
      if (!seenHere.has(w)) {
        seenHere.add(w);
        beliefCount.set(w, (beliefCount.get(w) || 0) + 1);
      }
    }
  }

  /** @type {Array<{ w: string, score: number, bc: number }>} */
  const scored = [];
  for (const [w, bc] of beliefCount) {
    const tf = totalFreq.get(w) || 0;
    const spreadBoost = bc >= 2 ? bc * 1000 : bc;
    const score = spreadBoost * 10 + tf;
    scored.push({ w, score, bc });
  }
  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    const glue = texts.join(" ").trim();
    const short = glue.length > 72 ? `${glue.slice(0, 69)}…` : glue;
    if (!short) return hideCat ? "Thread" : `${catLabel} thread`;
    return hideCat ? short : `${catLabel} · ${short}`;
  }

  /** Prefer words that appear in 2+ beliefs (shared thread), then add salient words from the whole thread. */
  const picked = new Set();
  const themeWords = [];
  for (const x of scored) {
    if (x.bc >= 2 && themeWords.length < 4) {
      themeWords.push(x.w);
      picked.add(x.w);
    }
  }
  for (const x of scored) {
    if (themeWords.length >= 5) break;
    if (picked.has(x.w)) continue;
    themeWords.push(x.w);
    picked.add(x.w);
  }

  const theme = themeWords.join(", ");
  return hideCat ? theme : `${catLabel} · ${theme}`;
}

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
  /** Added to {@link MAP_CIRCULAR_INITIAL_ZOOM_STEPS} after fit (circular layout only). Negative ≈ extra zoom-out steps; hub stays centered. */
  circularInitialZoomStepDelta = 0,
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

  const drawGraph = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const Wraw = canvas.offsetWidth;

    const filtered =
      filterStatus === "all" ? beliefs : beliefs.filter((b) => beliefStatusForFilter(b) === filterStatus);
    let { scale, tx, ty } = viewRef.current;
    /** Until fit runs, do not use a previous layout's pan/zoom (e.g. grid) or the graph draws off-screen. */
    if (pendingMobileFitRef.current) {
      scale = 1;
      tx = 0;
      ty = 0;
    }

    if (filtered.length === 0) {
      canvas.style.minWidth = "";
      canvas.style.aspectRatio = "";
      canvas.style.maxWidth = "";
      canvas.style.width = "";
      const Wclear = canvas.offsetWidth;
      canvas.width = Wclear;
      canvas.height = 420;
      canvas.style.height = "420px";
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, Wclear, 420);
      graphNodesRef.current = [];
      pendingMobileFitRef.current = false;
      return;
    }

    const orderedCats = orderedCategoriesPresent(filtered);
    const layoutArgs = {
      filtered,
      expandedId,
      orderedCats,
      beliefCategoryKey,
      beliefMapCircleRadius,
      beliefMapNodeFillColor,
      computeLineGroupsForBeliefList,
      deriveThreadRowTitle,
      MAP_MIN_INNER_COL_PX,
    };

    const layout =
      mapLayout === "circular"
        ? buildCircularBorderBeliefMapLayout({ ...layoutArgs, Wraw })
        : buildGridBeliefMapLayout({ ...layoutArgs, Wraw });

    const {
      layoutKind = "grid",
      W,
      H,
      nodes,
      rowLayouts,
      columnHeaders,
      threadPolylines,
      globalBottomY,
      marginTop,
      marginX,
      minRequiredW,
      radialSectors = [],
      cx: layoutCx,
      cy: layoutCy,
      radialRingInnerR = 0,
    } = layout;

    const numCols = orderedCats.length;
    if (layoutKind === "grid" && numCols > 1) {
      canvas.style.minWidth = `${minRequiredW}px`;
    } else {
      canvas.style.minWidth = "";
    }
    canvas.width = W;
    canvas.height = H;
    if (layoutKind === "circular") {
      /** Square bitmap + square CSS box → uniform scale (avoids oval circles on narrow phones). */
      canvas.style.width = "100%";
      canvas.style.height = "auto";
      canvas.style.aspectRatio = `${W} / ${H}`;
      canvas.style.maxWidth = "100%";
    } else {
      canvas.style.width = "";
      canvas.style.height = `${H}px`;
      canvas.style.aspectRatio = "";
      canvas.style.maxWidth = "";
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    ctx.setTransform(scale, 0, 0, scale, tx, ty);

    const invScale = 1 / scale;

    if (layoutKind === "circular" && radialSectors.length > 0) {
      const rcx = layoutCx;
      const rcy = layoutCy;
      for (const rs of radialSectors) {
        ctx.beginPath();
        ctx.arc(rcx, rcy, rs.outerR, rs.theta0, rs.theta1);
        ctx.arc(rcx, rcy, rs.innerR, rs.theta1, rs.theta0, true);
        ctx.closePath();
        ctx.fillStyle = beliefCategoryColorSemiTransparent(rs.key);
        ctx.fill();
      }
      for (const rs of radialSectors) {
        ctx.beginPath();
        ctx.moveTo(
          rcx + rs.innerR * Math.cos(rs.theta0),
          rcy + rs.innerR * Math.sin(rs.theta0)
        );
        ctx.lineTo(
          rcx + rs.outerR * Math.cos(rs.theta0),
          rcy + rs.outerR * Math.sin(rs.theta0)
        );
        ctx.strokeStyle = "rgba(255,255,255,0.1)";
        ctx.lineWidth = Math.max(0.55, 0.85 * invScale);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(rcx, rcy, radialRingInnerR, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.lineWidth = Math.max(0.65, 1 * invScale);
      ctx.stroke();
    }
    const edgeW = Math.max(0.8, 1.5 * invScale);
    const ringW = Math.max(1, 2 * invScale);
    const nodeStroke = Math.max(1, 1.5 * invScale);
    const defaultMaxTitleW = W - marginX * 2;

    ctx.font = `${Math.max(10, 11 * invScale)}px ui-sans-serif, Inter, system-ui, sans-serif`;
    ctx.textBaseline = "middle";

    ctx.textAlign = "center";
    for (const h of columnHeaders) {
      if (layoutKind === "circular" && h.radialAngle != null) {
        ctx.font = `600 ${Math.max(13, 14 * invScale)}px ui-sans-serif, Inter, system-ui, sans-serif`;
        const rot = circularTangentTextRotation(h.radialAngle);
        ctx.save();
        ctx.translate(h.x, h.y);
        ctx.rotate(rot);
        ctx.textBaseline = "middle";
        ctx.fillStyle = `${beliefCategoryColor(h.key)}ee`;
        ctx.fillText(h.label, 0, 0);
        ctx.restore();
      } else {
        ctx.font = `600 ${Math.max(12, 13 * invScale)}px ui-sans-serif, Inter, system-ui, sans-serif`;
        ctx.textBaseline = "middle";
        ctx.fillStyle = `${beliefCategoryColor(h.key)}cc`;
        ctx.fillText(h.label, h.x, h.y);
      }
    }

    ctx.font = `${Math.max(10, 11 * invScale)}px ui-sans-serif, Inter, system-ui, sans-serif`;
    for (const row of rowLayouts) {
      const maxTitleW = row.maxTitleW != null ? row.maxTitleW : defaultMaxTitleW;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      let t = row.title;
      let guard = 0;
      const minTrim = layoutKind === "circular" && row.radialAngle != null ? 8 : 12;
      while (t.length > minTrim && ctx.measureText(t).width > maxTitleW && guard < 120) {
        t = `${t.slice(0, -4)}…`;
        guard += 1;
      }
      if (layoutKind === "circular" && row.radialAngle != null) {
        const rot = circularTangentTextRotation(row.radialAngle);
        ctx.save();
        ctx.translate(row.x, row.y);
        ctx.rotate(rot);
        ctx.fillStyle = "rgba(255,255,255,0.78)";
        ctx.fillText(t, 0, 0);
        ctx.restore();
      } else {
        ctx.textAlign = row.textAlign || "left";
        ctx.fillStyle = "rgba(255,255,255,0.62)";
        ctx.fillText(t, row.x, row.y);
      }
    }
    ctx.textAlign = "left";

    for (const seg of threadPolylines) {
      if (seg.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(seg[0].x, seg[0].y);
      for (let k = 1; k < seg.length; k++) {
        ctx.lineTo(seg[k].x, seg[k].y);
      }
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.lineWidth = Math.max(0.55, 1.05 * invScale);
      ctx.setLineDash([]);
      ctx.stroke();
    }

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

      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + 3 * invScale, 0, Math.PI * 2);
      ctx.strokeStyle = n.color;
      ctx.lineWidth = ringW;
      ctx.stroke();
    });

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    graphNodesRef.current = nodes;
    canvas._nodes = nodes;

    // Initial / reset: fit content bbox into the visible map card.
    // Grid: top-left pan so column headers stay at the top (all viewports). Circular: center the hub.
    if (typeof window !== "undefined" && pendingMobileFitRef.current) {
      const narrowLayout = window.matchMedia("(max-width: 1023px)").matches;
      const parent = canvas.parentElement;
      const innerW = window.visualViewport?.width ?? window.innerWidth;
      const parentW = parent?.clientWidth ?? 0;
      const vw = Math.max(1, parentW > 0 ? Math.min(parentW, innerW) : innerW);
      const parentH = parent?.clientHeight ?? 0;
      const innerH = window.visualViewport?.height ?? window.innerHeight;
      /** Grid on phone: shorter map pane (~⅓ viewport) so the card is not half the screen; circular keeps a taller fit. */
      const vh = narrowLayout
        ? layoutKind === "grid"
          ? Math.max(120, parentH > 0 ? Math.min(parentH, innerH * 0.36) : innerH * 0.34)
          : Math.max(120, parentH > 0 ? Math.min(parentH, innerH * 0.72) : innerH * 0.42)
        : Math.max(160, parentH > 0 ? Math.min(parentH, innerH * 0.9) : innerH * 0.62);

      let bbTop;
      let bbBottom;
      let bbLeft;
      let bbRight;
      if (layoutKind === "circular") {
        bbTop = Infinity;
        bbBottom = -Infinity;
        bbLeft = Infinity;
        bbRight = -Infinity;
      } else {
        const labelTopY = marginTop + 11 - 13;
        bbTop = Math.min(labelTopY, marginTop);
        bbBottom = globalBottomY;
        bbLeft = marginX;
        bbRight = W - marginX;
      }
      for (const row of rowLayouts) {
        bbTop = Math.min(bbTop, row.y - 16);
      }
      if (nodes.length) {
        for (const n of nodes) {
          bbTop = Math.min(bbTop, n.y - n.r - 4);
          bbBottom = Math.max(bbBottom, n.y + n.r + 8);
          bbLeft = Math.min(bbLeft, n.x - n.r - 6);
          bbRight = Math.max(bbRight, n.x + n.r + 6);
        }
      }
      if (layoutKind === "circular" && (!Number.isFinite(bbTop) || nodes.length === 0)) {
        bbTop = 0;
        bbBottom = H;
        bbLeft = 0;
        bbRight = W;
      }
      bbTop = Math.max(0, bbTop - 4);
      bbBottom = Math.min(H, bbBottom + 6);
      bbLeft = Math.max(0, bbLeft - 4);
      bbRight = Math.min(W, bbRight + 4);

      const cw = Math.max(1, bbRight - bbLeft);
      const ch = Math.max(1, bbBottom - bbTop);

      const sw = vw / cw;
      const sh = vh / ch;
      let s = Math.min(1, sw, sh);
      if (layoutKind === "circular") {
        if (!narrowLayout) {
          s = Math.min(1, Math.min(sw, sh) * MAP_CIRCULAR_DESKTOP_FIT_BOOST);
        }
      } else if (!narrowLayout) {
        s = Math.min(1, Math.min(sw, sh) * MAP_DESKTOP_FIT_BOOST, Math.max(sw, sh));
      }
      s = Math.max(MAP_MIN_SCALE, s);

      let tx;
      let ty;
      if (layoutKind === "circular") {
        const centerX = layoutCx != null ? layoutCx : (bbLeft + bbRight) / 2;
        const centerY = layoutCy != null ? layoutCy : (bbTop + bbBottom) / 2;
        tx = W / 2 - centerX * s;
        ty = H / 2 - centerY * s;
      } else {
        tx = MAP_DESKTOP_FIT_PAD - bbLeft * s;
        ty = MAP_DESKTOP_FIT_PAD - bbTop * s;
      }

      if (layoutKind === "circular") {
        const zoomSteps = Math.max(0, MAP_CIRCULAR_INITIAL_ZOOM_STEPS + circularInitialZoomStepDelta);
        const factor = MAP_ZOOM_IN_STEP ** zoomSteps;
        const cx0 = W / 2;
        const cy0 = H / 2;
        const gx = (cx0 - tx) / s;
        const gy = (cy0 - ty) / s;
        const newS = Math.min(MAP_MAX_SCALE, Math.max(MAP_MIN_SCALE, s * factor));
        tx = cx0 - gx * newS;
        ty = cy0 - gy * newS;
        s = newS;
      }

      viewRef.current = { scale: s, tx, ty };
      pendingMobileFitRef.current = false;
      requestAnimationFrame(() => drawGraph());
    }
  }, [beliefs, expandedId, filterStatus, mapLayout, circularInitialZoomStepDelta]);

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
    let rafId = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        drawGraph();
      });
    });
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
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
    if (d.hasPanned) {
      setMapPopup(null);
      return;
    }
    if (moved < 8 && d.hit) {
      const b = d.hit.belief;
      onExpandedIdChange?.(b.id);
      setMapPopup((prev) =>
        prev?.id === b.id
          ? null
          : {
              id: b.id,
              left: e.clientX,
              top: e.clientY,
              text: beliefListPrimaryLine(b.statement).trim() || "—",
              confidence: typeof b.confidence === "number" ? b.confidence : 0.5,
            }
      );
    } else if (moved < 8 && !d.hit) {
      setMapPopup(null);
    }
  }, [onExpandedIdChange]);

  useEffect(() => {
    if (!mapPopup) return;
    const onKey = (ev) => {
      if (ev.key === "Escape") setMapPopup(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mapPopup]);

  useEffect(() => {
    if (!mapPopup) return;
    if (!beliefs.some((b) => b.id === mapPopup.id)) setMapPopup(null);
  }, [beliefs, mapPopup]);

  const isDashboard = variant === "dashboard";

  return (
    <div
      className={cn(
        /* Page: lg:flex-none — with a tall bitmap, lg:flex-1 stretched the card to the full grid row and buried sections below. Dashboard: fill panel. */
        "relative flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card max-lg:flex-none",
        isDashboard ? "lg:flex-1" : "lg:flex-none",
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
          /* Grid: shorter pane on phone. Circular: also cap — uncapped circular bitmap can push the beliefs list thousands of px down (felt “missing” on System B / mirror). */
          !isDashboard &&
            (mapLayout === "grid"
              ? "max-lg:max-h-[min(38svh,520px)] max-lg:overflow-y-auto max-lg:overscroll-contain lg:max-h-[min(56svh,560px)] lg:overflow-y-auto lg:overscroll-contain"
              : "max-lg:max-h-[min(48svh,560px)] max-lg:overflow-y-auto max-lg:overscroll-contain lg:max-h-[min(62svh,640px)] lg:overflow-y-auto lg:overscroll-contain"),
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
          className="pointer-events-auto fixed z-[60] w-[min(22rem,calc(100vw-1.5rem))] max-h-[min(50svh,22rem)] overflow-y-auto rounded-lg border border-border bg-card/95 p-3 pr-10 text-sm shadow-xl backdrop-blur-sm"
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
