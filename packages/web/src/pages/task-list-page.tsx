import { useState, useEffect, useMemo, useCallback, Fragment } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ListTodo,
  Loader2,
  Search,
  UserCircle,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { useEpics } from "@/hooks/use-epics";
import { useUsers } from "@/hooks/use-users";
import { useProjectStore } from "@/stores/project-store";
import {
  formatRelativeTime,
  formatStatus,
  getStatusColor,
  getPriorityColor,
  getTypeColor,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { updateTask, transitionTask } from "@/lib/api";
import type { TaskFilters, Task, UpdateTask } from "@/lib/api";
import type { TaskListSearch } from "@/router";
import { useQueryClient } from "@tanstack/react-query";
import { taskKeys } from "@/hooks/use-tasks";

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

const GROUP_BY_OPTIONS = [
  { value: "none", label: "None" },
  { value: "epic", label: "Epic" },
  { value: "assignee", label: "Assignee" },
  { value: "priority", label: "Priority" },
] as const;

type SortField = "priority" | "created_at" | "updated_at" | "due_date" | "sort_order";
type GroupByField = "none" | "epic" | "assignee" | "priority";

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
          <TableCell><Skeleton className="h-4 w-4" /></TableCell>
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

// ---- Group Header ----

function GroupHeader({
  label,
  count,
  isCollapsed,
  onToggle,
}: {
  label: string;
  count: number;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <TableRow className="bg-muted/50 hover:bg-muted/50">
      <TableCell colSpan={9}>
        <button
          className="flex items-center gap-2 w-full text-left font-medium text-sm"
          onClick={onToggle}
        >
          {isCollapsed ? (
            <ChevronRight className="size-4" />
          ) : (
            <ChevronDown className="size-4" />
          )}
          <span>{label}</span>
          <Badge variant="secondary" className="text-[11px] ml-1">
            {count} task{count === 1 ? "" : "s"}
          </Badge>
        </button>
      </TableCell>
    </TableRow>
  );
}

// ---- Task Row ----

function TaskRow({
  task,
  isSelected,
  onSelect,
  onNavigate,
  epicMap,
  userMap,
}: {
  task: Task;
  isSelected: boolean;
  onSelect: (id: string, checked: boolean) => void;
  onNavigate: (taskId: string) => void;
  epicMap: Map<string, string>;
  userMap: Map<string, string>;
}) {
  return (
    <TableRow
      className={cn("cursor-pointer", isSelected && "bg-primary/5")}
      onClick={() => onNavigate(task.id)}
    >
      <TableCell className="w-[40px]" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={isSelected}
          onCheckedChange={(checked) => onSelect(task.id, !!checked)}
        />
      </TableCell>
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
          className={cn("text-[11px]", getPriorityColor(task.priority))}
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
        {task.assigneeId ? (
          userMap.get(task.assigneeId) ?? task.assigneeId
        ) : (
          <span className="italic text-muted-foreground/50">Unassigned</span>
        )}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {task.epicId ? (
          <span className="text-xs">{epicMap.get(task.epicId) ?? task.epicId.slice(0, 8) + "..."}</span>
        ) : (
          <span className="italic text-muted-foreground/50">None</span>
        )}
      </TableCell>
      <TableCell>
        {task.estimatedEffort ? (
          <Badge variant="outline" className="text-[11px]">
            {EFFORT_LABELS[task.estimatedEffort] ?? task.estimatedEffort}
          </Badge>
        ) : (
          <span className="text-muted-foreground/50">-</span>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {formatRelativeTime(task.updatedAt)}
      </TableCell>
    </TableRow>
  );
}

// ---- Bulk Action Bar ----

function BulkActionBar({
  selectedCount,
  onClear,
  onChangeStatus,
  onChangePriority,
  onAssignTo,
  isProcessing,
  progressText,
  users,
}: {
  selectedCount: number;
  onClear: () => void;
  onChangeStatus: (status: string) => void;
  onChangePriority: (priority: string) => void;
  onAssignTo: (userId: string | null) => void;
  isProcessing: boolean;
  progressText: string;
  users: Array<{ id: string; displayName: string }>;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-2.5">
      <span className="text-sm font-medium">
        {isProcessing ? (
          <span className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            {progressText}
          </span>
        ) : (
          `${selectedCount} task${selectedCount === 1 ? "" : "s"} selected`
        )}
      </span>
      <div className="flex items-center gap-2 ml-auto">
        {/* Change Status */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={isProcessing}>
              <Check className="size-4" />
              Change Status
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {TASK_STATUSES.map((s) => (
              <DropdownMenuItem key={s} onClick={() => onChangeStatus(s)}>
                <Badge variant="secondary" className={cn("text-[11px] mr-2", getStatusColor(s))}>
                  {formatStatus(s)}
                </Badge>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Change Priority */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={isProcessing}>
              <ChevronUp className="size-4" />
              Change Priority
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {PRIORITIES.map((p) => (
              <DropdownMenuItem key={p} onClick={() => onChangePriority(p)}>
                <Badge variant="secondary" className={cn("text-[11px] mr-2", getPriorityColor(p))}>
                  {formatStatus(p)}
                </Badge>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Assign to */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={isProcessing}>
              <UserCircle className="size-4" />
              Assign to
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => onAssignTo(null)}>
              <Users className="size-4 mr-2 text-muted-foreground" />
              Unassigned
            </DropdownMenuItem>
            {users.map((u) => (
              <DropdownMenuItem key={u.id} onClick={() => onAssignTo(u.id)}>
                <UserCircle className="size-4 mr-2 text-muted-foreground" />
                {u.displayName}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Clear selection */}
        <Button variant="ghost" size="sm" onClick={onClear} disabled={isProcessing}>
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

// ---- Main Component ----

export function TaskListPage() {
  const { projectId } = useParams({ strict: false });
  const navigate = useNavigate();
  const searchParams = useSearch({ strict: false }) as TaskListSearch;
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);
  const queryClient = useQueryClient();

  // Fetch project details
  const { data: project } = useProject(projectId);
  if (project) {
    setCurrentProject(project.id, project.name);
  }

  // Fetch epics and users for grouping/display/assign
  const { data: epics } = useEpics(projectId);
  const { data: users } = useUsers();

  // Build lookup maps
  const epicMap = useMemo(() => {
    const map = new Map<string, string>();
    if (epics) {
      for (const e of epics) {
        map.set(e.id, e.name);
      }
    }
    return map;
  }, [epics]);

  const userMap = useMemo(() => {
    const map = new Map<string, string>();
    if (users) {
      for (const u of users) {
        map.set(u.id, u.displayName);
      }
    }
    return map;
  }, [users]);

  const userList = useMemo(() => {
    return (users ?? []).filter((u) => u.isActive).map((u) => ({ id: u.id, displayName: u.displayName }));
  }, [users]);

  // Initialize state from URL search params
  const [statusFilter, setStatusFilter] = useState<string>(searchParams.status ?? "");
  const [priorityFilter, setPriorityFilter] = useState<string>(searchParams.priority ?? "");
  const [typeFilter, setTypeFilter] = useState<string>(searchParams.type ?? "");
  const [assigneeFilter, setAssigneeFilter] = useState<string>(searchParams.assignee ?? "");
  const [epicFilter, setEpicFilter] = useState<string>(searchParams.epic ?? "");
  const [searchInput, setSearchInput] = useState(searchParams.search ?? "");
  const debouncedSearch = useDebounce(searchInput, 300);

  // Sort state
  const [sortBy, setSortBy] = useState<SortField>((searchParams.sort as SortField) || "updated_at");
  const [order, setOrder] = useState<"asc" | "desc">(searchParams.order ?? "desc");

  // Pagination state
  const [page, setPage] = useState(searchParams.page ?? 1);
  const perPage = 25;

  // Group by state
  const [groupBy, setGroupBy] = useState<GroupByField>((searchParams.group_by as GroupByField) || "none");

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressText, setProgressText] = useState("");

  // Collapsed groups state
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Sync URL search params whenever filter/sort/pagination/group state changes
  useEffect(() => {
    const params: TaskListSearch = {};
    const effectiveStatus = statusFilter && statusFilter !== "all" ? statusFilter : undefined;
    const effectivePriority = priorityFilter && priorityFilter !== "all" ? priorityFilter : undefined;
    const effectiveType = typeFilter && typeFilter !== "all" ? typeFilter : undefined;
    const effectiveAssignee = assigneeFilter && assigneeFilter !== "all" ? assigneeFilter : undefined;
    const effectiveEpic = epicFilter && epicFilter !== "all" ? epicFilter : undefined;

    if (effectiveStatus) params.status = effectiveStatus;
    if (effectivePriority) params.priority = effectivePriority;
    if (effectiveType) params.type = effectiveType;
    if (effectiveAssignee) params.assignee = effectiveAssignee;
    if (effectiveEpic) params.epic = effectiveEpic;
    if (debouncedSearch) params.search = debouncedSearch;
    if (sortBy !== "updated_at") params.sort = sortBy;
    if (order !== "desc") params.order = order;
    if (page > 1) params.page = page;
    if (groupBy !== "none") params.group_by = groupBy;

    navigate({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      search: params as any,
      replace: true,
    });
  }, [statusFilter, priorityFilter, typeFilter, assigneeFilter, epicFilter, debouncedSearch, sortBy, order, page, groupBy, navigate]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [statusFilter, priorityFilter, typeFilter, assigneeFilter, epicFilter, debouncedSearch, sortBy, order]);

  // Build filter object (exclude "all" sentinel value)
  const effectiveStatus = statusFilter && statusFilter !== "all" ? statusFilter : "";
  const effectivePriority = priorityFilter && priorityFilter !== "all" ? priorityFilter : "";
  const effectiveType = typeFilter && typeFilter !== "all" ? typeFilter : "";
  const effectiveAssignee = assigneeFilter && assigneeFilter !== "all" ? assigneeFilter : "";
  const effectiveEpic = epicFilter && epicFilter !== "all" ? epicFilter : "";

  const filters: TaskFilters = useMemo(
    () => ({
      ...(effectiveStatus ? { status: effectiveStatus } : {}),
      ...(effectivePriority ? { priority: effectivePriority } : {}),
      ...(effectiveType ? { type: effectiveType } : {}),
      ...(effectiveAssignee ? { assignee: effectiveAssignee } : {}),
      ...(effectiveEpic ? { epic: effectiveEpic } : {}),
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      sortBy,
      order,
      page,
      perPage,
    }),
    [effectiveStatus, effectivePriority, effectiveType, effectiveAssignee, effectiveEpic, debouncedSearch, sortBy, order, page, perPage],
  );

  const { data, isLoading, error } = useTasks(projectId, filters);

  const tasks = data?.data ?? [];
  const pagination = data?.pagination;
  const totalPages = pagination?.totalPages ?? 1;

  const hasActiveFilters = !!(effectiveStatus || effectivePriority || effectiveType || effectiveAssignee || effectiveEpic || searchInput);

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
    setAssigneeFilter("");
    setEpicFilter("");
    setSearchInput("");
  }

  function handleTaskClick(taskId: string) {
    navigate({ to: "/tasks/$taskId", params: { taskId } });
  }

  // ---- Multi-select logic ----

  const handleSelectTask = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const allVisibleSelected = tasks.length > 0 && tasks.every((t) => selectedIds.has(t.id));
  const someVisibleSelected = tasks.some((t) => selectedIds.has(t.id));

  const handleSelectAll = useCallback(
    (checked: boolean | "indeterminate") => {
      if (checked === true) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const t of tasks) next.add(t.id);
          return next;
        });
      } else {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const t of tasks) next.delete(t.id);
          return next;
        });
      }
    },
    [tasks],
  );

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // ---- Bulk action handlers ----

  const handleBulkChangeStatus = useCallback(
    async (toStatus: string) => {
      const ids = Array.from(selectedIds);
      const total = ids.length;
      setIsProcessing(true);
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < ids.length; i++) {
        setProgressText(`Updating ${i + 1}/${total}...`);
        try {
          await transitionTask(ids[i], toStatus);
          successCount++;
        } catch {
          failCount++;
        }
      }

      setIsProcessing(false);
      setProgressText("");

      if (failCount > 0) {
        toast.error(`${failCount} task${failCount === 1 ? "" : "s"} failed to update status. ${successCount} succeeded.`);
      } else {
        toast.success(`Updated status of ${successCount} task${successCount === 1 ? "" : "s"} to ${formatStatus(toStatus)}.`);
      }

      queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
      setSelectedIds(new Set());
    },
    [selectedIds, queryClient],
  );

  const handleBulkChangePriority = useCallback(
    async (priority: string) => {
      const ids = Array.from(selectedIds);
      const total = ids.length;
      setIsProcessing(true);
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < ids.length; i++) {
        setProgressText(`Updating ${i + 1}/${total}...`);
        try {
          await updateTask(ids[i], { priority: priority as UpdateTask["priority"] });
          successCount++;
        } catch {
          failCount++;
        }
      }

      setIsProcessing(false);
      setProgressText("");

      if (failCount > 0) {
        toast.error(`${failCount} task${failCount === 1 ? "" : "s"} failed to update priority. ${successCount} succeeded.`);
      } else {
        toast.success(`Updated priority of ${successCount} task${successCount === 1 ? "" : "s"} to ${formatStatus(priority)}.`);
      }

      queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
      setSelectedIds(new Set());
    },
    [selectedIds, queryClient],
  );

  const handleBulkAssignTo = useCallback(
    async (userId: string | null) => {
      const ids = Array.from(selectedIds);
      const total = ids.length;
      setIsProcessing(true);
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < ids.length; i++) {
        setProgressText(`Updating ${i + 1}/${total}...`);
        try {
          await updateTask(ids[i], { assigneeId: userId });
          successCount++;
        } catch {
          failCount++;
        }
      }

      setIsProcessing(false);
      setProgressText("");

      const assigneeName = userId ? (userMap.get(userId) ?? userId) : "Unassigned";
      if (failCount > 0) {
        toast.error(`${failCount} task${failCount === 1 ? "" : "s"} failed to assign. ${successCount} succeeded.`);
      } else {
        toast.success(`Assigned ${successCount} task${successCount === 1 ? "" : "s"} to ${assigneeName}.`);
      }

      queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
      setSelectedIds(new Set());
    },
    [selectedIds, queryClient, userMap],
  );

  // ---- Grouping logic ----

  const groupedTasks = useMemo(() => {
    if (groupBy === "none") return null;

    const groups = new Map<string, { label: string; tasks: Task[] }>();

    for (const task of tasks) {
      let key: string;
      let label: string;

      switch (groupBy) {
        case "epic":
          key = task.epicId ?? "__none__";
          label = task.epicId ? `Epic: ${epicMap.get(task.epicId) ?? task.epicId.slice(0, 8) + "..."}` : "No Epic";
          break;
        case "assignee":
          key = task.assigneeId ?? "__unassigned__";
          label = task.assigneeId ? `Assignee: ${userMap.get(task.assigneeId) ?? task.assigneeId}` : "Unassigned";
          break;
        case "priority":
          key = task.priority;
          label = `Priority: ${formatStatus(task.priority)}`;
          break;
        default:
          key = "__all__";
          label = "All";
      }

      if (!groups.has(key)) {
        groups.set(key, { label, tasks: [] });
      }
      groups.get(key)!.tasks.push(task);
    }

    // Sort groups: for priority, use natural order; for others, alphabetical with "none" last
    const entries = Array.from(groups.entries());
    if (groupBy === "priority") {
      const priorityOrder = ["critical", "high", "medium", "low"];
      entries.sort((a, b) => priorityOrder.indexOf(a[0]) - priorityOrder.indexOf(b[0]));
    } else {
      entries.sort((a, b) => {
        if (a[0].startsWith("__")) return 1;
        if (b[0].startsWith("__")) return -1;
        return a[1].label.localeCompare(b[1].label);
      });
    }

    return entries;
  }, [tasks, groupBy, epicMap, userMap]);

  const toggleGroupCollapse = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // ---- Render ----

  const renderTaskRows = (taskList: Task[]) =>
    taskList.map((task) => (
      <TaskRow
        key={task.id}
        task={task}
        isSelected={selectedIds.has(task.id)}
        onSelect={handleSelectTask}
        onNavigate={handleTaskClick}
        epicMap={epicMap}
        userMap={userMap}
      />
    ));

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
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load tasks. Please try again.
        </div>
      )}

      {/* Bulk action bar (when tasks are selected) */}
      {selectedIds.size > 0 ? (
        <BulkActionBar
          selectedCount={selectedIds.size}
          onClear={clearSelection}
          onChangeStatus={handleBulkChangeStatus}
          onChangePriority={handleBulkChangePriority}
          onAssignTo={handleBulkAssignTo}
          isProcessing={isProcessing}
          progressText={progressText}
          users={userList}
        />
      ) : (
        /* Filter bar */
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

          {/* Group by */}
          <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupByField)}>
            <SelectTrigger size="sm" className="w-[130px]">
              <SelectValue placeholder="Group by" />
            </SelectTrigger>
            <SelectContent>
              {GROUP_BY_OPTIONS.map((g) => (
                <SelectItem key={g.value} value={g.value}>
                  {g.label}
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
      )}

      {/* Table */}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40px]">
                <Checkbox
                  checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                  onCheckedChange={handleSelectAll}
                />
              </TableHead>
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
                <TableCell colSpan={9} className="h-32 text-center">
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

            {!isLoading && tasks.length > 0 && groupBy === "none" && renderTaskRows(tasks)}

            {!isLoading && tasks.length > 0 && groupBy !== "none" && groupedTasks &&
              groupedTasks.map(([key, group]) => (
                <Fragment key={key}>
                  <GroupHeader
                    label={group.label}
                    count={group.tasks.length}
                    isCollapsed={collapsedGroups.has(key)}
                    onToggle={() => toggleGroupCollapse(key)}
                  />
                  {!collapsedGroups.has(key) && renderTaskRows(group.tasks)}
                </Fragment>
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
