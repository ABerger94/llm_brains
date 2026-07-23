/**
 * Column / grid belief map layout (original map).
 * @param {object} p
 * @param {import('../lib/data').Belief[]} p.filtered
 * @param {string|null} p.expandedId
 * @param {string[]} p.orderedCats
 * @param {number} p.Wraw
 * @param {(b: import('../lib/data').Belief) => string} p.beliefCategoryKey
 * @param {(b: import('../lib/data').Belief) => number} p.beliefMapCircleRadius
 * @param {(b: import('../lib/data').Belief) => string} p.beliefMapNodeFillColor
 * @param {(list: import('../lib/data').Belief[]) => import('../lib/data').Belief[][]} p.computeLineGroupsForBeliefList
 * @param {(group: import('../lib/data').Belief[], opts?: { hideCategoryPrefix?: boolean }) => string} p.deriveThreadRowTitle
 */
export function buildGridBeliefMapLayout(p) {
  const {
    filtered,
    expandedId,
    orderedCats,
    Wraw,
    beliefCategoryKey,
    beliefMapCircleRadius,
    beliefMapNodeFillColor,
    computeLineGroupsForBeliefList,
    deriveThreadRowTitle,
    MAP_MIN_INNER_COL_PX,
  } = p;

  const marginX = p.marginX ?? 52;
  const marginTop = p.marginTop ?? 28;
  const rowGap = p.rowGap ?? 28;
  const TITLE_BAND = p.TITLE_BAND ?? 24;
  const CATEGORY_HEADER_H = p.CATEGORY_HEADER_H ?? 26;
  const colGap = p.colGap ?? 40;
  const innerPad = p.innerPad ?? 6;
  const ROW_OVERLAP_CENTER_FRAC = p.ROW_OVERLAP_CENTER_FRAC ?? 0.5;

  const numCols = orderedCats.length;
  const minRequiredW =
    numCols <= 1 ? 0 : 2 * marginX + numCols * MAP_MIN_INNER_COL_PX + (numCols - 1) * colGap;
  const W = Math.max(Wraw, minRequiredW);
  const usableCanvasW = Math.max(40, W - 2 * marginX);
  const innerColW =
    numCols <= 1 ? usableCanvasW : (usableCanvasW - colGap * (numCols - 1)) / numCols;

  const nodes = [];
  /** @type {Array<{ title: string, x: number, y: number, maxTitleW?: number, textAlign?: CanvasTextAlign }>} */
  const rowLayouts = [];
  /** @type {Array<{ label: string, key: string, x: number, y: number }>} */
  const columnHeaders = [];
  /** @type {Array<Array<{ x: number, y: number, r: number }>>} */
  const threadPolylines = [];

  let globalBottomY = marginTop + CATEGORY_HEADER_H;

  for (let ci = 0; ci < orderedCats.length; ci++) {
    const cat = orderedCats[ci];
    const colLeft = marginX + ci * (innerColW + colGap);
    const colCenterX = colLeft + innerColW / 2;
    const lineGroups = computeLineGroupsForBeliefList(filtered.filter((b) => beliefCategoryKey(b) === cat));

    columnHeaders.push({
      label: cat.charAt(0).toUpperCase() + cat.slice(1),
      key: cat,
      x: colCenterX,
      y: marginTop + 11,
    });

    let yCursor = marginTop + CATEGORY_HEADER_H;
    const usableW = Math.max(40, innerColW - 2 * innerPad);

    for (const group of lineGroups) {
      const rowTop = yCursor;
      const title = deriveThreadRowTitle(group, { hideCategoryPrefix: orderedCats.length > 1 });
      let maxR = 8;
      for (const b of group) {
        maxR = Math.max(maxR, beliefMapCircleRadius(b));
      }
      const n = group.length;
      const r0 = beliefMapCircleRadius(group[0]);
      const rLast = beliefMapCircleRadius(group[n - 1]);
      let spacing = 0;
      if (n <= 1) {
        spacing = 0;
      } else {
        let s50 = Infinity;
        for (let gi = 0; gi < n - 1; gi++) {
          const ri = beliefMapCircleRadius(group[gi]);
          const rj = beliefMapCircleRadius(group[gi + 1]);
          s50 = Math.min(s50, ROW_OVERLAP_CENTER_FRAC * (ri + rj));
        }
        const spanBudget = usableW - r0 - rLast;
        const sMax = spanBudget / (n - 1);
        spacing = Math.min(s50, sMax);
        if (!Number.isFinite(spacing) || spacing <= 0) {
          spacing = s50;
        }
      }
      const startX = n <= 1 ? colCenterX : colCenterX - ((n - 1) * spacing + rLast - r0) / 2;
      const titleY = rowTop + 12;
      const lineY = rowTop + TITLE_BAND + maxR + 8;
      rowLayouts.push({ title, x: colLeft + innerPad, y: titleY, maxTitleW: usableW });
      const seg = [];
      for (let i = 0; i < n; i++) {
        const b = group[i];
        const x = n <= 1 ? colCenterX : startX + i * spacing;
        const r = beliefMapCircleRadius(b);
        const node = {
          id: b.id,
          x,
          y: lineY,
          r,
          color: beliefMapNodeFillColor(b),
          belief: b,
          isContradicted: b.status === "contradicted" || (b.contradicts?.length > 0),
          isSelected: expandedId === b.id,
        };
        nodes.push(node);
        seg.push({ x, y: lineY, r });
      }
      threadPolylines.push(seg);
      yCursor = lineY + maxR + rowGap + 12;
    }

    globalBottomY = Math.max(globalBottomY, yCursor);
  }

  const H = Math.max(420, globalBottomY + marginTop);

  return {
    layoutKind: "grid",
    W,
    H,
    minRequiredW,
    nodes,
    rowLayouts,
    columnHeaders,
    threadPolylines,
    globalBottomY,
    marginTop,
    marginX,
  };
}
