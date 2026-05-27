import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ListTodo,
  Search,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useProject } from "@/hooks/use-projects";
import { useTasks } from "@/hooks/use-tasks";
import { useProjectStore } from "@/stores/project-store";
import {
  formatRelativeTime,
  formatStatus,
  getStatusColor,
  getPriorityColor,
  getTypeColor,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TaskFilters } from "@/lib/api";

const TASK_STATUSES = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;

const PRIORITIES = ["critical", "high", "medium", "low"] as const;

const TASK_TYPES = [
  "feature",
  "bug",
  "chore",
  "spike",
  "design",
  "research",
] as const;

const EFFORT_LABELS: Record<string, string> = {
  xs: "XS",
  s: "S",
  m: "M",
  l: "L",
  xl: "XL",
};

type SortField = "priority" | "created_at" | "updated_at" | "due_date" | "sort_order";

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

// ---- Sort Header ----

function SortableHeader({
  label,
  field,
  currentSort,
  currentOrder,
  onSort,
}: {
  label: string;
  field: SortField;
  currentSort?: string;
  currentOrder?: "asc" | "desc";
  onSort: (field: SortField) => void;
}) {
  const isActive = currentSort === field;
  return (
    <button
      className="flex items-center gap-1 hover:text-foreground"
      onClick={() => onSort(field)}
    >
      {label}
      {isActive ? (
        currentOrder === "asc" ? (
          <ArrowUp className="size-3.5" />
        ) : (
          <ArrowDown className="size-3.5" />
        )
      ) : (
        <ArrowUpDown className="size-3.5 opacity-40" />
      )}
    </button>
  );
}

// ---- Skeleton Rows ----

function TaskTableSkeleton() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <TableRow key={i}>
          <TableCell><Skeleton className="h-4 w-48" /></TableCell>
          <TableCell><Skeleton className="h-5 w-16" /></TableCell>
          <TableCell><Skeleton className="h-5 w-14" /></TableCell>
          <TableCell><Skeleton className="h-5 w-14" /></TableCell>
          <TableCell><Skeleton className="h-4 w-20" /></TableCell>
          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
          <TableCell><Skeleton className="h-5 w-8" /></TableCell>
          <TableCell><Skeleton className="h-4 w-16" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}

export function TaskListPage() {
  const { projectId } = useParams({ strict: false });
  const navigate = useNavigate();
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  // Fetch project details
  const { data: project } = useProject(projectId);
  if (project) {
    setCurrentProject(project.id, project.name);
  }

  // Filter state
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [priorityFilter, setPriorityFilter] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebounce(searchInput, 300);

  // Sort state
  const [sortBy, setSortBy] = useState<SortField>("updated_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");

  // Pagination state
  const [page, setPage] = useState(1);
  const perPage = 25;

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [statusFilter, priorityFilter, typeFilter, debouncedSearch, sortBy, order]);

  // Build filter object (exclude "all" sentinel value)
  const effectiveStatus = statusFilter && statusFilter !== "all" ? statusFilter : "";
  const effectivePriority = priorityFilter && priorityFilter !== "all" ? priorityFilter : "";
  const effectiveType = typeFilter && typeFilter !== "all" ? typeFilter : "";

  const filters: TaskFilters = useMemo(
    () => ({
      ...(effectiveStatus ? { status: effectiveStatus } : {}),
      ...(effectivePriority ? { priority: effectivePriority } : {}),
      ...(effectiveType ? { type: effectiveType } : {}),
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      sortBy,
      order,
      page,
      perPage,
    }),
    [effectiveStatus, effectivePriority, effectiveType, debouncedSearch, sortBy, order, page, perPage],
  );

  const { data, isLoading, error, refetch } = useTasks(projectId, filters);

  const tasks = data?.data ?? [];
  const pagination = data?.pagination;
  const totalPages = pagination?.totalPages ?? 1;

  const hasActiveFilters = !!(effectiveStatus || effectivePriority || effectiveType || searchInput);

  const handleSort = useCallback(
    (field: SortField) => {
      if (sortBy === field) {
        setOrder((prev) => (prev === "asc" ? "desc" : "asc"));
      } else {
        setSortBy(field);
        setOrder(field === "priority" ? "asc" : "desc");
      }
    },
    [sortBy],
  );

  function clearFilters() {
    setStatusFilter("");
    setPriorityFilter("");
    setTypeFilter("");
    setSearchInput("");
  }

  function handleTaskClick(taskId: string) {
    navigate({ to: "/tasks/$taskId", params: { taskId } });
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <ListTodo className="size-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">Tasks</h1>
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
            Failed to load tasks. Please try again.
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search tasks..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9 h-9"
          />
        </div>

        {/* Status filter */}
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger size="sm" className="w-[130px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {TASK_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {formatStatus(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Priority filter */}
        <Select value={priorityFilter} onValueChange={setPriorityFilter}>
          <SelectTrigger size="sm" className="w-[120px]">
            <SelectValue placeholder="Priority" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All priorities</SelectItem>
            {PRIORITIES.map((p) => (
              <SelectItem key={p} value={p}>
                {formatStatus(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Type filter */}
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger size="sm" className="w-[120px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {TASK_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {formatStatus(t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Clear filters */}
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="size-4" />
            Clear filters
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[250px]">Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <SortableHeader
                  label="Priority"
                  field="priority"
                  currentSort={sortBy}
                  currentOrder={order}
                  onSort={handleSort}
                />
              </TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Assignee</TableHead>
              <TableHead>Epic</TableHead>
              <TableHead>Effort</TableHead>
              <TableHead>
                <SortableHeader
                  label="Updated"
                  field="updated_at"
                  currentSort={sortBy}
                  currentOrder={order}
                  onSort={handleSort}
                />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TaskTableSkeleton />}

            {!isLoading && tasks.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="h-32 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <ListTodo className="size-8 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">
                      {hasActiveFilters
                        ? "No tasks match your filters."
                        : "No tasks found. Tasks will appear here when proposals are implemented."}
                    </p>
                    {hasActiveFilters && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={clearFilters}
                      >
                        Clear filters
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            )}

            {!isLoading &&
              tasks.map((task) => (
                <TableRow
                  key={task.id}
                  className="cursor-pointer"
                  onClick={() => handleTaskClick(task.id)}
                >
                  <TableCell className="font-medium max-w-[350px]">
                    <span className="line-clamp-1">{task.title}</span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="secondary"
                      className={cn("text-[11px]", getStatusColor(task.status))}
                    >
                      {formatStatus(task.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="secondary"
                      className={cn(
                        "text-[11px]",
                        getPriorityColor(task.priority),
                      )}
                    >
                      {formatStatus(task.priority)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="secondary"
                      className={cn("text-[11px]", getTypeColor(task.type))}
                    >
                      {formatStatus(task.type)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {task.assigneeId ?? (
                      <span className="italic text-muted-foreground/50">
                        Unassigned
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {task.epicId ? (
                      <span className="font-mono text-xs">
                        {task.epicId.slice(0, 8)}...
                      </span>
                    ) : (
                      <span className="italic text-muted-foreground/50">
                        None
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {task.estimatedEffort ? (
                      <Badge variant="outline" className="text-[11px]">
                        {EFFORT_LABELS[task.estimatedEffort] ??
                          task.estimatedEffort}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground/50">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelativeTime(task.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {pagination && totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {pagination.page} of {totalPages}
            {pagination.total > 0 && (
              <span className="ml-2">
                ({pagination.total} task{pagination.total === 1 ? "" : "s"} total)
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
