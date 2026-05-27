import { useState, useRef, useEffect } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  ListTodo,
  Milestone as MilestoneIcon,
  Pencil,
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
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useEpic, useUpdateEpic } from "@/hooks/use-epics";
import { useTasks } from "@/hooks/use-tasks";
import { useMilestones } from "@/hooks/use-milestones";
import { useProjectStore } from "@/stores/project-store";
import {
  formatRelativeTime,
  formatStatus,
  getStatusColor,
  getPriorityColor,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Task } from "@/lib/api";

// ---- Constants ----

const EPIC_STATUSES = ["draft", "active", "completed", "cancelled"] as const;
const PRIORITIES = ["critical", "high", "medium", "low"] as const;

const TASK_STATUSES_ORDER = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;

// ---- Inline editable title ----

function EditableTitle({
  value,
  onSave,
}: {
  value: string;
  onSave: (newTitle: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function save() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) {
      onSave(trimmed);
    } else {
      setDraft(value);
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <Input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        className="h-auto text-2xl font-bold"
      />
    );
  }

  return (
    <button
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
      className="group flex items-center gap-2 text-left"
    >
      <h1 className="text-2xl font-bold tracking-tight">{value}</h1>
      <Pencil className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

// ---- Metadata field ----

function MetadataField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

// ---- Task table row ----

function EpicTaskRow({
  task,
  onClick,
}: {
  task: Task;
  onClick: () => void;
}) {
  return (
    <TableRow className="cursor-pointer" onClick={onClick}>
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
      <TableCell className="text-sm text-muted-foreground">
        {task.assigneeId ?? (
          <span className="italic text-muted-foreground/50">Unassigned</span>
        )}
      </TableCell>
    </TableRow>
  );
}

// ---- Main page ----

export function EpicDetailPage() {
  const { epicId } = useParams({ strict: false });
  const navigate = useNavigate();
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const { data: epic, isLoading, error, refetch } = useEpic(epicId);
  const updateEpic = useUpdateEpic();

  // Fetch milestones for the dropdown
  const projectId = epic?.projectId ?? currentProjectId;
  const { data: milestones } = useMilestones(projectId ?? undefined);

  // Fetch tasks scoped to this epic
  const { data: tasksData, isLoading: tasksLoading } = useTasks(
    projectId ?? undefined,
    epicId ? { epic: epicId, perPage: 100 } : undefined,
  );

  const tasks = tasksData?.data ?? [];

  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");

  const hasProject = !!currentProjectId;

  // ---- Progress calculations ----
  const { total, done } = epic?.taskSummary ?? { total: 0, done: 0 };
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;
  const byStatus = epic?.taskSummary?.byStatus ?? {};

  // ---- Loading state ----
  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-24 w-full" />
        <Separator />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  // ---- Error/not-found state ----
  if (error || !epic) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        {hasProject ? (
          <Link
            to="/projects/$projectId/epics"
            params={{ projectId: currentProjectId! }}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Back to epics
          </Link>
        ) : (
          <Link
            to="/projects"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Back to projects
          </Link>
        )}
        <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 py-8">
          <p className="text-sm text-destructive">
            {error ? "Failed to load epic." : "Epic not found."}
          </p>
          {error && (
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          )}
        </div>
      </div>
    );
  }

  // ---- Handlers ----
  function handleTitleSave(newTitle: string) {
    if (!epicId) return;
    updateEpic.mutate({ id: epicId, data: { name: newTitle } });
  }

  function handleDescriptionSave() {
    if (!epicId) return;
    updateEpic.mutate({
      id: epicId,
      data: { description: descriptionDraft.trim() || null },
    });
    setEditingDescription(false);
  }

  function handleFieldChange(field: string, value: string | null) {
    if (!epicId) return;
    updateEpic.mutate({
      id: epicId,
      data: { [field]: value },
    });
  }

  function handleTaskClick(taskId: string) {
    navigate({ to: "/tasks/$taskId", params: { taskId } });
  }

  // Find milestone name for display
  const currentMilestone = milestones?.find((m) => m.id === epic.milestoneId);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Back link */}
      {hasProject ? (
        <Link
          to="/projects/$projectId/epics"
          params={{ projectId: currentProjectId! }}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to epics
        </Link>
      ) : (
        <Link
          to="/projects"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to projects
        </Link>
      )}

      {/* Header */}
      <div className="space-y-2">
        <EditableTitle value={epic.name} onSave={handleTitleSave} />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Created {formatRelativeTime(epic.createdAt)}</span>
        </div>
      </div>

      <Separator />

      {/* Two-column layout: main + metadata sidebar */}
      <div className="grid gap-6 md:grid-cols-[1fr_280px]">
        {/* Main content (left) */}
        <div className="space-y-6">
          {/* Description */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted-foreground">
                Description
              </h2>
              {!editingDescription && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setDescriptionDraft(epic.description ?? "");
                    setEditingDescription(true);
                  }}
                >
                  <Pencil className="size-3" />
                  Edit
                </Button>
              )}
            </div>

            {editingDescription ? (
              <div className="space-y-2">
                <Textarea
                  value={descriptionDraft}
                  onChange={(e) => setDescriptionDraft(e.target.value)}
                  rows={8}
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setEditingDescription(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="xs"
                    onClick={handleDescriptionSave}
                    disabled={updateEpic.isPending}
                  >
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border bg-muted/30 p-4">
                {epic.description ? (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {epic.description}
                  </p>
                ) : (
                  <p className="text-sm italic text-muted-foreground/50">
                    No description provided. Click Edit to add one.
                  </p>
                )}
              </div>
            )}
          </section>

          {/* Progress section */}
          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              Progress
            </h2>

            {/* Progress bar */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {done} of {total} task{total === 1 ? "" : "s"} done
                </span>
                <span>{progressPct}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted">
                <div
                  className={cn(
                    "h-2 rounded-full transition-all",
                    progressPct === 100 ? "bg-green-500" : "bg-blue-500",
                  )}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>

            {/* Task count badges by status */}
            {total > 0 && (
              <div className="flex flex-wrap gap-2">
                {TASK_STATUSES_ORDER.map((s) => {
                  const count = byStatus[s] ?? 0;
                  if (count === 0) return null;
                  return (
                    <Badge
                      key={s}
                      variant="secondary"
                      className={cn("text-[11px]", getStatusColor(s))}
                    >
                      {formatStatus(s)}: {count}
                    </Badge>
                  );
                })}
              </div>
            )}
          </section>

          <Separator />

          {/* Task list */}
          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <ListTodo className="size-4" />
              Tasks
              {tasks.length > 0 && (
                <Badge variant="secondary" className="text-[10px]">
                  {tasks.length}
                </Badge>
              )}
            </h2>

            {tasksLoading && (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            )}

            {!tasksLoading && tasks.length === 0 && (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-8">
                <ListTodo className="mb-2 size-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  No tasks in this epic yet.
                </p>
              </div>
            )}

            {!tasksLoading && tasks.length > 0 && (
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[250px]">Title</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead>Assignee</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tasks.map((task) => (
                      <EpicTaskRow
                        key={task.id}
                        task={task}
                        onClick={() => handleTaskClick(task.id)}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>
        </div>

        {/* Metadata panel (right sidebar) */}
        <div className="space-y-1 rounded-lg border bg-card p-4">
          <h3 className="mb-3 text-sm font-medium">Details</h3>

          {/* Status */}
          <MetadataField label="Status">
            <Select
              value={epic.status}
              onValueChange={(value) => handleFieldChange("status", value)}
            >
              <SelectTrigger size="sm" className="h-7 w-[130px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EPIC_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          "inline-block size-2 rounded-full",
                          getStatusColor(s).replace(/text-\S+/g, "").trim(),
                        )}
                      />
                      {formatStatus(s)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </MetadataField>

          {/* Priority */}
          <MetadataField label="Priority">
            <Select
              value={epic.priority}
              onValueChange={(value) => handleFieldChange("priority", value)}
            >
              <SelectTrigger size="sm" className="h-7 w-[130px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    <Badge
                      variant="secondary"
                      className={cn("text-[10px]", getPriorityColor(p))}
                    >
                      {formatStatus(p)}
                    </Badge>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </MetadataField>

          {/* Milestone */}
          <MetadataField label="Milestone">
            <Select
              value={epic.milestoneId ?? "__none__"}
              onValueChange={(value) =>
                handleFieldChange(
                  "milestoneId",
                  value === "__none__" ? null : value,
                )
              }
            >
              <SelectTrigger size="sm" className="h-7 w-[130px] text-xs">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {milestones?.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <span className="flex items-center gap-1.5">
                      <MilestoneIcon className="size-3" />
                      {m.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </MetadataField>

          <Separator className="my-2" />

          {/* Target date */}
          <MetadataField label="Target date">
            <span className="text-sm">
              {epic.targetDate ? (
                new Date(epic.targetDate).toLocaleDateString()
              ) : (
                <span className="italic text-muted-foreground/60">
                  Not set
                </span>
              )}
            </span>
          </MetadataField>

          {/* Created by */}
          <MetadataField label="Created by">
            <span className="text-sm">
              {epic.createdBy ?? (
                <span className="italic text-muted-foreground/60">
                  System
                </span>
              )}
            </span>
          </MetadataField>

          {/* Milestone display (name) */}
          {currentMilestone && (
            <MetadataField label="Milestone target">
              <span className="text-xs text-muted-foreground">
                {currentMilestone.targetDate
                  ? new Date(currentMilestone.targetDate).toLocaleDateString()
                  : "No date"}
              </span>
            </MetadataField>
          )}

          {/* Proposal link */}
          {epic.proposalId && (
            <>
              <Separator className="my-2" />
              <div className="py-2">
                <span className="text-sm text-muted-foreground">
                  Created from proposal:{" "}
                </span>
                <Link
                  to="/proposals/$proposalId"
                  params={{ proposalId: epic.proposalId }}
                  className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  View proposal
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
