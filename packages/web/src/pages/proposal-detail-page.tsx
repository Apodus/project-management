import { useState, useRef, useEffect, useMemo } from "react";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  FileText,
  ListTodo,
  MessageSquare,
  Milestone,
  Pencil,
  Send,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  useProposal,
  useUpdateProposal,
  useTransitionProposal,
  useAddProposalComment,
  useProposalWorkItems,
} from "@/hooks/use-proposals";
import { useUsers } from "@/hooks/use-users";
import { useProject } from "@/hooks/use-projects";
import { useProjectStore } from "@/stores/project-store";
import { formatRelativeTime, formatStatus, getStatusColor } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Comment, ProposalEpic, ProposalTask } from "@/lib/api";

// ---- Comment component ----

function CommentItem({
  comment,
  userMap,
}: {
  comment: Comment;
  userMap: Map<string, { displayName: string; type: string }>;
}) {
  const author = userMap.get(comment.authorId);
  const isAI = author?.type === "ai_agent";

  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        isAI
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
            {author?.displayName ?? "Unknown User"}
          </span>
          {comment.commentType && comment.commentType !== "comment" && (
            <Badge variant="outline" className="text-[10px]">
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
    </div>
  );
}

// ---- Comment composer ----

function CommentComposer({
  proposalId,
  disabled,
}: {
  proposalId: string;
  disabled?: boolean;
}) {
  const [body, setBody] = useState("");
  const addComment = useAddProposalComment();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;

    try {
      await addComment.mutateAsync({ id: proposalId, body: body.trim() });
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
        disabled={disabled}
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
          disabled={!body.trim() || addComment.isPending || disabled}
        >
          <Send className="size-4" />
          {addComment.isPending ? "Sending..." : "Add Comment"}
        </Button>
      </div>
    </form>
  );
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

// ---- Work items section ----

function WorkItemsSection({
  proposalId,
}: {
  proposalId: string;
}) {
  const { data, isLoading } = useProposalWorkItems(proposalId);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <ListTodo className="size-4" />
          Spawned Work
        </h3>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (!data) return null;

  const { epics, tasks } = data;
  if (epics.length === 0 && tasks.length === 0) return null;

  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <ListTodo className="size-4" />
        Spawned Work
      </h3>

      {epics.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Epics
          </p>
          {epics.map((epic: ProposalEpic) => (
            <Card key={epic.id} className="gap-0 py-2">
              <CardContent className="flex items-center justify-between py-0">
                <div className="flex items-center gap-2">
                  <Milestone className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{epic.name}</span>
                </div>
                <Badge
                  variant="secondary"
                  className={cn(
                    "text-[10px]",
                    getStatusColor(epic.status),
                  )}
                >
                  {formatStatus(epic.status)}
                </Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {tasks.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Tasks
          </p>
          {tasks.map((task: ProposalTask) => (
            <Link
              key={task.id}
              to="/tasks/$taskId"
              params={{ taskId: task.id }}
              className="block"
            >
              <Card className="gap-0 py-2 transition-shadow hover:shadow-md">
                <CardContent className="flex items-center justify-between py-0">
                  <div className="flex items-center gap-2">
                    <FileText className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{task.title}</span>
                  </div>
                  <Badge
                    variant="secondary"
                    className={cn(
                      "text-[10px]",
                      getStatusColor(task.status),
                    )}
                  >
                    {formatStatus(task.status)}
                  </Badge>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Main page ----

export function ProposalDetailPage() {
  const { proposalId } = useParams({ strict: false });
  const { data: proposal, isLoading, error, refetch } = useProposal(proposalId);
  const { data: users } = useUsers();
  const updateProposal = useUpdateProposal();
  const transitionProposal = useTransitionProposal();
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);
  const { data: proposalProject } = useProject(proposal?.projectId ?? undefined);

  // This route is not nested under /projects/:id, so the global project context
  // can lag behind the proposal being viewed (e.g. after a refresh or a
  // cross-project jump). The SSE stream is project-scoped, so a stale context
  // makes the server filter out THIS proposal's live events and the view goes
  // stale. Align the context to the proposal's project so SSE re-subscribes.
  useEffect(() => {
    if (proposal?.projectId && proposal.projectId !== currentProjectId) {
      setCurrentProject(proposal.projectId, proposalProject?.name ?? null);
    }
  }, [
    proposal?.projectId,
    currentProjectId,
    proposalProject?.name,
    setCurrentProject,
  ]);

  const userMap = useMemo(() => {
    const map = new Map<string, { displayName: string; type: string }>();
    if (users) {
      for (const u of users) {
        map.set(u.id, { displayName: u.displayName, type: u.type });
      }
    }
    return map;
  }, [users]);

  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");

  // Back link config
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

  if (error || !proposal) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        {hasProject ? (
          <Link
            to="/projects/$projectId/proposals"
            params={{ projectId: currentProjectId! }}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Back to proposals
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
            {error ? "Failed to load proposal." : "Proposal not found."}
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

  const canTransition =
    proposal.status === "open" || proposal.status === "discussing";

  function handleTitleSave(newTitle: string) {
    if (!proposalId) return;
    updateProposal.mutate({ id: proposalId, data: { title: newTitle } });
  }

  function handleDescriptionSave() {
    if (!proposalId) return;
    updateProposal.mutate({
      id: proposalId,
      data: { description: descriptionDraft.trim() || null },
    });
    setEditingDescription(false);
  }

  function handleTransition(toStatus: string) {
    if (!proposalId) return;
    transitionProposal.mutate({ id: proposalId, toStatus });
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Back link */}
      {hasProject ? (
        <Link
          to="/projects/$projectId/proposals"
          params={{ projectId: currentProjectId! }}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to proposals
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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex-1 space-y-2">
          <EditableTitle value={proposal.title} onSave={handleTitleSave} />
          <div className="flex items-center gap-2 flex-wrap">
            <Badge
              variant="secondary"
              className={cn(getStatusColor(proposal.status))}
            >
              {formatStatus(proposal.status)}
            </Badge>
            {proposal.claimedBy && (
              <Badge variant="outline" className="font-normal">
                Claimed by{" "}
                {userMap.get(proposal.claimedBy)?.displayName ??
                  proposal.claimedBy}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              Created {formatRelativeTime(proposal.createdAt)}
            </span>
          </div>
        </div>

        {/* Action buttons */}
        {canTransition && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleTransition("accepted")}
              disabled={transitionProposal.isPending}
              className="text-green-600 hover:text-green-700 dark:text-green-400"
            >
              <Check className="size-4" />
              Accept
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleTransition("rejected")}
              disabled={transitionProposal.isPending}
              className="text-red-600 hover:text-red-700 dark:text-red-400"
            >
              <X className="size-4" />
              Reject
            </Button>
          </div>
        )}
      </div>

      <Separator />

      {/* Description section */}
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
                setDescriptionDraft(proposal.description ?? "");
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
              rows={6}
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
                disabled={updateProposal.isPending}
              >
                Save
              </Button>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border bg-muted/30 p-4">
            {proposal.description ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                {proposal.description}
              </p>
            ) : (
              <p className="text-sm italic text-muted-foreground/50">
                No description provided. Click Edit to add one.
              </p>
            )}
          </div>
        )}
      </section>

      <Separator />

      {/* Discussion thread */}
      <section className="space-y-4">
        <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <MessageSquare className="size-4" />
          Discussion
          {proposal.comments && (
            <Badge variant="secondary" className="text-[10px]">
              {proposal.comments.length}
            </Badge>
          )}
        </h2>

        {/* Comments list */}
        {proposal.comments && proposal.comments.length > 0 ? (
          <div className="space-y-3">
            {proposal.comments.map((comment) => (
              <CommentItem key={comment.id} comment={comment} userMap={userMap} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-8">
            <MessageSquare className="mb-2 size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No comments yet. Start the discussion below.
            </p>
          </div>
        )}

        {/* Comment composer */}
        <div className="pt-2">
          <CommentComposer
            proposalId={proposalId!}
            disabled={
              proposal.status === "rejected" ||
              proposal.status === "in_progress" ||
              proposal.status === "completed"
            }
          />
        </div>
      </section>

      {/* Work items (visible when in progress or completed) */}
      {(proposal.status === "in_progress" ||
        proposal.status === "completed") && (
        <>
          <Separator />
          <WorkItemsSection proposalId={proposalId!} />
        </>
      )}
    </div>
  );
}
