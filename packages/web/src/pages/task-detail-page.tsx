import { useState, useRef, useEffect } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRightLeft,
  BarChart3,
  Code2,
  ExternalLink,
  FileText,
  Gavel,
  GitBranch,
  ListChecks,
  MessageCircleQuestion,
  MessageSquare,
  Pencil,
  Send,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import {
  useTask,
  useUpdateTask,
  useTaskComments,
  useTaskSubtasks,
  useAddTaskComment,
} from "@/hooks/use-tasks";
import { useProjectStore } from "@/stores/project-store";
import {
  formatRelativeTime,
  formatStatus,
  getStatusColor,
  getPriorityColor,
  getTypeColor,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Task, TaskComment } from "@/lib/api";

// ---- Constants ----

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

const EFFORTS = ["xs", "s", "m", "l", "xl"] as const;

const EFFORT_LABELS: Record<string, string> = {
  xs: "XS",
  s: "S",
  m: "M",
  l: "L",
  xl: "XL",
};

// ---- Comment type icons ----

function CommentTypeIcon({ type }: { type: string }) {
  switch (type) {
    case "progress_update":
      return <BarChart3 className="size-3.5" />;
    case "decision":
      return <Gavel className="size-3.5" />;
    case "handoff":
      return <ArrowRightLeft className="size-3.5" />;
    case "question":
      return <MessageCircleQuestion className="size-3.5" />;
    default:
      return null;
  }
}

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

// ---- Comment item ----

function TaskCommentItem({ comment }: { comment: TaskComment }) {
  const isAI =
    comment.authorId.startsWith("ai-") || comment.authorId === "ai_agent";
  const isHandoff = comment.commentType === "handoff";
  const metadata = comment.metadata as Record<string, unknown> | undefined;

  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        isHandoff
          ? "border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/20"
          : isAI
            ? "border-blue-200 bg-blue-50/50 dark:border-blue-900/50 dark:bg-blue-950/20"
            : "border-border bg-card",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "flex size-6 items-center justify-center rounded-full text-xs font-medium",
              isAI
                ? "bg-blue-600 text-white"
                : "bg-primary text-primary-foreground",
            )}
          >
            {isAI ? "AI" : "H"}
          </div>
          <span className="text-sm font-medium">
            {isAI ? "AI Agent" : "Human Director"}
          </span>
          {comment.commentType && comment.commentType !== "comment" && (
            <Badge
              variant="outline"
              className="flex items-center gap-1 text-[10px]"
            >
              <CommentTypeIcon type={comment.commentType} />
              {formatStatus(comment.commentType)}
            </Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {formatRelativeTime(comment.createdAt)}
        </span>
      </div>
      <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
        {comment.body}
      </div>

      {/* Handoff structured content */}
      {isHandoff && metadata && (
        <div className="mt-3 space-y-2 rounded border bg-background/50 p-3 text-sm">
          {metadata.summary != null && (
            <div>
              <span className="font-medium">Summary: </span>
              <span>{String(metadata.summary)}</span>
            </div>
          )}
          {Array.isArray(metadata.files_changed) &&
            metadata.files_changed.length > 0 && (
              <div>
                <span className="font-medium">Files changed: </span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {metadata.files_changed.map((f: unknown, i: number) => (
                    <code
                      key={i}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
                    >
                      {String(f)}
                    </code>
                  ))}
                </div>
              </div>
            )}
          {Array.isArray(metadata.open_questions) &&
            metadata.open_questions.length > 0 && (
              <div>
                <span className="font-medium">Open questions: </span>
                <ul className="mt-1 list-inside list-disc">
                  {metadata.open_questions.map((q: unknown, i: number) => (
                    <li key={i}>{String(q)}</li>
                  ))}
                </ul>
              </div>
            )}
          {metadata.test_results != null && (
            <div>
              <span className="font-medium">Test results: </span>
              <span>{String(metadata.test_results)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Comment composer ----

function TaskCommentComposer({ taskId }: { taskId: string }) {
  const [body, setBody] = useState("");
  const addComment = useAddTaskComment();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;

    try {
      await addComment.mutateAsync({ taskId, body: body.trim() });
      setBody("");
      textareaRef.current?.focus();
    } catch {
      // Error handled by TanStack Query
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <Textarea
        ref={textareaRef}
        placeholder="Add a comment..."
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSubmit(e);
          }
        }}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Press Ctrl+Enter to send
        </span>
        <Button
          type="submit"
          size="sm"
          disabled={!body.trim() || addComment.isPending}
        >
          <Send className="size-4" />
          {addComment.isPending ? "Sending..." : "Add Comment"}
        </Button>
      </div>
    </form>
  );
}

// ---- Subtasks section ----

function SubtasksSection({ taskId }: { taskId: string }) {
  const navigate = useNavigate();
  const { data: subtasks, isLoading } = useTaskSubtasks(taskId);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <ListChecks className="size-4" />
          Subtasks
        </h3>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (!subtasks || subtasks.length === 0) return null;

  const doneCount = subtasks.filter((t) => t.status === "done").length;
  const progressPct =
    subtasks.length > 0 ? Math.round((doneCount / subtasks.length) * 100) : 0;

  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <ListChecks className="size-4" />
        Subtasks
        <span className="text-xs text-muted-foreground">
          {doneCount} of {subtasks.length} completed
        </span>
      </h3>

      {/* Progress bar */}
      <div className="h-2 w-full rounded-full bg-muted">
        <div
          className="h-2 rounded-full bg-green-500 transition-all"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Subtask list */}
      <div className="space-y-1.5">
        {subtasks.map((subtask) => (
          <Card
            key={subtask.id}
            className="cursor-pointer gap-0 py-2 transition-shadow hover:shadow-md"
            onClick={() =>
              navigate({
                to: "/tasks/$taskId",
                params: { taskId: subtask.id },
              })
            }
          >
            <CardContent className="flex items-center justify-between py-0">
              <div className="flex items-center gap-2">
                <FileText className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">{subtask.title}</span>
              </div>
              <Badge
                variant="secondary"
                className={cn("text-[10px]", getStatusColor(subtask.status))}
              >
                {formatStatus(subtask.status)}
              </Badge>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---- Context section ----

function ContextSection({ task }: { task: Task }) {
  const context = task.context as {
    relevant_files?: string[];
    codebase_areas?: string[];
    acceptance_criteria?: string[];
    design_references?: string[];
    notes?: string;
    implementation_hints?: string;
  } | null;

  if (!context) return null;

  const hasContent =
    (context.relevant_files && context.relevant_files.length > 0) ||
    (context.acceptance_criteria && context.acceptance_criteria.length > 0) ||
    context.implementation_hints ||
    (context.design_references && context.design_references.length > 0) ||
    context.notes;

  if (!hasContent) return null;

  return (
    <div className="space-y-4">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Code2 className="size-4" />
        Context
      </h3>

      {/* Relevant files */}
      {context.relevant_files && context.relevant_files.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Relevant files
          </p>
          <div className="flex flex-wrap gap-1.5">
            {context.relevant_files.map((file, i) => (
              <code
                key={i}
                className="rounded bg-muted px-2 py-0.5 font-mono text-xs"
              >
                {file}
              </code>
            ))}
          </div>
        </div>
      )}

      {/* Acceptance criteria */}
      {context.acceptance_criteria && context.acceptance_criteria.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Acceptance criteria
          </p>
          <ul className="space-y-1">
            {context.acceptance_criteria.map((criterion, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span className="mt-1 block size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                {criterion}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Implementation hints */}
      {context.implementation_hints && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Implementation hints
          </p>
          <p className="whitespace-pre-wrap text-sm">
            {context.implementation_hints}
          </p>
        </div>
      )}

      {/* Design references */}
      {context.design_references && context.design_references.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Design references
          </p>
          <div className="flex flex-col gap-1">
            {context.design_references.map((ref, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400"
              >
                <ExternalLink className="size-3" />
                {ref}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      {context.notes && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Notes
          </p>
          <p className="whitespace-pre-wrap text-sm">{context.notes}</p>
        </div>
      )}
    </div>
  );
}

// ---- Main page ----

export function TaskDetailPage() {
  const { taskId } = useParams({ strict: false });
  const { data: task, isLoading, error } = useTask(taskId);
  const { data: comments, isLoading: commentsLoading } =
    useTaskComments(taskId);
  const updateTask = useUpdateTask();
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");

  const hasProject = !!currentProjectId;

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-24 w-full" />
        <Separator />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        {hasProject ? (
          <Link
            to="/projects/$projectId/tasks"
            params={{ projectId: currentProjectId! }}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Back to tasks
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
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {error ? "Failed to load task." : "Task not found."}
        </div>
      </div>
    );
  }

  function handleTitleSave(newTitle: string) {
    if (!taskId) return;
    updateTask.mutate({ id: taskId, data: { title: newTitle } });
  }

  function handleDescriptionSave() {
    if (!taskId) return;
    updateTask.mutate({
      id: taskId,
      data: { description: descriptionDraft.trim() || null },
    });
    setEditingDescription(false);
  }

  function handleFieldChange(field: string, value: string | null) {
    if (!taskId) return;
    updateTask.mutate({
      id: taskId,
      data: { [field]: value },
    });
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Back link */}
      {hasProject ? (
        <Link
          to="/projects/$projectId/tasks"
          params={{ projectId: currentProjectId! }}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to tasks
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
        <EditableTitle value={task.title} onSave={handleTitleSave} />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Created {formatRelativeTime(task.createdAt)}</span>
          {task.gitBranch && (
            <>
              <span>-</span>
              <span className="inline-flex items-center gap-1 font-mono">
                <GitBranch className="size-3" />
                {task.gitBranch}
              </span>
            </>
          )}
        </div>
      </div>

      <Separator />

      {/* Two-column layout: metadata + description */}
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
                    setDescriptionDraft(task.description ?? "");
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
                    disabled={updateTask.isPending}
                  >
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border bg-muted/30 p-4">
                {task.description ? (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {task.description}
                  </p>
                ) : (
                  <p className="text-sm italic text-muted-foreground/50">
                    No description provided. Click Edit to add one.
                  </p>
                )}
              </div>
            )}
          </section>

          {/* Context */}
          <ContextSection task={task} />

          {/* Subtasks */}
          <SubtasksSection taskId={taskId!} />

          <Separator />

          {/* Comments */}
          <section className="space-y-4">
            <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <MessageSquare className="size-4" />
              Comments
              {comments && (
                <Badge variant="secondary" className="text-[10px]">
                  {comments.length}
                </Badge>
              )}
            </h2>

            {commentsLoading && (
              <div className="space-y-3">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            )}

            {!commentsLoading && comments && comments.length > 0 && (
              <div className="space-y-3">
                {comments.map((comment) => (
                  <TaskCommentItem key={comment.id} comment={comment} />
                ))}
              </div>
            )}

            {!commentsLoading &&
              (!comments || comments.length === 0) && (
                <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-8">
                  <MessageSquare className="mb-2 size-8 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">
                    No comments yet. Start the discussion below.
                  </p>
                </div>
              )}

            <div className="pt-2">
              <TaskCommentComposer taskId={taskId!} />
            </div>
          </section>
        </div>

        {/* Metadata panel (right sidebar) */}
        <div className="space-y-1 rounded-lg border bg-card p-4">
          <h3 className="mb-3 text-sm font-medium">Details</h3>

          {/* Status */}
          <MetadataField label="Status">
            <Select
              value={task.status}
              onValueChange={(value) => handleFieldChange("status", value)}
            >
              <SelectTrigger size="sm" className="h-7 w-[130px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TASK_STATUSES.map((s) => (
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
              value={task.priority}
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

          {/* Type */}
          <MetadataField label="Type">
            <Select
              value={task.type}
              onValueChange={(value) => handleFieldChange("type", value)}
            >
              <SelectTrigger size="sm" className="h-7 w-[130px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TASK_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    <Badge
                      variant="secondary"
                      className={cn("text-[10px]", getTypeColor(t))}
                    >
                      {formatStatus(t)}
                    </Badge>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </MetadataField>

          {/* Effort */}
          <MetadataField label="Effort">
            <Select
              value={task.estimatedEffort ?? "__none__"}
              onValueChange={(value) =>
                handleFieldChange(
                  "estimatedEffort",
                  value === "__none__" ? null : value,
                )
              }
            >
              <SelectTrigger size="sm" className="h-7 w-[130px] text-xs">
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Not set</SelectItem>
                {EFFORTS.map((e) => (
                  <SelectItem key={e} value={e}>
                    {EFFORT_LABELS[e]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </MetadataField>

          <Separator className="my-2" />

          {/* Assignee (read-only display for now) */}
          <MetadataField label="Assignee">
            <span className="text-sm">
              {task.assigneeId ?? (
                <span className="italic text-muted-foreground/60">
                  Unassigned
                </span>
              )}
            </span>
          </MetadataField>

          {/* Epic */}
          <MetadataField label="Epic">
            <span className="text-sm">
              {task.epicId ? (
                <span className="font-mono text-xs">
                  {task.epicId.slice(0, 8)}...
                </span>
              ) : (
                <span className="italic text-muted-foreground/60">None</span>
              )}
            </span>
          </MetadataField>

          {/* Due date */}
          <MetadataField label="Due date">
            <span className="text-sm">
              {task.dueDate ? (
                new Date(task.dueDate).toLocaleDateString()
              ) : (
                <span className="italic text-muted-foreground/60">
                  Not set
                </span>
              )}
            </span>
          </MetadataField>

          {/* Timestamps */}
          {task.startedAt && (
            <MetadataField label="Started">
              <span className="text-xs text-muted-foreground">
                {formatRelativeTime(task.startedAt)}
              </span>
            </MetadataField>
          )}
          {task.completedAt && (
            <MetadataField label="Completed">
              <span className="text-xs text-muted-foreground">
                {formatRelativeTime(task.completedAt)}
              </span>
            </MetadataField>
          )}
        </div>
      </div>
    </div>
  );
}
