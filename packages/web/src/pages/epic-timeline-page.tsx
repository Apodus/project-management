import { useEffect } from "react";
import { useParams } from "@tanstack/react-router";
import { Network } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useProject } from "@/hooks/use-projects";
import { useEpicGraph } from "@/hooks/use-epic-graph";
import { useProjectStore } from "@/stores/project-store";
import { formatStatus } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { EpicGraphNode } from "@/lib/api";

// Health → badge color class. getStatusColor (format.ts) does not cover the
// epic-graph health vocabulary, so map it locally, reusing the same Tailwind
// class strings for visual consistency with the rest of the app.
function getHealthColor(health: EpicGraphNode["health"]): string {
  switch (health) {
    case "not_started":
      return "bg-gray-100 text-gray-800 dark:bg-gray-900/40 dark:text-gray-300";
    case "on_track":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
    case "at_risk":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    case "blocked":
      return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
    case "done":
      return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
    default:
      return "bg-gray-100 text-gray-800 dark:bg-gray-900/40 dark:text-gray-300";
  }
}

// ---- Node card (bare; layout/edges/recency are later phases) ----

function NodeCard({ node }: { node: EpicGraphNode }) {
  const { total, done } = node.taskSummary;
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="pb-0">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="line-clamp-1 text-base">{node.name}</CardTitle>
          <Badge
            variant="secondary"
            className={cn("text-[10px] shrink-0", getHealthColor(node.health))}
          >
            {formatStatus(node.health)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {done} of {total} task{total === 1 ? "" : "s"} done
            </span>
            <span>{progressPct}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className={cn(
                "h-1.5 rounded-full transition-all",
                progressPct === 100 ? "bg-green-500" : "bg-blue-500",
              )}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---- Skeleton ----

function NodeSkeleton() {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="pb-0">
        <Skeleton className="h-5 w-3/4" />
      </CardHeader>
      <CardContent className="space-y-2">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-1.5 w-full" />
      </CardContent>
    </Card>
  );
}

// ---- Main page ----

export function EpicTimelinePage() {
  const { projectId } = useParams({ strict: false });
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  const { data: project } = useProject(projectId);
  useEffect(() => {
    if (project) {
      setCurrentProject(project.id, project.name);
    }
  }, [project, setCurrentProject]);

  const { data: graph, isLoading, error, refetch } = useEpicGraph(projectId);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <Network className="size-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">Roadmap</h1>
        {project && (
          <Badge variant="outline" className="text-xs font-normal">
            {project.name}
          </Badge>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 py-8">
          <p className="text-sm text-destructive">Failed to load roadmap.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <NodeSkeleton key={i} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && graph && graph.nodes.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
          <Network className="mb-3 size-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            No epics in this roadmap yet.
          </p>
        </div>
      )}

      {/* Node list */}
      {!isLoading && graph && graph.nodes.length > 0 && (
        <div className="space-y-3">
          {graph.nodes.map((node) => (
            <NodeCard key={node.id} node={node} />
          ))}
        </div>
      )}
    </div>
  );
}
