import { useEffect, useMemo } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { ReactFlow, Background, Controls, type Node, type Edge } from "@xyflow/react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTaskGraph } from "@/hooks/use-task-graph";
import { useFloatingPanel } from "@/hooks/use-floating-panel";
import { computeTaskGraphLayout } from "@/lib/task-graph-layout";
import { getEdgeStyling } from "@/lib/epic-graph-style";
import { TaskNode, type TaskNodeData } from "@/components/task-node";

interface EpicTasksPanelProps {
  projectId: string | undefined;
  epicId: string;
  epicName: string;
  onClose: () => void;
}

const taskNodeTypes = { task: TaskNode };

/**
 * Floating overlay that renders the clicked epic's TASK mini-DAG (a nested
 * ReactFlow with its own store) on top of the roadmap canvas. Layering comes
 * from the pure `computeTaskGraphLayout`; edge styling is REUSED from the epic
 * graph. Clicking a task node navigates to its detail; Esc / ✕ closes.
 */
export function EpicTasksPanel({ projectId, epicId, epicName, onClose }: EpicTasksPanelProps) {
  const navigate = useNavigate();
  const { data: graph, isLoading, error } = useTaskGraph(projectId, epicId);
  const { panelRef, style, dragHandleProps, resizeHandleProps } = useFloatingPanel();

  const layout = useMemo(
    () =>
      graph
        ? computeTaskGraphLayout(graph.nodes, graph.edges)
        : { positions: new Map(), layerCount: 0 },
    [graph],
  );

  const rfNodes = useMemo<Node<TaskNodeData>[]>(() => {
    if (!graph) return [];
    return graph.nodes.map((n) => ({
      id: n.id,
      type: "task",
      position: layout.positions.get(n.id) ?? { x: 0, y: 0 },
      data: {
        title: n.title,
        status: n.status,
        type: n.type,
        assigneeId: n.assignee_id,
      },
    }));
  }, [graph, layout]);

  const rfEdges = useMemo<Edge[]>(() => {
    if (!graph) return [];
    return graph.edges.map((e) => ({
      id: `${e.from}->${e.to}-${e.dependency_type}`,
      source: e.from,
      target: e.to,
      ...getEdgeStyling({
        provenance: e.provenance,
        dependencyType: e.dependency_type,
        isBackwards: false,
        highlightState: "none",
      }),
    }));
  }, [graph]);

  // Esc-to-close, scoped to the panel's mounted lifetime.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isEmpty = !isLoading && !error && graph && graph.nodes.length === 0;

  return (
    <Card ref={panelRef} style={style} className="flex flex-col gap-0 py-0 shadow-lg">
      {/* Header (drag handle) */}
      <div
        className="flex shrink-0 cursor-move touch-none select-none items-center gap-2 border-b px-3 py-2"
        {...dragHandleProps}
      >
        <span className="flex-1 truncate text-sm font-semibold" title={epicName}>
          {epicName || "Epic"}
        </span>
        <Link
          to="/epics/$epicId"
          params={{ epicId }}
          data-no-drag
          className="text-muted-foreground hover:text-foreground whitespace-nowrap text-xs"
        >
          Open full epic →
        </Link>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close panel"
          data-no-drag
        >
          <X className="size-4" />
        </Button>
      </div>

      {/* Canvas region */}
      <div className="min-h-0 flex-1">
        {isLoading && (
          <div className="space-y-3 p-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}

        {error && (
          <div className="text-destructive flex h-full items-center justify-center px-4 text-center text-sm">
            Failed to load tasks.
          </div>
        )}

        {isEmpty && (
          <div className="text-muted-foreground flex h-full items-center justify-center px-4 text-center text-sm">
            No tasks in this epic yet.
          </div>
        )}

        {!isLoading && !error && graph && graph.nodes.length > 0 && (
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={taskNodeTypes}
            onNodeClick={(_, node) =>
              navigate({ to: "/tasks/$taskId", params: { taskId: node.id } })
            }
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 0.65 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>

      {/* Resize grip (bottom-right) */}
      <div
        data-testid="panel-resize-handle"
        aria-hidden
        className="border-muted-foreground/40 absolute bottom-0 right-0 size-4 cursor-nwse-resize touch-none border-b-2 border-r-2"
        {...resizeHandleProps}
      />
    </Card>
  );
}
