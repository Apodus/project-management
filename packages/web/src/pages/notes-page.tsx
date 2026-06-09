import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { Inbox, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useProject } from "@/hooks/use-projects";
import { useCurrentUser } from "@/hooks/use-auth";
import {
  useNotes,
  useDismissNote,
  usePromoteNoteToProposal,
  usePromoteNoteToTask,
} from "@/hooks/use-notes";
import { useTasks } from "@/hooks/use-tasks";
import { useEpics } from "@/hooks/use-epics";
import { useProposals } from "@/hooks/use-proposals";
import { useProjectStore } from "@/stores/project-store";
import {
  formatRelativeTime,
  formatStatus,
  getPriorityColor,
  getStatusColor,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Note, NoteFilters } from "@/lib/api";
import type { NotesSearch } from "@/router";

const NOTE_KINDS = [
  "bug",
  "question",
  "idea",
  "tech_debt",
  "wtf",
  "observation",
] as const;

const NOTE_STATUSES = ["open", "triaged"] as const;

const ANCHOR_TYPES = ["task", "epic", "proposal"] as const;

const SEVERITIES = ["low", "medium", "high"] as const;

// Local kind→tint map (shaped like getTypeColor in format.ts). Kept page-local
// per plan — do NOT edit format.ts for the notes vocabulary.
function getKindColor(kind: string): string {
  switch (kind) {
    case "bug":
      return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
    case "question":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
    case "idea":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300";
    case "tech_debt":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    case "wtf":
      return "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300";
    case "observation":
      return "bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-300";
    default:
      return "bg-gray-100 text-gray-800 dark:bg-gray-900/40 dark:text-gray-300";
  }
}

// Debounce a value (mirrors task-list-page's local helper).
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

// Resolve an anchor (or promoted target) to a clickable Link when the id is in
// the map, else render the raw type + short id.
//
// CRITICAL: the task list caps at 50, so a map MISS does NOT mean the entity was
// deleted — it may simply be older than the 50 most recent. We therefore render
// the raw type + short id on a miss (mirroring task-list-page's
// `epicMap.get(id) ?? id.slice(0,8)+"..."`), NEVER "(removed)". True dangling
// detection needs per-anchor server resolution — deferred.
function AnchorRef({
  type,
  id,
  title,
}: {
  type: "task" | "epic" | "proposal";
  id: string;
  title: string | undefined;
}) {
  const short = `${type} ${id.slice(0, 8)}…`;
  if (!title) {
    return <span className="font-mono text-[11px]">{short}</span>;
  }
  if (type === "task") {
    return (
      <Link
        to="/tasks/$taskId"
        params={{ taskId: id }}
        className="hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {title}
      </Link>
    );
  }
  if (type === "epic") {
    return (
      <Link
        to="/epics/$epicId"
        params={{ epicId: id }}
        className="hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {title}
      </Link>
    );
  }
  return (
    <Link
      to="/proposals/$proposalId"
      params={{ proposalId: id }}
      className="hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      {title}
    </Link>
  );
}

// ─── Triage action dialogs (Campaign C3) ─────────────────────────
//
// Each mirrors the ForceLandDialog pattern in train-audit-page.tsx: controlled
// open/onOpenChange, a reset() that also resets the mutation, canSubmit gating,
// and `await mutateAsync(...)` then close — relying on the hook's onError toast
// inside a swallowed catch.

function DismissNoteDialog({
  note,
  open,
  onOpenChange,
}: {
  note: Note;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [reason, setReason] = useState("");
  const dismissMutation = useDismissNote();

  function reset() {
    setReason("");
    dismissMutation.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  const canSubmit = reason.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit) return;
    try {
      await dismissMutation.mutateAsync({
        id: note.id,
        projectId: note.projectId,
        reason: reason.trim(),
      });
      handleOpenChange(false);
    } catch {
      // onError toast surfaces the backend message.
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dismiss note</DialogTitle>
          <DialogDescription>
            Mark this note as triaged without acting on it. A reason is required.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="dismiss-reason">Reason</Label>
          <Textarea
            id="dismiss-reason"
            placeholder="not reproducible; superseded; out of scope…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit || dismissMutation.isPending}
          >
            {dismissMutation.isPending ? "Dismissing…" : "Dismiss"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PromoteToProposalDialog({
  note,
  open,
  onOpenChange,
}: {
  note: Note;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [description, setDescription] = useState("");
  const promoteMutation = usePromoteNoteToProposal();

  function reset() {
    setTitle(note.title);
    setDescription("");
    promoteMutation.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  const canSubmit = title.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit) return;
    try {
      await promoteMutation.mutateAsync({
        id: note.id,
        projectId: note.projectId,
        title: title.trim(),
        description: description.trim() || undefined,
      });
      toast.success("Promoted to proposal");
      handleOpenChange(false);
    } catch {
      // onError toast surfaces the backend message.
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Promote to proposal</DialogTitle>
          <DialogDescription>
            Create a proposal from this note and mark the note as triaged.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="promote-proposal-title">Title</Label>
            <Input
              id="promote-proposal-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="promote-proposal-description">
              Description (optional)
            </Label>
            <Textarea
              id="promote-proposal-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit || promoteMutation.isPending}
          >
            {promoteMutation.isPending ? "Promoting…" : "Promote"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PromoteToTaskDialog({
  note,
  open,
  onOpenChange,
}: {
  note: Note;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [description, setDescription] = useState("");
  const [epicId, setEpicId] = useState("");
  const promoteMutation = usePromoteNoteToTask();

  function reset() {
    setTitle(note.title);
    setDescription("");
    setEpicId("");
    promoteMutation.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  const canSubmit = title.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit) return;
    try {
      await promoteMutation.mutateAsync({
        id: note.id,
        projectId: note.projectId,
        title: title.trim(),
        description: description.trim() || undefined,
        epicId: epicId.trim() || undefined,
      });
      toast.success("Promoted to task");
      handleOpenChange(false);
    } catch {
      // onError toast surfaces the backend message.
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Promote to task</DialogTitle>
          <DialogDescription>
            Create a task from this note and mark the note as triaged.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="promote-task-title">Title</Label>
            <Input
              id="promote-task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="promote-task-description">
              Description (optional)
            </Label>
            <Textarea
              id="promote-task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="promote-task-epic">Epic ID (optional)</Label>
            <Input
              id="promote-task-epic"
              placeholder="epic-…"
              value={epicId}
              onChange={(e) => setEpicId(e.target.value)}
              className="font-mono"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit || promoteMutation.isPending}
          >
            {promoteMutation.isPending ? "Promoting…" : "Promote"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NoteCard({
  note,
  anchorTitle,
  promotedTaskTitle,
  promotedProposalTitle,
  isHuman,
}: {
  note: Note;
  anchorTitle: string | undefined;
  promotedTaskTitle: string | undefined;
  promotedProposalTitle: string | undefined;
  isHuman: boolean;
}) {
  const isPromoted = note.status === "triaged" && note.triageOutcome === "promoted";
  const isDismissed = note.status === "triaged" && note.triageOutcome === "dismissed";
  const isOpen = note.status === "open";

  const [dismissOpen, setDismissOpen] = useState(false);
  const [promoteProposalOpen, setPromoteProposalOpen] = useState(false);
  const [promoteTaskOpen, setPromoteTaskOpen] = useState(false);

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="pb-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge
            variant="secondary"
            className={cn("text-[11px]", getKindColor(note.kind))}
          >
            {formatStatus(note.kind)}
          </Badge>
          {note.severity && (
            <Badge
              variant="secondary"
              className={cn("text-[11px]", getPriorityColor(note.severity))}
            >
              {formatStatus(note.severity)}
            </Badge>
          )}
          {note.status === "open" && (
            <Badge
              variant="secondary"
              className={cn("text-[11px]", getStatusColor("open"))}
            >
              Open
            </Badge>
          )}
          {isPromoted && (
            <Badge
              variant="secondary"
              className="text-[11px] bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
            >
              Triaged · Promoted
            </Badge>
          )}
          {isDismissed && (
            <Badge variant="secondary" className="text-[11px] text-muted-foreground">
              Triaged · Dismissed
            </Badge>
          )}
        </div>
        <CardTitle className="line-clamp-1 text-base">{note.title}</CardTitle>
      </CardHeader>
      <CardContent>
        {note.body ? (
          <p className="line-clamp-2 text-sm italic text-muted-foreground">
            {note.body}
          </p>
        ) : (
          <p className="text-sm italic text-muted-foreground/50">No body</p>
        )}

        {note.anchorType && note.anchorId && (
          <div className="mt-3 text-xs text-muted-foreground">
            <span className="text-muted-foreground/70">Anchored to </span>
            <AnchorRef
              type={note.anchorType}
              id={note.anchorId}
              title={anchorTitle}
            />
          </div>
        )}

        {isPromoted && note.promotedTaskId && (
          <div className="mt-1 text-xs text-muted-foreground">
            <span className="text-muted-foreground/70">Promoted to </span>
            <AnchorRef
              type="task"
              id={note.promotedTaskId}
              title={promotedTaskTitle}
            />
          </div>
        )}
        {isPromoted && note.promotedProposalId && (
          <div className="mt-1 text-xs text-muted-foreground">
            <span className="text-muted-foreground/70">Promoted to </span>
            <AnchorRef
              type="proposal"
              id={note.promotedProposalId}
              title={promotedProposalTitle}
            />
          </div>
        )}

        <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground/70">
          <span>{formatRelativeTime(note.createdAt)}</span>
        </div>

        {/* Triage actions — open notes only (triaged notes are terminal). */}
        {isOpen && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDismissOpen(true)}
            >
              Dismiss
            </Button>
            <Button size="sm" onClick={() => setPromoteProposalOpen(true)}>
              Promote to proposal
            </Button>
            {isHuman && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setPromoteTaskOpen(true)}
              >
                Promote to task
              </Button>
            )}

            <DismissNoteDialog
              note={note}
              open={dismissOpen}
              onOpenChange={setDismissOpen}
            />
            <PromoteToProposalDialog
              note={note}
              open={promoteProposalOpen}
              onOpenChange={setPromoteProposalOpen}
            />
            {isHuman && (
              <PromoteToTaskDialog
                note={note}
                open={promoteTaskOpen}
                onOpenChange={setPromoteTaskOpen}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NoteSkeleton() {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="pb-0">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="mt-2 h-5 w-3/4" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-2/3" />
        <Skeleton className="mt-3 h-3 w-1/4" />
      </CardContent>
    </Card>
  );
}

export function NotesPage() {
  const { projectId } = useParams({ strict: false });
  const search = useSearch({ strict: false }) as NotesSearch;
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  // Human gate for the human-only promote-to-task action. Use `type` (the
  // human/ai_agent discriminator — cf. dashboard-page.tsx:462), NOT `role`
  // (admin axis). The server enforces human-only on promote-to-task (403);
  // this is ergonomics / defense-in-depth. Fetched ONCE here, threaded down.
  const { data: currentUser } = useCurrentUser();
  const isHuman = currentUser?.type === "human";

  // Fetch project details so we can set the project name in the store. Done in
  // an effect — calling a store setter during render flags a React 19 error.
  const { data: project } = useProject(projectId);
  useEffect(() => {
    if (project) {
      setCurrentProject(project.id, project.name);
    }
  }, [project, setCurrentProject]);

  // Filter state: "" / "all" sentinel → omitted from NoteFilters. Anchor /
  // status seeded ONCE from deep-link search params (the badge Link is a fresh
  // navigation that mounts this page fresh, so useState initializers are correct).
  const [kindFilter, setKindFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>(search.status ?? "");
  const [anchorTypeFilter, setAnchorTypeFilter] = useState<string>(
    search.anchorType ?? "",
  );
  const [anchorId, setAnchorId] = useState<string>(search.anchorId ?? "");
  const [severityFilter, setSeverityFilter] = useState<string>("");
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebounce(searchInput, 300);

  const filters: NoteFilters = useMemo(() => {
    const f: NoteFilters = {};
    if (kindFilter && kindFilter !== "all") f.kind = kindFilter as Note["kind"];
    if (statusFilter && statusFilter !== "all")
      f.status = statusFilter as Note["status"];
    if (anchorTypeFilter && anchorTypeFilter !== "all")
      f.anchorType = anchorTypeFilter as Note["anchorType"];
    if (anchorId) f.anchorId = anchorId;
    if (severityFilter && severityFilter !== "all")
      f.severity = severityFilter as Note["severity"];
    return f;
  }, [kindFilter, statusFilter, anchorTypeFilter, anchorId, severityFilter]);

  // note.service.list has NO server limit (returns all project notes), so the
  // client-side search below is complete. NOTE the double `.data` — useNotes
  // returns NoteListResult `{ data: Note[], pagination }`.
  const notesQuery = useNotes(projectId, filters);
  const notes = notesQuery.data?.data ?? [];
  const { isLoading, error, refetch } = notesQuery;

  // Anchor + promoted-target resolution. Build id→title/name maps (mirror
  // task-list-page's epicMap). These lists cap server-side, so a MISS is not a
  // deletion — AnchorRef renders the raw type+short-id on a miss (not "removed").
  const { data: tasks } = useTasks(projectId);
  const { data: epics } = useEpics(projectId);
  const { data: proposals } = useProposals(projectId);

  const taskMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tasks?.data ?? []) map.set(t.id, t.title);
    return map;
  }, [tasks]);

  const epicMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of epics ?? []) map.set(e.id, e.name);
    return map;
  }, [epics]);

  const proposalMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of proposals ?? []) map.set(p.id, p.title);
    return map;
  }, [proposals]);

  function anchorTitleFor(note: Note): string | undefined {
    if (!note.anchorType || !note.anchorId) return undefined;
    if (note.anchorType === "task") return taskMap.get(note.anchorId);
    if (note.anchorType === "epic") return epicMap.get(note.anchorId);
    return proposalMap.get(note.anchorId);
  }

  // Client-side free-text search over title + body (debounced), mirroring
  // command-palette's `.toLowerCase().includes` idiom. No /search wrapper exists
  // for notes (FTS deferred).
  const visibleNotes = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        (n.body && n.body.toLowerCase().includes(q)),
    );
  }, [notes, debouncedSearch]);

  const hasActiveFilters = !!(
    (kindFilter && kindFilter !== "all") ||
    (statusFilter && statusFilter !== "all") ||
    (anchorTypeFilter && anchorTypeFilter !== "all") ||
    anchorId ||
    (severityFilter && severityFilter !== "all") ||
    searchInput
  );

  function clearFilters() {
    setKindFilter("");
    setStatusFilter("");
    setAnchorTypeFilter("");
    setAnchorId("");
    setSeverityFilter("");
    setSearchInput("");
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <Inbox className="size-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">Inbox</h1>
        {project && (
          <Badge variant="outline" className="text-xs font-normal">
            {project.name}
          </Badge>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search notes..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9 h-9"
          />
        </div>

        <Select value={kindFilter} onValueChange={setKindFilter}>
          <SelectTrigger size="sm" className="w-[130px]">
            <SelectValue placeholder="Kind" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All kinds</SelectItem>
            {NOTE_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {formatStatus(k)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger size="sm" className="w-[130px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {NOTE_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {formatStatus(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={anchorTypeFilter} onValueChange={setAnchorTypeFilter}>
          <SelectTrigger size="sm" className="w-[130px]">
            <SelectValue placeholder="Anchor" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All anchors</SelectItem>
            {ANCHOR_TYPES.map((a) => (
              <SelectItem key={a} value={a}>
                {formatStatus(a)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={severityFilter} onValueChange={setSeverityFilter}>
          <SelectTrigger size="sm" className="w-[130px]">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            {SEVERITIES.map((s) => (
              <SelectItem key={s} value={s}>
                {formatStatus(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="size-4" />
            Clear filters
          </Button>
        )}
      </div>

      {/* Error state */}
      {error && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <p className="text-sm text-destructive">
              Failed to load notes. Please try again.
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <NoteSkeleton key={i} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && visibleNotes.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
          <Inbox className="mb-3 size-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            {hasActiveFilters ? "No notes match your filters" : "No notes yet"}
          </p>
          {hasActiveFilters && (
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              onClick={clearFilters}
            >
              Clear filters
            </Button>
          )}
        </div>
      )}

      {/* Note grid */}
      {!isLoading && !error && visibleNotes.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleNotes.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              anchorTitle={anchorTitleFor(note)}
              promotedTaskTitle={
                note.promotedTaskId
                  ? taskMap.get(note.promotedTaskId)
                  : undefined
              }
              promotedProposalTitle={
                note.promotedProposalId
                  ? proposalMap.get(note.promotedProposalId)
                  : undefined
              }
              isHuman={isHuman}
            />
          ))}
        </div>
      )}
    </div>
  );
}
