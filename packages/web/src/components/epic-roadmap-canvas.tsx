import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Network } from "lucide-react";
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  useReactFlow,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useEpicGraph } from "@/hooks/use-epic-graph";
import { useMilestones } from "@/hooks/use-milestones";
import { computeEpicGraphLayout } from "@/lib/epic-graph-layout";
import { computeChain, edgeKey } from "@/lib/epic-graph-chain";
import { getEdgeStyling } from "@/lib/epic-graph-style";
import { partitionEpics, recedeOpacity } from "@/lib/epic-graph-recency";
import { EpicNode, type EpicNodeData } from "@/components/epic-node";
import { MilestoneGuides } from "@/components/milestone-guides";
import { EpicTasksPanel } from "@/components/epic-tasks-panel";
import { CategoryLegend } from "@/components/category-legend";
import { useProject } from "@/hooks/use-projects";
import { epicCategoriesFromProject } from "@/lib/epic-categories";

// Caps fit-zoom so sparse graphs don't balloon; manual zoom unaffected.
const ROADMAP_FIT_OPTIONS = { padding: 0.2, maxZoom: 0.65 } as const;

// Stable empty-set reference: handed to the layout as `unscheduledIds` while
// the Backlog rail is collapsed, so the layout memo's dep stays referentially
// stable across renders (no spurious reflow).
const EMPTY_SET: ReadonlySet<string> = new Set();

// Synthetic key folding both "no category" and "unknown category name" into one
// bucket for color + filter + legend. Module-level so it's a stable reference.
const UNCATEGORIZED = "__uncategorized__";

// Field-by-field equality for a node's render-affecting data. `byStatus` is a
// reference compare on purpose — it's stable per graph payload (a hover never
// re-fetches), so only an actual data change (e.g. `dimmed` flipping) trips it.
// This is what lets the per-id cache below hand ReactFlow a STABLE node object
// when nothing visible changed, so unchanged nodes don't re-render on hover.
function sameEpicNodeData(a: EpicNodeData, b: EpicNodeData): boolean {
  return (
    a.name === b.name &&
    a.done === b.done &&
    a.total === b.total &&
    a.progressPct === b.progressPct &&
    a.health === b.health &&
    a.byStatus === b.byStatus &&
    a.dimmed === b.dimmed &&
    a.inCycle === b.inCycle &&
    a.recede === b.recede &&
    a.categoryColor === b.categoryColor
  );
}

// ---- Rail (Past / Backlog) ----

// A corner toggle that collapses a side-bucket of epics behind a chip — "N
// older" for the bottom-left Past rail, "N unscheduled" for the bottom-right
// future Backlog rail. On toggle it re-frames the camera to fit ALL currently
// visible nodes (the declarative `fitView` prop owns only the INITIAL frame);
// since each toggle reflows the layout, re-fitting everything reveals the newly
// shown block and re-frames the remainder on collapse. The mount guard skips
// the first effect run so StrictMode's mount/remount and the first real toggle
// behave; the camera is keyed on `expanded` alone.
function RailPanel({
  position,
  count,
  expanded,
  onToggle,
  collapsedLabel,
  expandedLabel,
}: {
  position: "bottom-left" | "bottom-right";
  count: number;
  expanded: boolean;
  onToggle: () => void;
  collapsedLabel: string;
  expandedLabel: string;
}) {
  const { fitView } = useReactFlow();
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return; // skip mount; declarative prop owns initial frame
    }
    const raf = requestAnimationFrame(() => {
      fitView({ ...ROADMAP_FIT_OPTIONS, duration: 400 }); // re-fit all visible nodes
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on `expanded` intentionally; fitView is read at toggle time.
  }, [expanded]);

  if (count === 0) return null;
  return (
    <Panel position={position}>
      <Button variant="outline" size="sm" onClick={onToggle}>
        {expanded ? expandedLabel : collapsedLabel}
      </Button>
    </Panel>
  );
}

// ---- Canvas ----

export function EpicRoadmapCanvas({
  projectId,
  variant = "full",
}: {
  projectId: string | undefined;
  variant?: "full" | "compact";
}) {
  const { data: graph, isLoading, error, refetch } = useEpicGraph(projectId);
  const { data: milestones } = useMilestones(projectId);
  const { data: project } = useProject(projectId);

  // Category name -> color, referentially stable per project so the closures and
  // memos below don't churn on unrelated renders.
  const colorMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of epicCategoriesFromProject(project)) m.set(c.name, c.color);
    return m;
  }, [project]);

  // Folds an epic's category into a stable filter/color key: a known defined
  // category keeps its name; absent OR unknown names collapse to UNCATEGORIZED.
  const categoryKey = useCallback(
    (n: { category?: string | null }) =>
      n.category && colorMap.has(n.category) ? n.category : UNCATEGORIZED,
    [colorMap],
  );

  // Categories the user has toggled off in the legend (hidden from the DAG).
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(() => new Set());

  // The hovered epic drives the dependency-chain highlight (null = no focus).
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Whether the collapsed "done-and-old" Past rail is expanded into the canvas.
  const [showPast, setShowPast] = useState(false);

  // Whether the collapsed future "Backlog" rail (unscheduled epics) is expanded.
  const [showBacklog, setShowBacklog] = useState(false);

  // The epic whose task mini-DAG panel is open (null = none). Clicking the same
  // epic again toggles the panel closed.
  const [selectedEpicId, setSelectedEpicId] = useState<string | null>(null);

  const nodeTypes = useMemo(() => ({ epic: EpicNode }), []);

  // One injected clock drives layout, partition, and recede — the component is
  // impure (real clock) while every helper it calls stays pure. The clock is
  // re-sampled when a new graph payload arrives so recede/partition track the
  // freshly-fetched data (intentional `graph` dep, not read in the body).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date().toISOString(), [graph]);

  // Split into active vs the receded Past rail vs the future Backlog rail. Each
  // rail's count drives its toggle; expanding a rail folds its bucket back into
  // the laid-out set (reflow-on-toggle is intended).
  const partition = useMemo(() => partitionEpics(graph?.nodes ?? [], { now }), [graph, now]);

  // The rail-composed set: active, plus the past bucket when its rail is
  // expanded, plus the unscheduled bucket when its rail is. This is the
  // PRE-filter set (the legend reads it so toggling a category off doesn't drop
  // its own legend row).
  const railComposed = useMemo(
    () => [
      ...partition.active,
      ...(showPast ? partition.past : []),
      ...(showBacklog ? partition.unscheduled : []),
    ],
    [partition, showPast, showBacklog],
  );

  // The nodes handed to the layout: railComposed minus any category the user has
  // hidden via the legend. No hidden categories → the same reference as
  // railComposed (byte-identical to pre-filter behavior).
  const nodesForLayout = useMemo(
    () =>
      hiddenCategories.size === 0
        ? railComposed
        : railComposed.filter((n) => !hiddenCategories.has(categoryKey(n))),
    [railComposed, hiddenCategories, categoryKey],
  );

  // Ids the layout should pull into the future Backlog zone. Collapsed → the
  // stable empty set so the layout stays byte-identical and the memo dep doesn't
  // churn. Expanded → derived from the FILTERED nodesForLayout (a subset, so the
  // layout never gets an id it wasn't given). Predicate matches partitionEpics's
  // unscheduled bucket exactly (not_started + no end date).
  const unscheduledIds = useMemo(() => {
    if (!showBacklog) return EMPTY_SET;
    const ids = new Set<string>();
    for (const n of nodesForLayout)
      if (n.health === "not_started" && n.time_window.end == null) ids.add(n.id);
    return ids;
  }, [showBacklog, nodesForLayout]);

  const layout = useMemo(
    () =>
      computeEpicGraphLayout(nodesForLayout, graph?.edges ?? [], {
        now,
        unscheduledIds,
      }),
    [nodesForLayout, graph, now, unscheduledIds],
  );

  // Vertical span for the milestone/today guides: tall enough to bracket every
  // rendered lane plus padding above and below. Derived from the laid-out node
  // y-values (fallbacks cover the empty-positions case).
  const { yTop, ySpan } = useMemo(() => {
    const ys = Array.from(layout.positions.values(), (p) => p.y);
    if (ys.length === 0) {
      const fallbackSpan = layout.laneCount * 90 + 600;
      return { yTop: -200, ySpan: fallbackSpan };
    }
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return { yTop: minY - 100, ySpan: maxY - minY + 300 };
  }, [layout]);

  // Cycle members (from the payload) get marked; `?? []` guards the optional
  // `cycles` field (fixtures may omit it).
  const cycleIds = useMemo(() => new Set(graph?.cycles?.flat() ?? []), [graph]);

  // Backwards-in-time edges, keyed by node PAIR (from->to WITHOUT
  // dependency_type) — backwards is a property of the time relationship between
  // two epics, and the layout only flags `blocks` edges.
  const backwardsKeys = useMemo(
    () => new Set(layout.backwardsEdges.map((b) => `${b.from}->${b.to}`)),
    [layout],
  );

  // The dependency chain through the hovered node (null when nothing hovered).
  const chain = useMemo(
    () => (focusedId ? computeChain(focusedId, graph?.edges ?? []) : null),
    [graph, focusedId],
  );

  // Per-id object cache: a hover only flips `dimmed` on the nodes entering/leaving
  // the chain, but the array rebuilds every time. Reusing the prior node object
  // when nothing visible changed keeps its reference STABLE, so ReactFlow (and
  // memo(EpicNode)) skip re-rendering unchanged nodes — the cost of a hover then
  // scales with how many nodes actually changed, not the whole graph. Matters at
  // game_one's 49-and-growing epics.
  const nodeCacheRef = useRef(new Map<string, Node<EpicNodeData>>());

  const rfNodes = useMemo<Node<EpicNodeData>[]>(() => {
    if (!graph) return [];
    const cache = nodeCacheRef.current;
    const seen = new Set<string>();
    const next = nodesForLayout.map((n) => {
      seen.add(n.id);
      const { total, done } = n.taskSummary;
      // Position objects are reference-stable while `layout` is unchanged, so the
      // identity check below holds across hovers and only breaks on a real reflow.
      const position = layout.positions.get(n.id) ?? { x: 0, y: 0 };
      // Only a defined (known) category gets an accent; unknown/absent → none.
      const categoryColor = n.category ? colorMap.get(n.category) : undefined;
      const data: EpicNodeData = {
        name: n.name,
        done,
        total,
        progressPct: total > 0 ? Math.round((done / total) * 100) : 0,
        health: n.health,
        byStatus: n.taskSummary.byStatus,
        dimmed: chain ? !chain.nodeIds.has(n.id) : false,
        inCycle: cycleIds.has(n.id),
        recede: recedeOpacity(n.activity_recency, { now }),
        categoryColor,
      };
      const prev = cache.get(n.id);
      if (prev && prev.position === position && sameEpicNodeData(prev.data, data)) {
        return prev; // unchanged → reuse reference so ReactFlow skips it
      }
      const node: Node<EpicNodeData> = { id: n.id, type: "epic", position, data };
      cache.set(n.id, node);
      return node;
    });
    // Drop cache entries for nodes no longer rendered (e.g. collapsed Past rail).
    for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
    return next;
  }, [graph, nodesForLayout, layout, chain, cycleIds, now, colorMap]);

  // Same stable-reference cache for edges. An edge's visual is fully determined
  // by (provenance, isBackwards, highlightState), so a one-line signature decides
  // reuse — unchanged edges keep their reference and ReactFlow skips them.
  const edgeCacheRef = useRef(new Map<string, { sig: string; edge: Edge }>());

  const rfEdges = useMemo<Edge[]>(() => {
    if (!graph) return [];
    const cache = edgeCacheRef.current;
    // Only edges whose BOTH endpoints are currently rendered survive (a
    // collapsed Past rail removes nodes; dangling edges must not be drawn).
    const renderedIds = new Set(nodesForLayout.map((n) => n.id));
    const seen = new Set<string>();
    const next = graph.edges
      .filter((e) => renderedIds.has(e.from) && renderedIds.has(e.to))
      .map((e) => {
        const key = edgeKey(e);
        seen.add(key);
        const isBackwards = backwardsKeys.has(`${e.from}->${e.to}`);
        const highlightState = chain
          ? chain.edgeKeys.has(key)
            ? "highlighted"
            : "dimmed"
          : "none";
        const sig = `${e.provenance}|${isBackwards}|${highlightState}`;
        const cached = cache.get(key);
        if (cached && cached.sig === sig) return cached.edge; // unchanged → reuse
        const edge: Edge = {
          id: key,
          source: e.from,
          target: e.to,
          ...getEdgeStyling({ provenance: e.provenance, isBackwards, highlightState }),
        };
        cache.set(key, { sig, edge });
        return edge;
      });
    for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
    return next;
  }, [graph, nodesForLayout, chain, backwardsKeys]);

  // Legend rows: only categories actually present in the PRE-filter railComposed
  // set, in sort_order, plus an Uncategorized row iff any present node folds to
  // it. Reading railComposed (not nodesForLayout) keeps a toggled-off category's
  // own row in the legend so it can be toggled back on.
  const legendRows = useMemo(() => {
    const present = new Set(railComposed.map((n) => categoryKey(n)));
    const defined = epicCategoriesFromProject(project)
      .filter((c) => present.has(c.name))
      .map((c) => ({ key: c.name, name: c.name, color: c.color as string | undefined }));
    const hasUncat = present.has(UNCATEGORIZED);
    return hasUncat
      ? [...defined, { key: UNCATEGORIZED, name: "Uncategorized", color: undefined }]
      : defined;
  }, [railComposed, project, categoryKey]);

  // The legend is only worth showing when at least one DEFINED category is
  // present (an all-uncategorized roadmap has nothing meaningful to filter by).
  const hasDefinedPresent = legendRows.some((r) => r.key !== UNCATEGORIZED);

  const toggleCategory = useCallback(
    (key: string) =>
      setHiddenCategories((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-variant={variant}>
      {/* Error state */}
      {error && (
        <div className="border-destructive/50 bg-destructive/10 flex flex-col items-center gap-3 rounded-lg border py-8">
          <p className="text-destructive text-sm">Failed to load roadmap.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="min-h-0 flex-1 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && graph && graph.nodes.length === 0 && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-lg border border-dashed py-12">
          <Network className="text-muted-foreground/40 mb-3 size-10" />
          <p className="text-muted-foreground text-sm">No epics in this roadmap yet.</p>
          <p className="text-muted-foreground/70 mt-1 text-xs">
            Create epics to see them on the timeline.
          </p>
        </div>
      )}

      {/* Canvas */}
      {!isLoading && graph && graph.nodes.length > 0 && (
        <div className="relative min-h-0 flex-1 rounded-lg border">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) =>
              setSelectedEpicId((cur) => (cur === node.id ? null : node.id))
            }
            onNodeMouseEnter={(_, node) => setFocusedId(node.id)}
            onNodeMouseLeave={() => setFocusedId(null)}
            fitView
            fitViewOptions={ROADMAP_FIT_OPTIONS}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            {variant !== "compact" && <Controls />}
            {variant !== "compact" && hasDefinedPresent && (
              <CategoryLegend
                rows={legendRows}
                hidden={hiddenCategories}
                onToggle={toggleCategory}
              />
            )}
            <MilestoneGuides
              scale={layout.scale}
              milestones={milestones ?? []}
              yTop={yTop}
              ySpan={ySpan}
            />
            {graph.hasCycle && (
              <Panel position="top-center">
                <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-700 dark:text-amber-400">
                  ⚠ {graph.cycles?.length ?? 1} dependency cycle(s) detected — some epics block each
                  other
                </div>
              </Panel>
            )}
            <RailPanel
              position="bottom-left"
              count={partition.past.length}
              expanded={showPast}
              onToggle={() => setShowPast((v) => !v)}
              collapsedLabel={`${partition.past.length} older`}
              expandedLabel="Hide past"
            />
            <RailPanel
              position="bottom-right"
              count={partition.unscheduled.length}
              expanded={showBacklog}
              onToggle={() => setShowBacklog((v) => !v)}
              collapsedLabel={`${partition.unscheduled.length} unscheduled`}
              expandedLabel="Hide backlog"
            />
          </ReactFlow>
          {selectedEpicId && (
            <EpicTasksPanel
              projectId={projectId}
              epicId={selectedEpicId}
              epicName={graph?.nodes.find((n) => n.id === selectedEpicId)?.name ?? ""}
              onClose={() => setSelectedEpicId(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
