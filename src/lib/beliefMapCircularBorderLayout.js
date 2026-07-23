/**
 * Circular “border” map: each belief **thread** is drawn as one or more **arcs** that follow the
 * hub (tangential / 90° from radial spokes). Arc length grows with how many beliefs sit on that
 * row; overflow rows for the same thread stack on **concentric** arcs (larger radius). The next
 * thread starts further out. Connector lines only run along each arc segment.
 */

/** Inner “hub” radius — larger = more open center for category labels and less crowding. */
const R_INNER = 148;
const ANGULAR_PAD = 0.055;
export const CIRCULAR_ADJ_OVERLAP_DRAW = 0.035;
const CANVAS_PAD = 64;
const INNER_PAD = 10;
/** Category name sits in the hub along the sector bisector (fraction of R_INNER). */
const HUB_CATEGORY_LABEL_R_FRAC = 0.44;
const ROW_GAP = 10;
const ROW_OVERLAP_BASE = 0.48;
const ROW_OVERLAP_MIN = 0.14;
/** Extra radial gap before the next thread’s first arc (px). */
const INTER_THREAD_R_GAP = 14;
/** Cap beliefs per arc before stacking outward (blueprint: many in a row, then next row). */
export const MAX_DOTS_PER_ARC_ROW = 10;

/** Equal angular slices so every category wraps the full circle — not proportional to belief count. */
function allocateEqualSectorAngles(n) {
  if (n === 0) return [];
  const each = (2 * Math.PI) / n;
  return Array.from({ length: n }, () => each);
}

/**
 * Minimum center-to-center spacing required between adjacent beliefs (overlap policy).
 */
function minPairSpacing(group, overlapFrac, br) {
  let m = Infinity;
  for (let i = 0; i < group.length - 1; i++) {
    m = Math.min(m, overlapFrac * (br(group[i]) + br(group[i + 1])));
  }
  return m;
}

/**
 * Whether `group` fits on an arc of length `arcLen` when dots are spread from the start of the arc
 * to the end (full-span spacing), not bunched in the middle.
 */
function rowSpreadFits(group, arcLen, overlapFrac, br) {
  const n = group.length;
  if (n === 0) return true;
  const r0 = br(group[0]);
  const rLast = br(group[n - 1]);
  if (n === 1) return arcLen >= 2 * r0 - 1e-6;
  const spacing = (arcLen - r0 - rLast) / (n - 1);
  if (!Number.isFinite(spacing) || spacing < -1e-6) return false;
  return spacing >= minPairSpacing(group, overlapFrac, br) - 1e-6;
}

/**
 * Place centers along the arc starting at `thetaStart` (radians), at radius `r` from (cx, cy).
 * Arc length `arcLen` matches angle span * r. First dot is inset by r0 from the sector edge along the arc.
 */
function placeRowAlongArc(group, arcLen, thetaStart, r, br, cx, cy) {
  const n = group.length;
  const r0 = br(group[0]);
  const rLast = br(group[n - 1]);
  if (n === 1) {
    const b = group[0];
    const rr = br(b);
    const sAlong = r0;
    const angle = thetaStart + sAlong / r;
    return [
      {
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
        r: rr,
        belief: b,
        angle,
        lineR: r,
      },
    ];
  }
  const spacing = (arcLen - r0 - rLast) / (n - 1);
  return group.map((b, i) => {
    const sAlong = r0 + i * spacing;
    const angle = thetaStart + sAlong / r;
    const rr = br(b);
    return {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
      r: rr,
      belief: b,
      angle,
      lineR: r,
    };
  });
}

function overlapFracForRow(group) {
  const n = group.length;
  if (n <= 8) return ROW_OVERLAP_BASE;
  const t = Math.min(1, (n - 8) / 14);
  return ROW_OVERLAP_BASE * (1 - t) + ROW_OVERLAP_MIN * t;
}

/**
 * Largest n ≤ maxTake such that the first n beliefs in `queue` fit on this arc with spread packing.
 */
function maxBeliefsOnArcRow(queue, arcLen, maxTake, br) {
  const cap = Math.min(maxTake, MAX_DOTS_PER_ARC_ROW, queue.length);
  for (let n = cap; n >= 1; n--) {
    const slice = queue.slice(0, n);
    const ov = overlapFracForRow(slice);
    if (rowSpreadFits(slice, arcLen, ov, br)) return n;
  }
  return 0;
}

/**
 * Arc length (px) for a row: prefer a **compact** span (tight overlap) so short threads are short
 * arcs; never wider than the sector chord at this radius. Always ≤ arcLenMax.
 */
function centeredRowArcLength(group, arcLenMax, br) {
  const n = group.length;
  if (n === 0) return 0;
  const r0 = br(group[0]);
  const rLast = br(group[n - 1]);
  if (n === 1) return Math.min(arcLenMax, 2 * r0);
  const ov = overlapFracForRow(group);
  const s50 = minPairSpacing(group, ov, br);
  const compact = r0 + (n - 1) * s50 + rLast;
  if (compact <= arcLenMax + 1e-6) return compact;
  return arcLenMax;
}

/**
 * @param {object} p
 */
export function buildCircularBorderBeliefMapLayout(p) {
  const {
    filtered,
    expandedId,
    orderedCats,
    beliefCategoryKey,
    beliefMapCircleRadius,
    beliefMapNodeFillColor,
    computeLineGroupsForBeliefList,
    deriveThreadRowTitle,
  } = p;

  const br = beliefMapCircleRadius;

  const sectorAngles = allocateEqualSectorAngles(orderedCats.length);

  const nodes = [];
  /** @type {Array<{ title: string, x: number, y: number, maxTitleW?: number, textAlign?: CanvasTextAlign }>} */
  const rowLayouts = [];
  /** @type {Array<{ label: string, key: string, x: number, y: number }>} */
  const columnHeaders = [];
  /** @type {Array<Array<{ x: number, y: number, r: number }>>} */
  const threadPolylines = [];
  /** @type {Array<{ key: string, theta0: number, theta1: number, innerR: number, outerR: number }>} */
  const radialSectors = [];

  let angleCursor = -Math.PI / 2;

  const cx0 = 400;
  const cy0 = 400;

  for (let si = 0; si < orderedCats.length; si++) {
    const cat = orderedCats[si];
    const sectorSweep = sectorAngles[si];
    const sectorStart = angleCursor;
    const sectorEnd = angleCursor + sectorSweep;
    const angularInset = Math.min(ANGULAR_PAD, sectorSweep * 0.045);
    const thetaStart = sectorStart + angularInset;
    const thetaEnd = sectorEnd - angularInset;
    const spanTheta = Math.max(1e-3, thetaEnd - thetaStart);
    const midAngle = (thetaStart + thetaEnd) / 2;

    const catBeliefs = filtered.filter((b) => beliefCategoryKey(b) === cat);
    const lineGroups = computeLineGroupsForBeliefList(catBeliefs);

    let rCursor = R_INNER + INNER_PAD;
    let sectorMaxR = rCursor;

    const hubLabelR = R_INNER * HUB_CATEGORY_LABEL_R_FRAC;
    columnHeaders.push({
      label: cat.charAt(0).toUpperCase() + cat.slice(1),
      key: cat,
      x: cx0 + hubLabelR * Math.cos(midAngle),
      y: cy0 + hubLabelR * Math.sin(midAngle),
      radialAngle: midAngle,
    });

    for (let gi = 0; gi < lineGroups.length; gi++) {
      const group = lineGroups[gi];
      if (group.length === 0) continue;

      if (gi > 0) {
        rCursor = sectorMaxR + INTER_THREAD_R_GAP;
      }

      const title = deriveThreadRowTitle(group, { hideCategoryPrefix: orderedCats.length > 1 });
      const remaining = [...group];
      let threadStarted = false;

      while (remaining.length) {
        let placed = false;
        for (let guard = 0; guard < 600 && !placed; guard++) {
          const arcLenTotal = spanTheta * rCursor;
          if (arcLenTotal <= 1e-3) {
            rCursor += 8;
            sectorMaxR = Math.max(sectorMaxR, rCursor);
            continue;
          }

          const nTake = maxBeliefsOnArcRow(remaining, arcLenTotal, remaining.length, br);
          if (nTake > 0) {
            const row = remaining.splice(0, nTake);
            const L = centeredRowArcLength(row, arcLenTotal, br);
            const thetaRowStart = midAngle - L / (2 * rCursor);
            const pts = placeRowAlongArc(row, L, thetaRowStart, rCursor, br, cx0, cy0);
            let maxRowR = 8;
            for (const b of row) maxRowR = Math.max(maxRowR, br(b));

            if (!threadStarted) {
              threadStarted = true;
              const titleR = Math.max(R_INNER * 0.58, rCursor - maxRowR - 22);
              const tx = cx0 + titleR * Math.cos(midAngle);
              const ty = cy0 + titleR * Math.sin(midAngle);
              const sectorArcPx = spanTheta * Math.max(titleR, rCursor);
              rowLayouts.push({
                title,
                x: tx,
                y: ty,
                maxTitleW: Math.min(320, Math.max(120, sectorArcPx * 0.42)),
                textAlign: "center",
                radialAngle: midAngle,
              });
            }

            for (const pt of pts) {
              const b = pt.belief;
              nodes.push({
                id: b.id,
                x: pt.x,
                y: pt.y,
                r: pt.r,
                color: beliefMapNodeFillColor(b),
                belief: b,
                isContradicted: b.status === "contradicted" || (b.contradicts?.length > 0),
                isSelected: expandedId === b.id,
              });
            }

            if (pts.length >= 2) {
              threadPolylines.push(pts.map((p) => ({ x: p.x, y: p.y, r: p.r })));
            }

            sectorMaxR = Math.max(sectorMaxR, rCursor + maxRowR);
            rCursor += maxRowR + ROW_GAP;
            placed = true;
          } else {
            rCursor += 6;
            sectorMaxR = Math.max(sectorMaxR, rCursor);
          }
        }
        if (!placed) break;
      }
    }

    radialSectors.push({
      key: cat,
      theta0: sectorStart,
      theta1: sectorEnd,
      innerR: R_INNER,
      outerR: sectorMaxR + 8,
    });

    angleCursor = sectorEnd;
  }

  let maxAbs = R_INNER;
  for (const n of nodes) {
    maxAbs = Math.max(maxAbs, Math.hypot(n.x - cx0, n.y - cy0) + n.r);
  }
  const extent = maxAbs + CANVAS_PAD;
  const W = Math.ceil(2 * extent);
  const H = Math.ceil(2 * extent);
  const cx = W / 2;
  const cy = H / 2;
  const dx = cx - cx0;
  const dy = cy - cy0;

  for (const n of nodes) {
    n.x += dx;
    n.y += dy;
  }
  for (const h of columnHeaders) {
    h.x += dx;
    h.y += dy;
  }
  for (const row of rowLayouts) {
    row.x += dx;
    row.y += dy;
  }
  for (const seg of threadPolylines) {
    for (const p of seg) {
      p.x += dx;
      p.y += dy;
    }
  }

  let radialRingOuterR = R_INNER;
  for (const rs of radialSectors) {
    radialRingOuterR = Math.max(radialRingOuterR, rs.outerR);
  }

  return {
    layoutKind: "circular",
    W,
    H,
    minRequiredW: 0,
    nodes,
    rowLayouts,
    columnHeaders,
    threadPolylines,
    globalBottomY: H - CANVAS_PAD,
    marginTop: CANVAS_PAD,
    marginX: CANVAS_PAD,
    radialSectors,
    cx,
    cy,
    radialRingOuterR,
    radialRingInnerR: R_INNER,
    ADJ_OVERLAP_DRAW: CIRCULAR_ADJ_OVERLAP_DRAW,
  };
}
