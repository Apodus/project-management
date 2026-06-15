import { useState, useEffect, useMemo, useCallback } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, GripVertical, Kanban, Search, X, Layers } from "lucide-react";
import { toast } from "sonner";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ClaimStateBadge } from "@/components/claim-state-badge";
import { useProject } from "@/hooks/use-projects";
import { useTasks, useTransitionTask } from "@/hooks/use-tasks";
import { useEpics } from "@/hooks/use-epics";
import { useUsers } from "@/hooks/use-users";
import { useProjectStore } from "@/stores/project-store";
import { formatStatus, getStatusColor, getPriorityColor, getTypeColor } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Task, TaskFilters } from "@/lib/api";

// ---- Constants ----

const BOARD_STATUSES = ["backlog", "ready", "in_progress", "in_review", "done"] as const;

// On the project-wide board we fetch only open work (terminal `done` excluded)
// so the board is never a default infinite enumeration. The `done` column is
// still rendered (drag-to-complete preserved) — it just starts empty.
const OPEN_WORK_STATUSES = "backlog,ready,in_progress,in_review";

const PRIORITIES = ["critical", "high", "medium", "low"] as const;

const TASK_TYPES = ["feature", "bug", "chore", "spike", "design", "research"] as const;

// ---- Epic color palette ----

/**
 * 8-10 distinct colors that work in both dark and light mode.
 * Each entry: [border class, badge bg class, badge text class, dot bg class]
 */
const EPIC_COLORS = [
  {
    border: "border-l-emerald-500",
    badgeBg: "bg-emerald-500/15",
    badgeText: "text-emerald-700 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  {
    border: "border-l-blue-500",
    badgeBg: "bg-blue-500/15",
    badgeText: "text-blue-700 dark:text-blue-400",
    dot: "bg-blue-500",
  },
  {
    border: "border-l-violet-500",
    badgeBg: "bg-violet-500/15",
    badgeText: "text-violet-700 dark:text-violet-400",
    dot: "bg-violet-500",
  },
  {
    border: "border-l-amber-500",
    badgeBg: "bg-amber-500/15",
    badgeText: "text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  {
    border: "border-l-rose-500",
    badgeBg: "bg-rose-500/15",
    badgeText: "text-rose-700 dark:text-rose-400",
    dot: "bg-rose-500",
  },
  {
    border: "border-l-cyan-500",
    badgeBg: "bg-cyan-500/15",
    badgeText: "text-cyan-700 dark:text-cyan-400",
    dot: "bg-cyan-500",
  },
  {
    border: "border-l-orange-500",
    badgeBg: "bg-orange-500/15",
    badgeText: "text-orange-700 dark:text-orange-400",
    dot: "bg-orange-500",
  },
  {
    border: "border-l-pink-500",
    badgeBg: "bg-pink-500/15",
    badgeText: "text-pink-700 dark:text-pink-400",
    dot: "bg-pink-500",
  },
  {
    border: "border-l-teal-500",
    badgeBg: "bg-teal-500/15",
    badgeText: "text-teal-700 dark:text-teal-400",
    dot: "bg-teal-500",
  },
  {
    border: "border-l-indigo-500",
    badgeBg: "bg-indigo-500/15",
    badgeText: "text-indigo-700 dark:text-indigo-400",
    dot: "bg-indigo-500",
  },
] as const;

const NEUTRAL_EPIC_COLOR = {
  border: "border-l-gray-300 dark:border-l-gray-600",
  badgeBg: "bg-gray-500/15",
  badgeText: "text-gray-600 dark:text-gray-400",
  dot: "bg-gray-400",
};

function getEpicColor(epicId: string | null | undefined) {
  if (!epicId) return NEUTRAL_EPIC_COLOR;
  const index = epicId.charCodeAt(0) % EPIC_COLORS.length;
  return EPIC_COLORS[index];
}

// ---- Helpers ----

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

function getInitials(name: string): string {
  return name
    .split(/[\s-_]+/)
    .map((part) => part.charAt(0).toUpperCase())
    .slice(0, 2)
    .join("");
}

// ---- Task Card ----

interface TaskCardProps {
  task: Task;
  epicName?: string;
  assigneeName?: string;
  onClick: (taskId: string) => void;
  isDragOverlay?: boolean;
}

function TaskCard({ task, epicName, assigneeName, onClick, isDragOverlay }: TaskCardProps) {
  const epicColor = getEpicColor(task.epicId);

  return (
    <div
      className={cn(
        "bg-card group cursor-pointer rounded-lg border border-l-4 p-3 shadow-sm transition-shadow hover:shadow-md",
        epicColor.border,
        isDragOverlay && "ring-primary/20 rotate-1 shadow-lg ring-2",
      )}
      onClick={(e) => {
        e.stopPropagation();
        onClick(task.id);
      }}
    >
      {/* Epic badge */}
      {epicName ? (
        <span
          className={cn(
            "mb-1.5 inline-block max-w-full truncate rounded px-1.5 py-0.5 text-[10px] font-medium",
            epicColor.badgeBg,
            epicColor.badgeText,
          )}
        >
          {epicName}
        </span>
      ) : null}

      {/* Title */}
      <p className="mb-2 line-clamp-2 text-sm font-medium leading-snug">{task.title}</p>

      {/* Priority + Type badges row */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Badge
          variant="secondary"
          className={cn("px-1.5 py-0 text-[10px]", getPriorityColor(task.priority))}
        >
          {formatStatus(task.priority)}
        </Badge>
        <Badge
          variant="secondary"
          className={cn("px-1.5 py-0 text-[10px]", getTypeColor(task.type))}
        >
          {formatStatus(task.type)}
        </Badge>
        <ClaimStateBadge state={task.claimState} className="px-1.5 py-0 text-[10px]" />
      </div>

      {/* Bottom row: assignee */}
      <div className="flex items-center justify-end gap-2">
        {/* Assignee initials */}
        <div
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
            assigneeName
              ? "bg-primary/10 text-primary"
              : "border-muted-foreground/30 text-muted-foreground/40 border border-dashed",
          )}
          title={assigneeName ?? "Unassigned"}
        >
          {assigneeName ? getInitials(assigneeName) : "?"}
        </div>
      </div>
    </div>
  );
}

// ---- Sortable Task Card ----

interface SortableTaskCardProps extends TaskCardProps {
  id: string;
}

function SortableTaskCard({ id, ...props }: SortableTaskCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} className={cn("relative", isDragging && "opacity-30")}>
      {/* Drag handle */}
      <div
        className="absolute bottom-0 left-0 top-0 z-10 flex w-6 cursor-grab items-center justify-center opacity-0 active:cursor-grabbing group-hover:opacity-100"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="text-muted-foreground size-3.5" />
      </div>
      <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing">
        <TaskCard {...props} />
      </div>
    </div>
  );
}

// ---- Column ----

interface BoardColumnProps {
  status: string;
  tasks: Task[];
  epicMap: Map<string, string>;
  userMap: Map<string, string>;
  isOver: boolean;
  onTaskClick: (taskId: string) => void;
  groupByEpic?: boolean;
}

function BoardColumn({
  status,
  tasks,
  epicMap,
  userMap,
  isOver,
  onTaskClick,
  groupByEpic = false,
}: BoardColumnProps) {
  const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks]);

  // Group tasks by epic within the column
  const epicGroups = useMemo(() => {
    if (!groupByEpic) return null;
    const groups = new Map<string | null, Task[]>();
    for (const task of tasks) {
      const key = task.epicId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(task);
    }
    // Sort: named epics alphabetically, "No Epic" last
    return Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === null) return 1;
      if (b === null) return -1;
      const nameA = epicMap.get(a) ?? "";
      const nameB = epicMap.get(b) ?? "";
      return nameA.localeCompare(nameB);
    });
  }, [tasks, groupByEpic, epicMap]);

  return (
    <div
      className={cn(
        "bg-muted/30 flex max-h-full w-[280px] min-w-[280px] flex-col rounded-xl border transition-colors",
        isOver && "ring-primary/40 bg-primary/5 ring-2",
      )}
    >
      {/* Column header */}
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <Badge variant="secondary" className={cn("text-xs", getStatusColor(status))}>
          {formatStatus(status)}
        </Badge>
        <span className="text-muted-foreground text-xs font-medium">{tasks.length}</span>
      </div>

      {/* Card list */}
      <ScrollArea className="flex-1 p-2">
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          <div className="min-h-[60px] space-y-2">
            {epicGroups
              ? epicGroups.map(([epicId, groupTasks]) => {
                  const epicName = epicId ? (epicMap.get(epicId) ?? "Unknown Epic") : "No Epic";
                  const color = getEpicColor(epicId);
                  return (
                    <div key={epicId ?? "__no_epic__"} className="space-y-1.5">
                      {/* Epic group header */}
                      <div className="flex items-center gap-1.5 px-1 pt-1">
                        <span className={cn("size-2 shrink-0 rounded-full", color.dot)} />
                        <span className="text-muted-foreground truncate text-[11px] font-medium">
                          {epicName}
                        </span>
                        <span className="text-muted-foreground/60 text-[10px]">
                          {groupTasks.length}
                        </span>
                      </div>
                      {groupTasks.map((task) => (
                        <SortableTaskCard
                          key={task.id}
                          id={task.id}
                          task={task}
                          epicName={task.epicId ? epicMap.get(task.epicId) : undefined}
                          assigneeName={task.assigneeId ? userMap.get(task.assigneeId) : undefined}
                          onClick={onTaskClick}
                        />
                      ))}
                    </div>
                  );
                })
              : tasks.map((task) => (
                  <SortableTaskCard
                    key={task.id}
                    id={task.id}
                    task={task}
                    epicName={task.epicId ? epicMap.get(task.epicId) : undefined}
                    assigneeName={task.assigneeId ? userMap.get(task.assigneeId) : undefined}
                    onClick={onTaskClick}
                  />
                ))}
          </div>
        </SortableContext>
      </ScrollArea>
    </div>
  );
}

// ---- Column skeleton ----

function ColumnSkeleton() {
  return (
    <div className="bg-muted/30 flex w-[280px] min-w-[280px] flex-col rounded-xl border">
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-4 w-5" />
      </div>
      <div className="space-y-2 p-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-card space-y-2 rounded-lg border p-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <div className="flex gap-1.5">
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-4 w-10" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Swimlane Section ----

interface SwimlaneProps {
  label: string;
  tasks: Task[];
  epicMap: Map<string, string>;
  userMap: Map<string, string>;
  overColumnStatus: string | null;
  onTaskClick: (taskId: string) => void;
}

function SwimlaneSection({
  label,
  tasks,
  epicMap,
  userMap,
  overColumnStatus,
  onTaskClick,
}: SwimlaneProps) {
  const tasksByStatus = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const s of BOARD_STATUSES) {
      map.set(s, []);
    }
    for (const task of tasks) {
      const arr = map.get(task.status);
      if (arr) arr.push(task);
    }
    return map;
  }, [tasks]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <h3 className="text-muted-foreground text-sm font-semibold">{label}</h3>
        <span className="text-muted-foreground/60 text-xs">({tasks.length})</span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {BOARD_STATUSES.map((status) => (
          <BoardColumn
            key={`${label}-${status}`}
            status={status}
            tasks={tasksByStatus.get(status) ?? []}
            epicMap={epicMap}
            userMap={userMap}
            isOver={overColumnStatus === status}
            onTaskClick={onTaskClick}
          />
        ))}
      </div>
    </div>
  );
}

// ---- Main Board Page ----

export function BoardPage() {
  const { projectId, epicId } = useParams({ strict: false });
  const isEpicScoped = !!epicId;
  const navigate = useNavigate();
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  // Fetch project details
  const { data: project } = useProject(projectId);
  useEffect(() => {
    if (project) {
      setCurrentProject(project.id, project.name);
    }
  }, [project, setCurrentProject]);

  // Filter state
  const [priorityFilter, setPriorityFilter] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  const [epicFilter, setEpicFilter] = useState<string>("");
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebounce(searchInput, 300);
  const [groupByEpic, setGroupByEpic] = useState(false);

  // Build filter object (exclude board-excluded statuses, get all board tasks)
  const effectivePriority = priorityFilter && priorityFilter !== "all" ? priorityFilter : "";
  const effectiveType = typeFilter && typeFilter !== "all" ? typeFilter : "";
  const effectiveAssignee = assigneeFilter && assigneeFilter !== "all" ? assigneeFilter : "";
  // When epic-scoped, the epic is pinned to the route param (the dropdown is
  // hidden); otherwise it comes from the dropdown.
  const effectiveEpic = isEpicScoped
    ? epicId!
    : epicFilter && epicFilter !== "all"
      ? epicFilter
      : "";

  const filters: TaskFilters = useMemo(
    () => ({
      ...(effectivePriority ? { priority: effectivePriority } : {}),
      ...(effectiveType ? { type: effectiveType } : {}),
      ...(effectiveAssignee ? { assignee: effectiveAssignee } : {}),
      ...(effectiveEpic ? { epic: effectiveEpic } : {}),
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      // Project-wide board: fetch only open work so `done` doesn't load an
      // infinite list (the `done` column still renders, just empty by default).
      // Epic-scoped board: bounded by construction — fetch ALL statuses incl done.
      ...(isEpicScoped ? {} : { status: OPEN_WORK_STATUSES }),
      perPage: 100, // Max allowed by API
    }),
    [
      effectivePriority,
      effectiveType,
      effectiveAssignee,
      effectiveEpic,
      debouncedSearch,
      isEpicScoped,
    ],
  );

  const { data, isLoading, error, refetch } = useTasks(projectId, filters);
  const { data: epics } = useEpics(projectId);
  const { data: users } = useUsers();

  // Build lookup maps
  const epicMap = useMemo(() => {
    const map = new Map<string, string>();
    if (epics) {
      for (const epic of epics) {
        map.set(epic.id, epic.name);
      }
    }
    return map;
  }, [epics]);

  const userMap = useMemo(() => {
    const map = new Map<string, string>();
    if (users) {
      for (const user of users) {
        map.set(user.id, user.displayName);
      }
    }
    return map;
  }, [users]);

  // All tasks filtered to board-eligible statuses
  const allTasks = useMemo(() => {
    const tasks = data?.data ?? [];
    return tasks.filter((t) => (BOARD_STATUSES as readonly string[]).includes(t.status));
  }, [data]);

  // Drag state
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [overColumnStatus, setOverColumnStatus] = useState<string | null>(null);
  // Optimistic state: temporarily moved tasks
  const [optimisticMoves, setOptimisticMoves] = useState<Map<string, string>>(new Map());

  const transitionMutation = useTransitionTask();

  // The pinned epic (epic-scoped board) is NOT a user-clearable filter, so it
  // must not light up "Clear filters" — only the dropdown epic filter counts.
  const epicDropdownFilter = !isEpicScoped && epicFilter && epicFilter !== "all" ? epicFilter : "";

  const hasActiveFilters = !!(
    effectivePriority ||
    effectiveType ||
    effectiveAssignee ||
    epicDropdownFilter ||
    searchInput
  );

  function clearFilters() {
    setPriorityFilter("");
    setTypeFilter("");
    setAssigneeFilter("");
    setEpicFilter("");
    setSearchInput("");
  }

  function handleTaskClick(taskId: string) {
    navigate({ to: "/tasks/$taskId", params: { taskId } });
  }

  // DnD sensors with activation constraints to allow clicks
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor),
  );

  // Determine which column a task belongs to based on optimistic moves
  const getEffectiveStatus = useCallback(
    (task: Task): string => {
      return optimisticMoves.get(task.id) ?? task.status;
    },
    [optimisticMoves],
  );

  // Apply optimistic moves to task grouping
  const effectiveTasksByStatus = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const s of BOARD_STATUSES) {
      map.set(s, []);
    }
    for (const task of allTasks) {
      const effectiveStatus = getEffectiveStatus(task);
      const arr = map.get(effectiveStatus);
      if (arr) arr.push(task);
    }
    return map;
  }, [allTasks, getEffectiveStatus]);

  // Apply optimistic moves for swimlane grouping too
  const effectiveTasksByEpic = useMemo(() => {
    if (!groupByEpic) return null;
    const map = new Map<string | null, Task[]>();
    for (const task of allTasks) {
      const key = task.epicId;
      if (!map.has(key)) map.set(key, []);
      // Create a virtual task with the effective status for rendering
      const effectiveStatus = getEffectiveStatus(task);
      if (effectiveStatus !== task.status) {
        map.get(key)!.push({ ...task, status: effectiveStatus });
      } else {
        map.get(key)!.push(task);
      }
    }
    return map;
  }, [allTasks, groupByEpic, getEffectiveStatus]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const task = allTasks.find((t) => t.id === event.active.id);
      if (task) setActiveTask(task);
    },
    [allTasks],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { over } = event;
      if (!over) {
        setOverColumnStatus(null);
        return;
      }

      // Determine which column is being dragged over
      const overId = String(over.id);

      // Check if over ID is a status column
      if ((BOARD_STATUSES as readonly string[]).includes(overId)) {
        setOverColumnStatus(overId);
        return;
      }

      // Check if over a task - find what column that task is in
      const overTask = allTasks.find((t) => t.id === overId);
      if (overTask) {
        setOverColumnStatus(getEffectiveStatus(overTask));
      }
    },
    [allTasks, getEffectiveStatus],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveTask(null);
      setOverColumnStatus(null);

      if (!over) return;

      const taskId = String(active.id);
      const task = allTasks.find((t) => t.id === taskId);
      if (!task) return;

      // Determine target status
      let targetStatus: string | null = null;
      const overId = String(over.id);

      if ((BOARD_STATUSES as readonly string[]).includes(overId)) {
        targetStatus = overId;
      } else {
        // Dropped on a task - find its column
        const overTask = allTasks.find((t) => t.id === overId);
        if (overTask) {
          targetStatus = getEffectiveStatus(overTask);
        }
      }

      if (!targetStatus) return;

      const currentStatus = getEffectiveStatus(task);
      if (targetStatus === currentStatus) return;

      // Optimistic update
      setOptimisticMoves((prev) => {
        const next = new Map(prev);
        next.set(taskId, targetStatus);
        return next;
      });

      // Call API
      transitionMutation.mutate(
        { taskId, toStatus: targetStatus },
        {
          onSuccess: () => {
            // Remove optimistic move on success (query invalidation will refresh)
            setOptimisticMoves((prev) => {
              const next = new Map(prev);
              next.delete(taskId);
              return next;
            });
          },
          onError: (err) => {
            // Revert optimistic move
            setOptimisticMoves((prev) => {
              const next = new Map(prev);
              next.delete(taskId);
              return next;
            });
            const message = err instanceof Error ? err.message : "Failed to transition task";
            toast.error("Transition failed", {
              description: message,
            });
          },
        },
      );
    },
    [allTasks, getEffectiveStatus, transitionMutation],
  );

  return (
    <div className="flex h-full flex-col space-y-4">
      {/* Page header */}
      {isEpicScoped ? (
        <div className="flex shrink-0 flex-col gap-1">
          <Link
            to="/epics/$epicId"
            params={{ epicId: epicId! }}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
          >
            <ArrowLeft className="size-4" />
            Back to epic
          </Link>
          <div className="flex items-center gap-3">
            <Kanban className="text-muted-foreground size-6" />
            <h1 className="text-2xl font-bold tracking-tight">
              {epicMap.get(epicId!) ?? "Epic board"}
            </h1>
            <Badge variant="outline" className="text-xs font-normal">
              Board
            </Badge>
          </div>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-3">
          <Kanban className="text-muted-foreground size-6" />
          <h1 className="text-2xl font-bold tracking-tight">Board</h1>
          {project && (
            <Badge variant="outline" className="text-xs font-normal">
              {project.name}
            </Badge>
          )}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="border-destructive/50 bg-destructive/10 flex shrink-0 flex-col items-center gap-3 rounded-lg border py-8">
          <p className="text-destructive text-sm">Failed to load tasks. Please try again.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative w-64">
          <Search className="text-muted-foreground absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
          <Input
            placeholder="Search tasks..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-9 pl-9"
          />
        </div>

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

        {/* Assignee filter */}
        <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
          <SelectTrigger size="sm" className="w-[140px]">
            <SelectValue placeholder="Assignee" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All assignees</SelectItem>
            {users?.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Epic filter — hidden when the board is already scoped to one epic */}
        {!isEpicScoped && (
          <Select value={epicFilter} onValueChange={setEpicFilter}>
            <SelectTrigger size="sm" className="w-[140px]">
              <SelectValue placeholder="Epic" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All epics</SelectItem>
              {epics?.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Clear filters */}
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="size-4" />
            Clear filters
          </Button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Group by epic toggle — pointless on a single-epic board */}
        {!isEpicScoped && (
          <Button
            variant={groupByEpic ? "secondary" : "outline"}
            size="sm"
            onClick={() => setGroupByEpic((v) => !v)}
          >
            <Layers className="mr-1 size-4" />
            Group by Epic
          </Button>
        )}
      </div>

      {/* Board */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="min-h-0 flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex h-full gap-3">
              {BOARD_STATUSES.map((status) => (
                <ColumnSkeleton key={status} />
              ))}
            </div>
          ) : groupByEpic && effectiveTasksByEpic ? (
            <div className="space-y-6">
              {/* Epics with tasks */}
              {Array.from(effectiveTasksByEpic.entries())
                .sort(([a], [b]) => {
                  // "No Epic" (null) goes last
                  if (a === null) return 1;
                  if (b === null) return -1;
                  const nameA = epicMap.get(a) ?? "";
                  const nameB = epicMap.get(b) ?? "";
                  return nameA.localeCompare(nameB);
                })
                .map(([epicId, tasks]) => (
                  <SwimlaneSection
                    key={epicId ?? "__no_epic__"}
                    label={epicId ? (epicMap.get(epicId) ?? "Unknown Epic") : "No Epic"}
                    tasks={tasks}
                    epicMap={epicMap}
                    userMap={userMap}
                    overColumnStatus={overColumnStatus}
                    onTaskClick={handleTaskClick}
                  />
                ))}
            </div>
          ) : (
            <div className="flex h-full gap-3">
              {BOARD_STATUSES.map((status) => (
                <BoardColumn
                  key={status}
                  status={status}
                  tasks={effectiveTasksByStatus.get(status) ?? []}
                  epicMap={epicMap}
                  userMap={userMap}
                  isOver={overColumnStatus === status}
                  onTaskClick={handleTaskClick}
                  groupByEpic={!groupByEpic}
                />
              ))}
            </div>
          )}
        </div>

        {/* Drag overlay */}
        <DragOverlay>
          {activeTask && (
            <div className="w-[264px]">
              <TaskCard
                task={activeTask}
                epicName={activeTask.epicId ? epicMap.get(activeTask.epicId) : undefined}
                assigneeName={
                  activeTask.assigneeId ? userMap.get(activeTask.assigneeId) : undefined
                }
                onClick={() => {}}
                isDragOverlay
              />
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
