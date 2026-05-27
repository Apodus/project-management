import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
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
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  GripVertical,
  Kanban,
  Search,
  X,
  Layers,
} from "lucide-react";
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
import { useProject } from "@/hooks/use-projects";
import { useTasks, useTransitionTask } from "@/hooks/use-tasks";
import { useEpics } from "@/hooks/use-epics";
import { useUsers } from "@/hooks/use-users";
import { useProjectStore } from "@/stores/project-store";
import {
  formatStatus,
  getStatusColor,
  getPriorityColor,
  getTypeColor,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Task, TaskFilters } from "@/lib/api";

// ---- Constants ----

const BOARD_STATUSES = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "done",
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

function getPriorityDotColor(priority: string): string {
  switch (priority) {
    case "critical":
      return "bg-red-500";
    case "high":
      return "bg-orange-500";
    case "medium":
      return "bg-blue-500";
    case "low":
      return "bg-gray-400";
    default:
      return "bg-gray-400";
  }
}

// ---- Task Card ----

interface TaskCardProps {
  task: Task;
  epicName?: string;
  assigneeName?: string;
  onClick: (taskId: string) => void;
  isDragOverlay?: boolean;
}

function TaskCard({
  task,
  epicName,
  assigneeName,
  onClick,
  isDragOverlay,
}: TaskCardProps) {
  return (
    <div
      className={cn(
        "group rounded-lg border bg-card p-3 shadow-sm transition-shadow hover:shadow-md cursor-pointer",
        isDragOverlay && "shadow-lg ring-2 ring-primary/20 rotate-1",
      )}
      onClick={(e) => {
        e.stopPropagation();
        onClick(task.id);
      }}
    >
      {/* Title */}
      <p className="text-sm font-medium leading-snug line-clamp-2 mb-2">
        {task.title}
      </p>

      {/* Priority + Type badges row */}
      <div className="flex items-center gap-1.5 mb-2 flex-wrap">
        <Badge
          variant="secondary"
          className={cn("text-[10px] px-1.5 py-0", getPriorityColor(task.priority))}
        >
          {formatStatus(task.priority)}
        </Badge>
        <Badge
          variant="secondary"
          className={cn("text-[10px] px-1.5 py-0", getTypeColor(task.type))}
        >
          {formatStatus(task.type)}
        </Badge>
      </div>

      {/* Bottom row: epic + assignee */}
      <div className="flex items-center justify-between gap-2">
        {/* Epic name */}
        <div className="flex-1 min-w-0">
          {epicName ? (
            <span className="text-[11px] text-muted-foreground truncate block">
              {epicName}
            </span>
          ) : null}
        </div>

        {/* Assignee initials */}
        <div
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
            assigneeName
              ? "bg-primary/10 text-primary"
              : "border border-dashed border-muted-foreground/30 text-muted-foreground/40",
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
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative",
        isDragging && "opacity-30",
      )}
    >
      {/* Drag handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-6 flex items-center justify-center opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing z-10"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5 text-muted-foreground" />
      </div>
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing"
      >
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
}

function BoardColumn({
  status,
  tasks,
  epicMap,
  userMap,
  isOver,
  onTaskClick,
}: BoardColumnProps) {
  const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks]);

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border bg-muted/30 min-w-[280px] w-[280px] max-h-full transition-colors",
        isOver && "ring-2 ring-primary/40 bg-primary/5",
      )}
    >
      {/* Column header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b">
        <Badge
          variant="secondary"
          className={cn("text-xs", getStatusColor(status))}
        >
          {formatStatus(status)}
        </Badge>
        <span className="text-xs text-muted-foreground font-medium">
          {tasks.length}
        </span>
      </div>

      {/* Card list */}
      <ScrollArea className="flex-1 p-2">
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          <div className="space-y-2 min-h-[60px]">
            {tasks.map((task) => (
              <SortableTaskCard
                key={task.id}
                id={task.id}
                task={task}
                epicName={task.epicId ? epicMap.get(task.epicId) : undefined}
                assigneeName={
                  task.assigneeId ? userMap.get(task.assigneeId) : undefined
                }
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
    <div className="flex flex-col rounded-xl border bg-muted/30 min-w-[280px] w-[280px]">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-4 w-5" />
      </div>
      <div className="p-2 space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-lg border bg-card p-3 space-y-2">
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
        <h3 className="text-sm font-semibold text-muted-foreground">{label}</h3>
        <span className="text-xs text-muted-foreground/60">
          ({tasks.length})
        </span>
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
  const { projectId } = useParams({ strict: false });
  const navigate = useNavigate();
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  // Fetch project details
  const { data: project } = useProject(projectId);
  if (project) {
    setCurrentProject(project.id, project.name);
  }

  // Filter state
  const [priorityFilter, setPriorityFilter] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  const [epicFilter, setEpicFilter] = useState<string>("");
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebounce(searchInput, 300);
  const [groupByEpic, setGroupByEpic] = useState(false);

  // Build filter object (exclude board-excluded statuses, get all board tasks)
  const effectivePriority =
    priorityFilter && priorityFilter !== "all" ? priorityFilter : "";
  const effectiveType =
    typeFilter && typeFilter !== "all" ? typeFilter : "";
  const effectiveAssignee =
    assigneeFilter && assigneeFilter !== "all" ? assigneeFilter : "";
  const effectiveEpic =
    epicFilter && epicFilter !== "all" ? epicFilter : "";

  const filters: TaskFilters = useMemo(
    () => ({
      ...(effectivePriority ? { priority: effectivePriority } : {}),
      ...(effectiveType ? { type: effectiveType } : {}),
      ...(effectiveAssignee ? { assignee: effectiveAssignee } : {}),
      ...(effectiveEpic ? { epic: effectiveEpic } : {}),
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      perPage: 100, // Max allowed by API
    }),
    [effectivePriority, effectiveType, effectiveAssignee, effectiveEpic, debouncedSearch],
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
    return tasks.filter((t) =>
      (BOARD_STATUSES as readonly string[]).includes(t.status),
    );
  }, [data]);

  // Group tasks by status
  const tasksByStatus = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const s of BOARD_STATUSES) {
      map.set(s, []);
    }
    for (const task of allTasks) {
      const arr = map.get(task.status);
      if (arr) arr.push(task);
    }
    return map;
  }, [allTasks]);

  // Group tasks by epic (for swimlanes)
  const tasksByEpic = useMemo(() => {
    if (!groupByEpic) return null;
    const map = new Map<string | null, Task[]>();
    for (const task of allTasks) {
      const key = task.epicId;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(task);
    }
    return map;
  }, [allTasks, groupByEpic]);

  // Drag state
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [overColumnStatus, setOverColumnStatus] = useState<string | null>(null);
  // Optimistic state: temporarily moved tasks
  const [optimisticMoves, setOptimisticMoves] = useState<
    Map<string, string>
  >(new Map());

  const transitionMutation = useTransitionTask();

  const hasActiveFilters = !!(
    effectivePriority ||
    effectiveType ||
    effectiveAssignee ||
    effectiveEpic ||
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
            const message =
              err instanceof Error ? err.message : "Failed to transition task";
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
    <div className="flex flex-col h-full space-y-4">
      {/* Page header */}
      <div className="flex items-center gap-3 shrink-0">
        <Kanban className="size-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">Board</h1>
        {project && (
          <Badge variant="outline" className="text-xs font-normal">
            {project.name}
          </Badge>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 py-8 shrink-0">
          <p className="text-sm text-destructive">
            Failed to load tasks. Please try again.
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 shrink-0">
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

        {/* Epic filter */}
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

        {/* Clear filters */}
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="size-4" />
            Clear filters
          </Button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Group by epic toggle */}
        <Button
          variant={groupByEpic ? "secondary" : "outline"}
          size="sm"
          onClick={() => setGroupByEpic((v) => !v)}
        >
          <Layers className="size-4 mr-1" />
          Group by Epic
        </Button>
      </div>

      {/* Board */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="flex-1 overflow-auto min-h-0">
          {isLoading ? (
            <div className="flex gap-3 h-full">
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
                    label={
                      epicId ? epicMap.get(epicId) ?? "Unknown Epic" : "No Epic"
                    }
                    tasks={tasks}
                    epicMap={epicMap}
                    userMap={userMap}
                    overColumnStatus={overColumnStatus}
                    onTaskClick={handleTaskClick}
                  />
                ))}
            </div>
          ) : (
            <div className="flex gap-3 h-full">
              {BOARD_STATUSES.map((status) => (
                <BoardColumn
                  key={status}
                  status={status}
                  tasks={effectiveTasksByStatus.get(status) ?? []}
                  epicMap={epicMap}
                  userMap={userMap}
                  isOver={overColumnStatus === status}
                  onTaskClick={handleTaskClick}
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
                epicName={
                  activeTask.epicId
                    ? epicMap.get(activeTask.epicId)
                    : undefined
                }
                assigneeName={
                  activeTask.assigneeId
                    ? userMap.get(activeTask.assigneeId)
                    : undefined
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
