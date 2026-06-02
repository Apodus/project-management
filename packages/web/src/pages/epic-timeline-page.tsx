import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useProject } from "@/hooks/use-projects";
import { useEpicGraph } from "@/hooks/use-epic-graph";
import { useProjectStore } from "@/stores/project-store";
import { computeEpicGraphLayout } from "@/lib/epic-graph-layout";
import { computeChain, edgeKey } from "@/lib/epic-graph-chain";
import { getEdgeStyling } from "@/lib/epic-graph-style";
import { partitionEpics, recedeOpacity } from "@/lib/epic-graph-recency";
import { EpicNode, type EpicNodeData } from "@/components/epic-node";

// ---- Past rail ----

// A bottom-left toggle that collapses "done-and-old" epics behind an "N older"
// chip. On toggle it re-frames the camera (the declarative `fitView` prop owns
// only the INITIAL frame): expand reveals all, collapse re-fits the active set.
// The mount guard skips the first effect run so StrictMode's mount/remount and
// the very first real toggle behave; the camera is keyed on `showPast` alone.
function PastRailPanel({
  pastCount,
  showPast,
  onToggle,
  activeNodeIds,
}: {
  pastCount: number;
  showPast: boolean;
  onToggle: () => void;
  activeNodeIds: string[];
}) {
  const { fitView } = useReactFlow();
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return; // skip mount; declarative prop owns initial frame
    }
    const raf = requestAnimationFrame(() => {
      if (showPast)
        fitView({ duration: 400 }); // EXPAND -> reveal all
      else fitView({ nodes: activeNodeIds.map((id) => ({ id })), duration: 400 }); // COLLAPSE -> frame active
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on showPast intentionally; fitView/activeNodeIds are read at toggle time.
  }, [showPast]);

  if (pastCount === 0) return null;
  return (
    <Panel position="bottom-left">
      <Button variant="outline" size="sm" onClick={onToggle}>
        {showPast ? "Hide past" : `${pastCount} older`}
      </Button>
    </Panel>
  );
}

// ---- Main page ----

export function EpicTimelinePage() {
  const { projectId } = useParams({ strict: false });
  const navigate = useNavigate();
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  const { data: project } = useProject(projectId);
  useEffect(() => {
    if (project) {
      setCurrentProject(project.id, project.name);
    }
  }, [project, setCurrentProject]);

  const { data: graph, isLoading, error, refetch } = useEpicGraph(projectId);

  // The hovered epic drives the dependency-chain highlight (null = no focus).
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Whether the collapsed "done-and-old" Past rail is expanded into the canvas.
  const [showPast, setShowPast] = useState(false);

  const nodeTypes = useMemo(() => ({ epic: EpicNode }), []);

  // One injected clock drives layout, partition, and recede — the page is
  // impure (real clock) while every helper it calls stays pure. The clock is
  // re-sampled when a new graph payload arrives so recede/partition track the
  // freshly-fetched data (intentional `graph` dep, not read in the body).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date().toISOString(), [graph]);

  // Split into active vs the receded Past rail. The rail's count drives the
  // toggle; the active set is what the camera re-frames on collapse.
  const partition = useMemo(() => partitionEpics(graph?.nodes ?? [], { now }), [graph, now]);

  // When the rail is collapsed we lay out / render only the active epics; when
  // expanded the full graph comes back (reflow-on-toggle is intended).
  const nodesForLayout = useMemo(
    () => (showPast ? (graph?.nodes ?? []) : partition.active),
    [showPast, graph, partition],
  );

  const layout = useMemo(
    () =>
      computeEpicGraphLayout(nodesForLayout, graph?.edges ?? [], {
        now,
      }),
    [nodesForLayout, graph, now],
  );

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

  const rfNodes = useMemo<Node<EpicNodeData>[]>(() => {
    if (!graph) return [];
    return nodesForLayout.map((n) => {
      const { total, done } = n.taskSummary;
      return {
        id: n.id,
        type: "epic",
        position: layout.positions.get(n.id) ?? { x: 0, y: 0 },
        data: {
          name: n.name,
          done,
          total,
          progressPct: total > 0 ? Math.round((done / total) * 100) : 0,
          health: n.health,
          byStatus: n.taskSummary.byStatus,
          dimmed: chain ? !chain.nodeIds.has(n.id) : false,
          inCycle: cycleIds.has(n.id),
          recede: recedeOpacity(n.activity_recency, { now }),
        },
      };
    });
  }, [graph, nodesForLayout, layout, chain, cycleIds, now]);

  const rfEdges = useMemo<Edge[]>(() => {
    if (!graph) return [];
    // Only edges whose BOTH endpoints are currently rendered survive (a
    // collapsed Past rail removes nodes; dangling edges must not be drawn).
    const renderedIds = new Set(nodesForLayout.map((n) => n.id));
    return graph.edges
      .filter((e) => renderedIds.has(e.from) && renderedIds.has(e.to))
      .map((e) => {
        const key = edgeKey(e);
        const isBackwards = backwardsKeys.has(`${e.from}->${e.to}`);
        const highlightState = chain
          ? chain.edgeKeys.has(key)
            ? "highlighted"
            : "dimmed"
          : "none";
        return {
          id: key,
          source: e.from,
          target: e.to,
          ...getEdgeStyling({
            provenance: e.provenance,
            isBackwards,
            highlightState,
          }),
        };
      });
  }, [graph, nodesForLayout, chain, backwardsKeys]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <Network className="text-muted-foreground size-6" />
        <h1 className="text-2xl font-bold tracking-tight">Roadmap</h1>
        {project && (
          <Badge variant="outline" className="text-xs font-normal">
            {project.name}
          </Badge>
        )}
      </div>

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
        </div>
      )}

      {/* Canvas */}
      {!isLoading && graph && graph.nodes.length > 0 && (
        <div className="min-h-0 flex-1 rounded-lg border">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) =>
              navigate({ to: "/epics/$epicId", params: { epicId: node.id } })
            }
            onNodeMouseEnter={(_, node) => setFocusedId(node.id)}
            onNodeMouseLeave={() => setFocusedId(null)}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
            <PastRailPanel
              pastCount={partition.past.length}
              showPast={showPast}
              onToggle={() => setShowPast((v) => !v)}
              activeNodeIds={partition.active.map((n) => n.id)}
            />
          </ReactFlow>
        </div>
      )}
    </div>
  );
}
