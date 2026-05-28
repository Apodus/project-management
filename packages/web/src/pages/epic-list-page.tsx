import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Milestone, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useProject } from "@/hooks/use-projects";
import { useEpics } from "@/hooks/use-epics";
import { useUsers } from "@/hooks/use-users";
import { useProjectStore } from "@/stores/project-store";
import {
  formatStatus,
  getStatusColor,
  getPriorityColor,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Epic } from "@/lib/api";

const EPIC_STATUSES = ["draft", "active", "completed", "cancelled"] as const;

// ---- Epic card ----

function EpicCard({
  epic,
  assigneeName,
  onClick,
}: {
  epic: Epic;
  assigneeName?: string;
  onClick: () => void;
}) {
  const { total, done } = epic.taskSummary;
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <Card
      className="cursor-pointer gap-3 py-4 transition-shadow hover:shadow-md"
      onClick={onClick}
    >
      <CardHeader className="pb-0">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="line-clamp-1 text-base">{epic.name}</CardTitle>
          <div className="flex items-center gap-1.5 shrink-0">
            <Badge
              variant="secondary"
              className={cn("text-[10px]", getPriorityColor(epic.priority))}
            >
              {formatStatus(epic.priority)}
            </Badge>
            <Badge
              variant="secondary"
              className={cn("text-[10px]", getStatusColor(epic.status))}
            >
              {formatStatus(epic.status)}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {epic.description ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {epic.description}
          </p>
        ) : (
          <p className="text-sm italic text-muted-foreground/50">
            No description
          </p>
        )}

        {/* Assignee */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <User className="size-3" />
          {epic.assigneeId ? (
            <span className="truncate">{assigneeName ?? epic.assigneeId}</span>
          ) : (
            <span className="italic text-muted-foreground/60">Unclaimed</span>
          )}
        </div>

        {/* Progress bar */}
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

function EpicSkeleton() {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="pb-0">
        <Skeleton className="h-5 w-3/4" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-2/3" />
        <Skeleton className="h-1.5 w-full" />
      </CardContent>
    </Card>
  );
}

// ---- Main page ----

export function EpicListPage() {
  const { projectId } = useParams({ strict: false });
  const navigate = useNavigate();
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  // Fetch project details
  const { data: project } = useProject(projectId);
  if (project) {
    setCurrentProject(project.id, project.name);
  }

  const [statusFilter, setStatusFilter] = useState<string>("");

  const { data: epics, isLoading, error, refetch } = useEpics(
    projectId,
    statusFilter && statusFilter !== "all" ? { status: statusFilter } : undefined,
  );

  const { data: users } = useUsers();
  const usersById = new Map((users ?? []).map((u) => [u.id, u.displayName] as const));

  function handleEpicClick(epicId: string) {
    navigate({
      to: "/epics/$epicId",
      params: { epicId },
    });
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Milestone className="size-6 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">Epics</h1>
          {project && (
            <Badge variant="outline" className="text-xs font-normal">
              {project.name}
            </Badge>
          )}
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 py-8">
          <p className="text-sm text-destructive">
            Failed to load epics. Please try again.
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* Filter */}
      <div className="flex items-center gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger size="sm" className="w-[140px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {EPIC_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {formatStatus(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <EpicSkeleton key={i} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && (!epics || epics.length === 0) && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
          <Milestone className="mb-3 size-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            No epics found. Epics will appear here when proposals are
            planned.
          </p>
        </div>
      )}

      {/* Epic cards */}
      {!isLoading && epics && epics.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {epics.map((epic) => (
            <EpicCard
              key={epic.id}
              epic={epic}
              assigneeName={epic.assigneeId ? usersById.get(epic.assigneeId) : undefined}
              onClick={() => handleEpicClick(epic.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
