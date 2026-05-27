import { useState, useEffect } from "react";
import { useParams } from "@tanstack/react-router";
import {
  Activity,
  Archive,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Pencil,
  Plus,
  User,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useProject } from "@/hooks/use-projects";
import { useProjectActivity } from "@/hooks/use-activity";
import { useUsers } from "@/hooks/use-users";
import { useProjectStore } from "@/stores/project-store";
import { formatRelativeTime, formatStatus } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActivityFilters, ActivityLogEntry } from "@/lib/api";

// ---- Constants ----

const ENTITY_TYPES = [
  { value: "all", label: "All Types" },
  { value: "project", label: "Projects" },
  { value: "proposal", label: "Proposals" },
  { value: "epic", label: "Epics" },
  { value: "task", label: "Tasks" },
  { value: "comment", label: "Comments" },
] as const;

// ---- Action icon mapping ----

function getActionIcon(action: string) {
  switch (action) {
    case "created":
      return Plus;
    case "updated":
      return Pencil;
    case "status_changed":
    case "transitioned":
      return ArrowRight;
    case "assigned":
      return User;
    case "commented":
      return MessageSquare;
    case "archived":
      return Archive;
    default:
      return Activity;
  }
}

function getActionColor(action: string): string {
  switch (action) {
    case "created":
      return "text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/40";
    case "updated":
      return "text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/40";
    case "status_changed":
    case "transitioned":
      return "text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/40";
    case "assigned":
      return "text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/40";
    case "commented":
      return "text-sky-600 bg-sky-100 dark:text-sky-400 dark:bg-sky-900/40";
    case "archived":
      return "text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/40";
    default:
      return "text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/40";
  }
}

// ---- Changes display ----

interface ChangeDetail {
  field: string;
  from: unknown;
  to: unknown;
}

function parseChanges(changes: unknown): ChangeDetail[] {
  if (!changes || typeof changes !== "object") return [];
  const result: ChangeDetail[] = [];
  for (const [field, value] of Object.entries(changes as Record<string, unknown>)) {
    if (value && typeof value === "object" && "from" in value && "to" in value) {
      const v = value as { from: unknown; to: unknown };
      result.push({ field, from: v.from, to: v.to });
    }
  }
  return result;
}

function formatChangeValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value;
  return String(value);
}

function ChangesDetail({ changes }: { changes: unknown }) {
  const parsed = parseChanges(changes);
  if (parsed.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {parsed.map((change) => (
        <span
          key={change.field}
          className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
        >
          <span className="font-medium">{formatStatus(change.field)}:</span>
          <span className="line-through opacity-60">
            {formatChangeValue(change.from)}
          </span>
          <ArrowRight className="size-3" />
          <span className="font-medium">{formatChangeValue(change.to)}</span>
        </span>
      ))}
    </div>
  );
}

// ---- Activity entry ----

interface ActivityEntryProps {
  entry: ActivityLogEntry;
  actorName?: string;
  actorType?: string;
}

function ActivityEntry({ entry, actorName, actorType }: ActivityEntryProps) {
  const Icon = getActionIcon(entry.action);
  const iconColor = getActionColor(entry.action);
  const displayActorName = entry.actorName ?? actorName ?? entry.actorId ?? "System";
  const displayActorType = entry.actorType ?? actorType;
  const isAI = displayActorType === "ai_agent";
  const displayTitle = entry.entityTitle ?? entry.entityId.slice(0, 8);

  return (
    <div className="flex gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/30">
      {/* Action icon */}
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full",
          iconColor,
        )}
      >
        <Icon className="size-4" />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm">
            <span className="font-medium">{displayActorName}</span>
            {" "}
            <span className="text-muted-foreground">{formatStatus(entry.action).toLowerCase()}</span>
            {" "}
            <span className="text-muted-foreground">{entry.entityType}</span>
            {" "}
            <span className="font-medium">
              &apos;{displayTitle}&apos;
            </span>
            {entry.epicName && (
              <span className="text-muted-foreground/70 text-xs ml-1">
                (Epic: {entry.epicName})
              </span>
            )}
          </p>

          <div className="flex shrink-0 items-center gap-2">
            {/* Actor type badge */}
            {isAI ? (
              <Badge
                variant="secondary"
                className="text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
              >
                AI
              </Badge>
            ) : (
              <Badge
                variant="secondary"
                className="text-[10px] bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400"
              >
                Human
              </Badge>
            )}

            {/* Timestamp */}
            <span className="whitespace-nowrap text-xs text-muted-foreground/60">
              {formatRelativeTime(entry.createdAt)}
            </span>
          </div>
        </div>

        {/* Changes detail */}
        <ChangesDetail changes={entry.changes} />
      </div>
    </div>
  );
}

// ---- Skeleton ----

function ActivitySkeleton() {
  return (
    <div className="flex gap-3 rounded-lg border p-4">
      <Skeleton className="size-8 shrink-0 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

// ---- Page ----

export function ActivityPage() {
  const { projectId } = useParams({ strict: false });
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  // Fetch project details
  const { data: project } = useProject(projectId);
  if (project) {
    setCurrentProject(project.id, project.name);
  }

  // Fetch users for actor name display
  const { data: users } = useUsers();
  const userMap = new Map(
    (users ?? []).map((u) => [u.id, { name: u.displayName, type: u.type }]),
  );

  // Filter state
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>("");
  const [actorFilter, setActorFilter] = useState<string>("");
  const [page, setPage] = useState(1);
  const perPage = 20;

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [entityTypeFilter, actorFilter]);

  // Build filters
  const effectiveEntityType =
    entityTypeFilter && entityTypeFilter !== "all" ? entityTypeFilter : "";
  const effectiveActorId =
    actorFilter && actorFilter !== "all" ? actorFilter : "";

  const filters: ActivityFilters = {
    ...(effectiveEntityType ? { entity_type: effectiveEntityType } : {}),
    ...(effectiveActorId ? { actor_id: effectiveActorId } : {}),
    page,
    per_page: perPage,
  };

  const { data, isLoading, error, refetch } = useProjectActivity(projectId, filters);

  const entries = data?.data ?? [];
  const pagination = data?.pagination;
  const totalPages = pagination?.totalPages ?? 1;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <Activity className="size-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">Activity</h1>
        {project && (
          <Badge variant="outline" className="text-xs font-normal">
            {project.name}
          </Badge>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 py-8">
          <p className="text-sm text-destructive">
            Failed to load activity. Please try again.
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Entity type filter */}
        <Select value={entityTypeFilter} onValueChange={setEntityTypeFilter}>
          <SelectTrigger size="sm" className="w-[150px]">
            <SelectValue placeholder="Entity Type" />
          </SelectTrigger>
          <SelectContent>
            {ENTITY_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Actor filter */}
        <Select value={actorFilter} onValueChange={setActorFilter}>
          <SelectTrigger size="sm" className="w-[180px]">
            <SelectValue placeholder="Actor" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Actors</SelectItem>
            {(users ?? []).map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Clear filters */}
        {(effectiveEntityType || effectiveActorId) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEntityTypeFilter("");
              setActorFilter("");
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {/* Activity list */}
      <div className="space-y-3">
        {/* Loading */}
        {isLoading &&
          Array.from({ length: 6 }).map((_, i) => <ActivitySkeleton key={i} />)}

        {/* Empty state */}
        {!isLoading && entries.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
            <Activity className="mb-3 size-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No activity found
            </p>
            {(effectiveEntityType || effectiveActorId) && (
              <p className="mt-1 text-xs text-muted-foreground/60">
                Try adjusting your filters
              </p>
            )}
          </div>
        )}

        {/* Entries */}
        {!isLoading &&
          entries.map((entry) => {
            const actor = entry.actorId ? userMap.get(entry.actorId) : undefined;
            return (
              <ActivityEntry
                key={entry.id}
                entry={entry}
                actorName={actor?.name}
                actorType={actor?.type}
              />
            );
          })}
      </div>

      {/* Pagination */}
      {pagination && totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {pagination.page} of {totalPages}
            {pagination.total > 0 && (
              <span className="ml-2">
                ({pagination.total} {pagination.total === 1 ? "entry" : "entries"} total)
              </span>
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="size-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
