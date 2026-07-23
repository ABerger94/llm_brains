import { useState, useEffect, useCallback, useMemo } from "react";
import { useMindStorageRefresh, notifyMindStorageChanged } from "../lib/mindStorageEvents";
import { useMindScope, useScopedEntities } from "../context/MindScopeContext";
import MindScopeTabs from "../components/MindScopeTabs";
import {
  Network,
  RefreshCw,
  AlertTriangle,
  Loader2,
  Sparkles,
  Unlink,
  Merge,
  Tags,
  ChevronDown,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { suggestContradictionPairs } from "../../shared/beliefContradictionUtils.mjs";
import { splitAggregateBeliefRowsInStore, mergeBeliefsFromRecentPipelineRuns } from "../lib/mindPersistence";
import { consolidateDuplicateBeliefsInStore } from "../lib/consolidateMindEntities";
import { recategorizeAllBeliefsInStore } from "../lib/recategorizeBeliefs";
import { removeBeliefIdFromOthersContradicts } from "../lib/beliefStoreContradictionUtils";
import { beliefListPrimaryLine, beliefStatementAsPlainText } from "../lib/beliefReportParse";
import { toast } from "../components/ui";
import moment from "moment";
import PageDescriptionCollapsible from "../components/PageDescriptionCollapsible";
import BeliefMapCanvas, {
  beliefCategoryColor,
  beliefMapNodeFillColor,
  beliefCategoryKey,
  beliefStatusForFilter,
  orderedCategoriesPresent,
  computeLineGroupsForBeliefList,
} from "../components/beliefMap/BeliefMapCanvas";

/** Stable React key + expanded match — mirror rows may use numeric/string ids interchangeably. */
function beliefStableId(b) {
  const v = b?.id ?? b?._id;
  return v != null && v !== "" ? String(v) : null;
}

export default function BeliefMapPage() {
  const { isMirror } = useMindScope();
  const { BeliefStore, BeliefTension, PipelineRun } = useScopedEntities();
  const [beliefs, setBeliefs] = useState([]);
  const [tensions, setTensions] = useState([]);
  const [extracting, setExtracting] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [recategorizing, setRecategorizing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [filterStatus, setFilterStatus] = useState("all");
  const [tensionFilter, setTensionFilter] = useState("active");

  const [overlapSectionOpen, setOverlapSectionOpen] = useState(false);
  const [worldviewSectionOpen, setWorldviewSectionOpen] = useState(false);
  const [beliefListOpen, setBeliefListOpen] = useState(true);
  /** "all" = full filtered list in store order (recent first); otherwise one map category, threads oldest→newest */
  const [beliefListCategoryKey, setBeliefListCategoryKey] = useState("all");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      /** Split multi-claim rows only; never drop “unparsed” blobs here — mirror rows often contain `BELIEF_REVISIONS` text and would be deleted. */
      await splitAggregateBeliefRowsInStore(400, BeliefStore, { deleteUnparsedModuleBlobs: false });
      const [data, ten] = await Promise.all([
        BeliefStore.listAll("-created_date"),
        BeliefTension.list("-created_date", 120),
      ]);
      setBeliefs(data);
      setTensions(ten);
    } finally {
      setLoading(false);
    }
  }, [BeliefStore, BeliefTension]);

  useEffect(() => {
    load();
  }, [load]);

  useMindStorageRefresh(load);

  const markBeliefResolved = async (id) => {
    await BeliefStore.update(id, { status: "resolved", contradicts: [] });
    await removeBeliefIdFromOthersContradicts(id, 400, BeliefStore);
    await load();
    notifyMindStorageChanged({ source: "beliefs" });
  };

  const markBeliefActive = async (id) => {
    await BeliefStore.update(id, { status: "active" });
    await load();
    notifyMindStorageChanged({ source: "beliefs" });
  };


  const setTensionState = async (row, tension_state) => {
    await BeliefTension.update(row.id, { tension_state });
    await load();
    notifyMindStorageChanged({ source: "belief-tension" });
  };

  const extractBeliefs = async () => {
    setExtracting(true);
    try {
      await mergeBeliefsFromRecentPipelineRuns({ beliefStore: BeliefStore, pipelineRun: PipelineRun });
      await load();
    } finally {
      setExtracting(false);
    }
  };

  const onConsolidateBeliefs = async () => {
    setConsolidating(true);
    try {
      const result = await consolidateDuplicateBeliefsInStore();
      toast({ title: "Beliefs consolidated", description: result.message });
      await load();
    } catch (e) {
      toast({
        title: "Consolidate failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setConsolidating(false);
    }
  };

  const onRecategorizeBeliefs = async () => {
    setRecategorizing(true);
    try {
      const result = await recategorizeAllBeliefsInStore();
      toast({ title: "Beliefs recategorized", description: result.message });
      await load();
    } catch (e) {
      toast({
        title: "Recategorize failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setRecategorizing(false);
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

  const beliefListCategoriesPresent = useMemo(() => orderedCategoriesPresent(filtered), [filtered]);

  useEffect(() => {
    if (beliefListCategoryKey === "all") return;
    const n = filtered.filter((b) => beliefCategoryKey(b) === beliefListCategoryKey).length;
    if (n === 0) setBeliefListCategoryKey("all");
  }, [filtered, beliefListCategoryKey]);

  const sortedFilteredBeliefs = useMemo(() => {
    if (beliefListCategoryKey === "all") {
      return [...filtered];
    }
    const inCat = filtered.filter((b) => beliefCategoryKey(b) === beliefListCategoryKey);
    const lineGroups = computeLineGroupsForBeliefList(inCat);
    const out = [];
    for (const group of lineGroups) {
      const oldestFirst = [...group].sort(
        (a, b) => new Date(a.created_date || 0) - new Date(b.created_date || 0)
      );
      out.push(...oldestFirst);
    }
    return out;
  }, [filtered, beliefListCategoryKey]);

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
    <div className="flex w-full min-w-0 flex-col bg-background p-4 text-foreground sm:p-6">
      <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <MindScopeTabs />
              {isMirror ? (
                <span className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
                  System B mirror store
                </span>
              ) : null}
            </div>
            <h1 className="text-2xl font-bold text-foreground flex flex-wrap items-center gap-2">
              <Network className="w-6 h-6 text-green-400" /> Belief Map
            </h1>
            <PageDescriptionCollapsible className="mt-1" maxWidthClass="max-w-none">
              One node per atomic belief — scroll to zoom, drag to pan. Node size = confidence, red edges = contradictions.
              When the graph pipeline&apos;s Belief Store module emits{' '}
              <span className="font-mono text-[11px] text-foreground/75">BELIEF_REVISIONS</span> with{' '}
              <span className="text-foreground/85">strengthen</span> or <span className="text-foreground/85">reinforce</span>, matching
              rows update here (confidence and <span className="text-foreground/85">times reinforced</span>). The same module ends
              with <span className="font-mono text-[11px] text-foreground/75">EPISTEMIC_CLAIMS</span> for provenance-tagged claims
              Voice and Narrative can use.
            </PageDescriptionCollapsible>
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => void extractBeliefs()}
              disabled={isMirror || extracting || loading || consolidating || recategorizing}
              className="gap-2"
              title={isMirror ? "Available on Primary only" : undefined}
            >
              {extracting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              Extract from Pipeline
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void onConsolidateBeliefs()}
              disabled={isMirror || consolidating || loading || extracting || recategorizing}
              className="gap-2"
              title={
                isMirror
                  ? "Primary mind only"
                  : "Merge duplicate or near-duplicate beliefs already in the store"
              }
            >
              {consolidating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Merge className="w-3 h-3" />}
              Consolidate beliefs
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void onRecategorizeBeliefs()}
              disabled={isMirror || recategorizing || loading || extracting || consolidating}
              className="gap-2"
              title={
                isMirror
                  ? "Primary mind only"
                  : "Assign factual / normative / self / causal / predictive to every belief (batched LLM)"
              }
            >
              {recategorizing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Tags className="w-3 h-3" />}
              Recategorize beliefs
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

        {/*
          DOM: map then beliefs so lg grid places them side-by-side (cols 1–2 | 3) without a gap.
          Mobile: max-lg:order reverses so the list stays above the map.
          Lower sections stay outside this grid wrapper.
        */}
        <div className="w-full min-w-0">
          <div className="grid min-h-0 grid-cols-1 gap-6 pb-2 lg:grid-cols-3 lg:items-start lg:pb-4">
          <div className="min-w-0 max-lg:order-2 lg:col-span-2 lg:flex lg:min-h-0 lg:flex-col">
            <BeliefMapCanvas
              beliefs={beliefs}
              filterStatus={filterStatus}
              expandedId={expandedId}
              onExpandedIdChange={setExpandedId}
              className="min-h-[420px] lg:min-h-[min(520px,56svh)]"
            />
          </div>

          <div className="flex min-h-0 w-full min-w-0 max-lg:order-1 flex-col overflow-hidden rounded-xl border border-border bg-card lg:sticky lg:top-4 lg:z-10 lg:col-span-1 lg:max-h-[min(600px,70svh)] lg:self-start lg:bg-card">
            <button
              type="button"
              onClick={() => setBeliefListOpen((o) => !o)}
              className="flex w-full items-center justify-between gap-2 text-left px-3 py-2.5 border-b border-border/80 hover:bg-muted/40 transition-colors shrink-0"
              aria-expanded={beliefListOpen}
            >
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-foreground">Beliefs</h2>
                <p className="text-[11px] text-muted-foreground">{filtered.length} shown · one row per belief</p>
              </div>
              <ChevronDown
                className={cn(
                  "h-5 w-5 shrink-0 text-muted-foreground transition-transform",
                  beliefListOpen ? "rotate-0" : "-rotate-90"
                )}
                aria-hidden
              />
            </button>
            {beliefListOpen ? (
              <div className="px-3 py-2 border-b border-border/60 bg-muted/20 shrink-0 space-y-1.5">
                <p className="text-[11px] text-muted-foreground">Category</p>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setBeliefListCategoryKey("all")}
                    className={cn(
                      "px-2.5 py-1 rounded-full text-[11px] border transition-colors",
                      beliefListCategoryKey === "all"
                        ? "bg-primary/12 border-primary/45 text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/50"
                    )}
                  >
                    All ({filtered.length})
                  </button>
                  {beliefListCategoriesPresent.map((cat) => {
                    const count = filtered.filter((b) => beliefCategoryKey(b) === cat).length;
                    const active = beliefListCategoryKey === cat;
                    const dot = beliefCategoryColor(cat);
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setBeliefListCategoryKey(cat)}
                        className={cn(
                          "px-2.5 py-1 rounded-full text-[11px] border transition-colors capitalize inline-flex items-center gap-1.5",
                          active
                            ? "bg-primary/12 border-primary/45 text-foreground"
                            : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/50"
                        )}
                      >
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: dot }} aria-hidden />
                        {cat} ({count})
                      </button>
                    );
                  })}
                </div>
                {beliefListCategoryKey !== "all" ? (
                  <p className="text-[10px] text-muted-foreground">Threads · oldest first within each thread</p>
                ) : (
                  <p className="text-[10px] text-muted-foreground">Store order · most recently created first</p>
                )}
              </div>
            ) : null}
            {beliefListOpen ? (
              <div
                className={cn(
                  "w-full min-w-0 space-y-3 p-3 pr-2",
                  "max-lg:max-h-[min(52svh,520px)] max-lg:overflow-y-auto max-lg:overscroll-y-contain max-lg:[-webkit-overflow-scrolling:touch]",
                  "lg:min-h-0 lg:max-h-none lg:flex-1 lg:shrink lg:overflow-y-auto lg:overscroll-y-contain lg:[-webkit-overflow-scrolling:touch]"
                )}
              >
            {sortedFilteredBeliefs.map((b, index) => {
              const catColor = beliefCategoryColor(b.category);
              const barColor = beliefMapNodeFillColor(b);
              const sid = beliefStableId(b) ?? `idx-${index}`;
              const rawId = b.id ?? b._id;
              const isExpanded =
                rawId != null && expandedId != null && String(expandedId) === String(rawId);
              return (
                <div
                  key={sid}
                  className={cn(
                    "flex w-full min-w-0 overflow-hidden rounded-lg border border-border/80 text-xs transition-colors",
                    "bg-card max-lg:bg-card lg:bg-card/50",
                    isExpanded ? "border-primary/35 bg-primary/[0.06]" : "",
                    b.status === "contradicted" && "border-destructive/25"
                  )}
                >
                  <div
                    className="w-1 shrink-0 self-stretch min-h-[3rem]"
                    style={{ backgroundColor: barColor }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      role="button"
                      tabIndex={0}
                      className="cursor-pointer p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      onClick={() => setExpandedId(isExpanded ? null : rawId)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setExpandedId(isExpanded ? null : rawId);
                        }
                      }}
                    >
                      <div className="flex items-start gap-2.5">
                        {b.status === "contradicted" ? (
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                        ) : (
                          <span
                            className="mt-1.5 h-2 w-2 shrink-0 rounded-full border border-white/10 shadow-sm"
                            style={{ backgroundColor: barColor }}
                            aria-hidden
                          />
                        )}
                        <p className="min-w-0 flex-1 text-sm leading-relaxed text-foreground/90">
                          {beliefListPrimaryLine(b.statement) || "—"}
                        </p>
                      </div>
                    </div>
                  {isExpanded && (
                    <div className="space-y-3 border-t border-border/40 px-3.5 pb-3.5 pt-0 text-sm">
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
                            onClick={() => void markBeliefActive(rawId)}
                            className="text-xs text-muted-foreground hover:underline"
                          >
                            Mark active
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void markBeliefResolved(rawId)}
                            className="text-emerald-600/90 text-xs hover:underline dark:text-emerald-400/90"
                          >
                            Mark resolved
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => deleteBelief(rawId)}
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
            ) : null}
          </div>
          </div>
        </div>

        <div className="w-full min-w-0">
        <div
          className="mt-10 w-full shrink-0 border-t-2 border-border sm:mt-12"
          role="separator"
          aria-hidden
        />
        <div className="mt-6 space-y-6 scroll-mt-8 bg-background pt-2 sm:mt-8 sm:pt-4">
          <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4">
            <button
              type="button"
              onClick={() => setOverlapSectionOpen((o) => !o)}
              className="flex w-full items-start justify-between gap-3 text-left rounded-md -m-1 p-1 hover:bg-cyan-500/10 transition-colors"
              aria-expanded={overlapSectionOpen}
            >
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-foreground">Overlap & tension candidates</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Heuristic pairs (token overlap / negation hint) — not proof of contradiction. Link nodes to draw red edges on the graph.
                </p>
              </div>
              <ChevronDown
                className={cn(
                  "h-5 w-5 shrink-0 text-muted-foreground transition-transform mt-0.5",
                  overlapSectionOpen ? "rotate-0" : "-rotate-90"
                )}
                aria-hidden
              />
            </button>
            {overlapSectionOpen ? (
              mergeCandidates.length === 0 ? (
                <p className="text-xs text-muted-foreground mt-3">No candidates at current thresholds.</p>
              ) : (
                <ul className="space-y-2 max-h-40 overflow-y-auto mt-3">
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
                        {beliefListPrimaryLine(p.a.statement)}
                      </p>
                      <p className="mt-0.5 text-foreground/85 line-clamp-3 text-sm leading-relaxed">
                        {beliefListPrimaryLine(p.b.statement)}
                      </p>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </div>

          <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
            <button
              type="button"
              onClick={() => setWorldviewSectionOpen((o) => !o)}
              className="flex w-full items-start justify-between gap-3 text-left rounded-md -m-1 p-1 hover:bg-amber-500/10 transition-colors"
              aria-expanded={worldviewSectionOpen}
            >
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-foreground">Open worldview threads</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Tensions from the Contradiction Engine (active / suspended / integrated). Not the same as belief nodes —
                  these are unresolved threads you may revisit after new memories.
                </p>
              </div>
              <ChevronDown
                className={cn(
                  "h-5 w-5 shrink-0 text-muted-foreground transition-transform mt-0.5",
                  worldviewSectionOpen ? "rotate-0" : "-rotate-90"
                )}
                aria-hidden
              />
            </button>
            {worldviewSectionOpen ? (
              <>
                <div className="flex flex-wrap gap-1 mt-3 mb-2">
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
                <div className="space-y-2 max-h-48 overflow-y-auto">
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
              </>
            ) : null}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}