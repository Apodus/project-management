import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { Inbox, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  useReopenNote,
  usePromoteNoteToProposal,
  usePromoteNoteToTask,
} from "@/hooks/use-notes";
import { useTriageDecisions } from "@/hooks/use-triage-decisions";
import { useEpics } from "@/hooks/use-epics";
import { useFtsSearch } from "@/hooks/use-fts-search";
import { useProjectStore } from "@/stores/project-store";
import { formatRelativeTime, formatStatus, getPriorityColor, getStatusColor } from "@/lib/format";
import { cn } from "@/lib/utils";
import { deriveNotePromotion } from "@/lib/note-promotion";
import type { Note, NoteFilters } from "@/lib/api";
import type { NotesSearch } from "@/router";

const NOTE_KINDS = ["bug", "question", "idea", "tech_debt", "wtf", "observation"] as const;

const NOTE_STATUSES = ["open", "needs_human", "triaged"] as const;

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

// Amber tint for the needs_human status badge (an agent triaged but punted to a
// human). Page-local, shaped like getKindColor's tints.
const NEEDS_HUMAN_BADGE = "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";

// Fast-track badge (T3) — rendered when a note was promoted into a fast_track
// proposal (note.promotedTarget.proposalKind === "fast_track"). Mirrors the
// green "Promoted" badge tint, with its own copy.
function FastTrackBadge() {
  return (
    <Badge
      variant="secondary"
      className="bg-violet-100 text-[11px] text-violet-800 dark:bg-violet-900/40 dark:text-violet-300"
    >
      Fast-track
    </Badge>
  );
}

/** True when the note was promoted into a fast_track proposal (drives the badge). */
function isFastTrackPromoted(note: Note): boolean {
  return note.status === "triaged" && note.promotedTarget?.proposalKind === "fast_track";
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

// Render an anchor (or promoted target) truthfully from the server-enriched
// ref (Campaign C4: note.anchor / note.promotedTarget = {exists, title}):
//   exists:true  → titled Link (same routes as before)
//   exists:false → muted NON-link "<type> <shortid>… (removed)" — POSITIVE
//                  server evidence the target was deleted
//   ref absent   → the raw type+short-id fallback (no link, no "(removed)")
// "(removed)" renders ONLY on positive evidence — an old/non-enriched server
// payload degrades to the pre-C4 fallback. This single rule is the
// additive-rollout guarantee.
function AnchorRef({
  type,
  id,
  anchorRef,
}: {
  type: "task" | "epic" | "proposal";
  id: string;
  anchorRef: Note["anchor"];
}) {
  const short = `${type} ${id.slice(0, 8)}…`;
  if (anchorRef && !anchorRef.exists) {
    return (
      <span className="text-muted-foreground/60 font-mono text-[11px]">{short} (removed)</span>
    );
  }
  const title = anchorRef?.title;
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

// ─── Triage audit feed (T3) ──────────────────────────────────────
//
// Per-note auto-decision history from the append-only triage side-log
// (GET /projects/:id/triage-decisions?noteId=). Rendered INSIDE the detail
// dialog and gated on `open` so the query only fires when a note is actually
// being inspected (never N requests across the card grid). The dialog's
// terminal triage metadata (triagedBy/outcome/reason) renders as a header; each
// side-log row is a discrete agent decision (mode/decision/rationale/confidence).
function TriageAuditFeed({
  projectId,
  noteId,
  note,
  open,
}: {
  projectId: string;
  noteId: string;
  note: Note;
  open: boolean;
}) {
  const { data, isLoading } = useTriageDecisions(
    projectId,
    { noteId },
    { enabled: open && !!noteId },
  );
  const decisions = data?.data ?? [];
  const hasTriageMeta = !!(note.triagedBy || note.triageOutcome || note.triageReason);

  // Nothing to show: no terminal triage AND no side-log rows (once loaded).
  if (!hasTriageMeta && !isLoading && decisions.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 border-t pt-3">
      <h3 className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
        Triage history
      </h3>

      {hasTriageMeta && (
        <div className="text-muted-foreground space-y-0.5 text-xs">
          {note.triageOutcome && (
            <div>
              <span className="text-muted-foreground/70">Outcome </span>
              <span>{formatStatus(note.triageOutcome)}</span>
            </div>
          )}
          {note.triagedBy && (
            <div>
              <span className="text-muted-foreground/70">Triaged by </span>
              <span className="font-mono">{note.triagedBy}</span>
            </div>
          )}
          {note.triageReason && (
            <div>
              <span className="text-muted-foreground/70">Reason </span>
              <span>{note.triageReason}</span>
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : decisions.length === 0 ? (
        <p className="text-muted-foreground/50 text-xs italic">No auto-triage decisions recorded</p>
      ) : (
        <ul className="space-y-2">
          {decisions.map((d) => (
            <li key={d.id} className="rounded-md border px-2.5 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="text-[11px]">
                  {formatStatus(d.mode)}
                </Badge>
                <Badge variant="outline" className="text-[11px]">
                  {formatStatus(d.decision)}
                </Badge>
                {d.confidence != null && (
                  <span className="text-muted-foreground/70">
                    confidence {Math.round(d.confidence * 100)}%
                  </span>
                )}
                <span className="text-muted-foreground/60 ml-auto">
                  {formatRelativeTime(d.createdAt)}
                </span>
              </div>
              {d.rationale && (
                <p className="text-muted-foreground mt-1 whitespace-pre-wrap">{d.rationale}</p>
              )}
              {(d.resultingProposalId || d.resultingTaskId) && (
                <div className="text-muted-foreground mt-1">
                  <span className="text-muted-foreground/70">Result </span>
                  {d.resultingProposalId ? (
                    <AnchorRef type="proposal" id={d.resultingProposalId} anchorRef={undefined} />
                  ) : (
                    <AnchorRef type="task" id={d.resultingTaskId!} anchorRef={undefined} />
                  )}
                </div>
              )}
              <div className="text-muted-foreground/60 mt-1 font-mono">{d.actorId}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
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
          <Button onClick={handleSubmit} disabled={!canSubmit || dismissMutation.isPending}>
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
  const derived = deriveNotePromotion(note);
  const [title, setTitle] = useState(derived.title);
  const [description, setDescription] = useState(derived.description ?? "");
  const promoteMutation = usePromoteNoteToProposal();

  function reset() {
    setTitle(derived.title);
    setDescription(derived.description ?? "");
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
            <Label htmlFor="promote-proposal-description">Description (optional)</Label>
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
          <Button onClick={handleSubmit} disabled={!canSubmit || promoteMutation.isPending}>
            {promoteMutation.isPending ? "Promoting…" : "Promote"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Sentinel for "no epic" — Radix Select items cannot carry an empty value.
const NO_EPIC = "__none__";

// Terminal epic statuses — a closed epic is not offered as a promote target.
const TERMINAL_EPIC_STATUSES = new Set(["completed", "cancelled"]);

function PromoteToTaskDialog({
  note,
  open,
  onOpenChange,
}: {
  note: Note;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const derived = deriveNotePromotion(note);
  const [title, setTitle] = useState(derived.title);
  const [description, setDescription] = useState(derived.description ?? "");
  const [epicId, setEpicId] = useState(NO_EPIC);
  const promoteMutation = usePromoteNoteToTask();

  // Fetched INSIDE the dialog so only an opened promote dialog pays for the
  // epics query. Deviation from the spec's "combobox": the house pattern is a
  // Radix Select (no combobox primitive exists in this codebase) — deliberate.
  const { data: epics } = useEpics(note.projectId);
  const epicChoices = (epics ?? []).filter((e) => !TERMINAL_EPIC_STATUSES.has(e.status));

  function reset() {
    setTitle(derived.title);
    setDescription(derived.description ?? "");
    setEpicId(NO_EPIC);
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
        epicId: epicId === NO_EPIC ? undefined : epicId,
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
            <Label htmlFor="promote-task-description">Description (optional)</Label>
            <Textarea
              id="promote-task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="promote-task-epic">Epic (optional)</Label>
            <Select value={epicId} onValueChange={setEpicId}>
              <SelectTrigger id="promote-task-epic" className="w-full">
                <SelectValue placeholder="No epic" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_EPIC}>No epic</SelectItem>
                {epicChoices.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || promoteMutation.isPending}>
            {promoteMutation.isPending ? "Promoting…" : "Promote"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Full-text note detail dialog (P2). The card clamps title/body for the grid
// preview; this reveals the ENTIRE note — full title + unclamped body + the
// metadata the card never shows (codeLocator, author, full timestamps) + the
// triage actions for open notes. Controlled. The promote/dismiss actions are
// NOT re-implemented here: the footer closes this dialog then hands off to the
// card's existing dialog instances (one Radix modal open at a time — no nested
// focus-trap). There is no markdown renderer in the web; whitespace-pre-wrap is
// the house idiom for long bodies.
function NoteDetailDialog({
  note,
  open,
  onOpenChange,
  isHuman,
  onDismiss,
  onPromoteProposal,
  onPromoteTask,
  onReopen,
}: {
  note: Note;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isHuman: boolean;
  onDismiss: () => void;
  onPromoteProposal: () => void;
  onPromoteTask: () => void;
  onReopen: () => void;
}) {
  const isNeedsHuman = note.status === "needs_human";
  // MUTABLE = open|needs_human (server assertMutable accepts both → dismiss/
  // promote won't 409). REOPENABLE = needs_human|triaged (human-only undo).
  const isMutable = note.status === "open" || isNeedsHuman;
  const isReopenable = isNeedsHuman || note.status === "triaged";
  const isPromoted = note.status === "triaged" && note.triageOutcome === "promoted";

  // Close this dialog FIRST, then open the handed-off triage dialog — so only
  // one Radix modal is ever mounted (no nested focus-trap hazard).
  function handAction(open: () => void) {
    onOpenChange(false);
    open();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className={cn("text-[11px]", getKindColor(note.kind))}>
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
              <Badge variant="secondary" className={cn("text-[11px]", getStatusColor("open"))}>
                Open
              </Badge>
            )}
            {isNeedsHuman && (
              <Badge variant="secondary" className={cn("text-[11px]", NEEDS_HUMAN_BADGE)}>
                {formatStatus("needs_human")}
              </Badge>
            )}
            {isPromoted && (
              <Badge
                variant="secondary"
                className="bg-green-100 text-[11px] text-green-800 dark:bg-green-900/40 dark:text-green-300"
              >
                Triaged · Promoted
              </Badge>
            )}
            {isFastTrackPromoted(note) && <FastTrackBadge />}
            {note.status === "triaged" && note.triageOutcome === "dismissed" && (
              <Badge variant="secondary" className="text-muted-foreground text-[11px]">
                Triaged · Dismissed
              </Badge>
            )}
          </div>
          <DialogTitle>{note.title}</DialogTitle>
          <DialogDescription className="sr-only">Full note details</DialogDescription>
        </DialogHeader>

        {note.body ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{note.body}</p>
        ) : (
          <p className="text-muted-foreground/50 text-sm italic">No body</p>
        )}

        <div className="text-muted-foreground space-y-1.5 border-t pt-3 text-xs">
          {note.anchorType && note.anchorId && (
            <div>
              <span className="text-muted-foreground/70">Anchored to </span>
              <AnchorRef type={note.anchorType} id={note.anchorId} anchorRef={note.anchor} />
            </div>
          )}
          {note.codeLocator && (
            <div>
              <span className="text-muted-foreground/70">Code </span>
              <span className="font-mono text-xs">
                {note.codeLocator.path}
                {note.codeLocator.line != null && `:${note.codeLocator.line}`}
              </span>
            </div>
          )}
          {isPromoted && note.promotedTaskId && (
            <div>
              <span className="text-muted-foreground/70">Promoted to </span>
              <AnchorRef type="task" id={note.promotedTaskId} anchorRef={note.promotedTarget} />
            </div>
          )}
          {isPromoted && note.promotedProposalId && (
            <div>
              <span className="text-muted-foreground/70">Promoted to </span>
              <AnchorRef
                type="proposal"
                id={note.promotedProposalId}
                anchorRef={note.promotedTarget}
              />
            </div>
          )}
          <div>
            <span className="text-muted-foreground/70">Author </span>
            <span className="font-mono text-xs">{note.authorId}</span>
          </div>
          <div className="flex flex-wrap gap-x-3">
            <span>Created {formatRelativeTime(note.createdAt)}</span>
            {note.updatedAt !== note.createdAt && (
              <span>Updated {formatRelativeTime(note.updatedAt)}</span>
            )}
            {note.triagedAt && <span>Triaged {formatRelativeTime(note.triagedAt)}</span>}
          </div>
        </div>

        {/* Per-note auto-decision audit feed (T3) — gated on `open` so the
            side-log query only fires for an actually-inspected note. */}
        <TriageAuditFeed projectId={note.projectId} noteId={note.id} note={note} open={open} />

        {/* Triage actions — mutable notes (open|needs_human). Each closes the
            detail then hands off to the card's own dialog. Reopen (human-only
            undo) shows for needs_human|triaged notes. */}
        {(isMutable || (isReopenable && isHuman)) && (
          <DialogFooter>
            {isMutable && (
              <>
                <Button variant="outline" size="sm" onClick={() => handAction(onDismiss)}>
                  Dismiss
                </Button>
                <Button size="sm" onClick={() => handAction(onPromoteProposal)}>
                  Promote to proposal
                </Button>
                {isHuman && (
                  <Button size="sm" variant="secondary" onClick={() => handAction(onPromoteTask)}>
                    Promote to task
                  </Button>
                )}
              </>
            )}
            {isReopenable && isHuman && (
              <Button variant="outline" size="sm" onClick={() => handAction(onReopen)}>
                Reopen
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NoteCard({ note, isHuman }: { note: Note; isHuman: boolean }) {
  const isPromoted = note.status === "triaged" && note.triageOutcome === "promoted";
  const isDismissed = note.status === "triaged" && note.triageOutcome === "dismissed";
  const isNeedsHuman = note.status === "needs_human";
  // MUTABLE = open|needs_human (dismiss/promote, server-accepted). REOPENABLE =
  // needs_human|triaged (human-only undo).
  const isMutable = note.status === "open" || isNeedsHuman;
  const isReopenable = isNeedsHuman || note.status === "triaged";

  const [detailOpen, setDetailOpen] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [promoteProposalOpen, setPromoteProposalOpen] = useState(false);
  const [promoteTaskOpen, setPromoteTaskOpen] = useState(false);

  const reopenMutation = useReopenNote();
  function handleReopen() {
    reopenMutation.mutateAsync({ id: note.id, projectId: note.projectId }).catch(() => {
      // onError toast surfaces the backend message (403 for non-humans).
    });
  }

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="pb-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" className={cn("text-[11px]", getKindColor(note.kind))}>
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
            <Badge variant="secondary" className={cn("text-[11px]", getStatusColor("open"))}>
              Open
            </Badge>
          )}
          {isNeedsHuman && (
            <Badge variant="secondary" className={cn("text-[11px]", NEEDS_HUMAN_BADGE)}>
              {formatStatus("needs_human")}
            </Badge>
          )}
          {isPromoted && (
            <Badge
              variant="secondary"
              className="bg-green-100 text-[11px] text-green-800 dark:bg-green-900/40 dark:text-green-300"
            >
              Triaged · Promoted
            </Badge>
          )}
          {isFastTrackPromoted(note) && <FastTrackBadge />}
          {isDismissed && (
            <Badge variant="secondary" className="text-muted-foreground text-[11px]">
              Triaged · Dismissed
            </Badge>
          )}
        </div>
        <CardTitle className="text-base">
          <button
            type="button"
            onClick={() => setDetailOpen(true)}
            className="line-clamp-1 text-left hover:underline"
          >
            {note.title}
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {note.body ? (
          <p className="text-muted-foreground line-clamp-2 text-sm italic">{note.body}</p>
        ) : (
          <p className="text-muted-foreground/50 text-sm italic">No body</p>
        )}

        {note.anchorType && note.anchorId && (
          <div className="text-muted-foreground mt-3 text-xs">
            <span className="text-muted-foreground/70">Anchored to </span>
            <AnchorRef type={note.anchorType} id={note.anchorId} anchorRef={note.anchor} />
          </div>
        )}

        {isPromoted && note.promotedTaskId && (
          <div className="text-muted-foreground mt-1 text-xs">
            <span className="text-muted-foreground/70">Promoted to </span>
            <AnchorRef type="task" id={note.promotedTaskId} anchorRef={note.promotedTarget} />
          </div>
        )}
        {isPromoted && note.promotedProposalId && (
          <div className="text-muted-foreground mt-1 text-xs">
            <span className="text-muted-foreground/70">Promoted to </span>
            <AnchorRef
              type="proposal"
              id={note.promotedProposalId}
              anchorRef={note.promotedTarget}
            />
          </div>
        )}

        <div className="text-muted-foreground/70 mt-3 flex items-center gap-3 text-xs">
          <span>{formatRelativeTime(note.createdAt)}</span>
        </div>

        {/* Full-text detail — rendered OUTSIDE the isOpen gate so triaged notes
            stay inspectable. Footer actions hand off to the card's own dialogs
            (below), so only one Radix modal is open at a time. */}
        <NoteDetailDialog
          note={note}
          open={detailOpen}
          onOpenChange={setDetailOpen}
          isHuman={isHuman}
          onDismiss={() => setDismissOpen(true)}
          onPromoteProposal={() => setPromoteProposalOpen(true)}
          onPromoteTask={() => setPromoteTaskOpen(true)}
          onReopen={handleReopen}
        />

        {/* Triage actions — mutable notes (open|needs_human) get dismiss/promote;
            reopenable notes (needs_human|triaged) get a human-only Reopen. */}
        {(isMutable || (isReopenable && isHuman)) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
            {isMutable && (
              <>
                <Button variant="outline" size="sm" onClick={() => setDismissOpen(true)}>
                  Dismiss
                </Button>
                <Button size="sm" onClick={() => setPromoteProposalOpen(true)}>
                  Promote to proposal
                </Button>
                {isHuman && (
                  <Button size="sm" variant="secondary" onClick={() => setPromoteTaskOpen(true)}>
                    Promote to task
                  </Button>
                )}
              </>
            )}
            {isReopenable && isHuman && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleReopen}
                disabled={reopenMutation.isPending}
              >
                {reopenMutation.isPending ? "Reopening…" : "Reopen"}
              </Button>
            )}

            <DismissNoteDialog note={note} open={dismissOpen} onOpenChange={setDismissOpen} />
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
  const [anchorTypeFilter, setAnchorTypeFilter] = useState<string>(search.anchorType ?? "");
  const [anchorId, setAnchorId] = useState<string>(search.anchorId ?? "");
  const [severityFilter, setSeverityFilter] = useState<string>("");
  const [searchInput, setSearchInput] = useState(search.q ?? "");
  const debouncedSearch = useDebounce(searchInput, 300);

  const filters: NoteFilters = useMemo(() => {
    const f: NoteFilters = {};
    if (kindFilter && kindFilter !== "all") f.kind = kindFilter as Note["kind"];
    if (statusFilter && statusFilter !== "all") f.status = statusFilter as Note["status"];
    if (anchorTypeFilter && anchorTypeFilter !== "all")
      f.anchorType = anchorTypeFilter as Note["anchorType"];
    if (anchorId) f.anchorId = anchorId;
    if (severityFilter && severityFilter !== "all") f.severity = severityFilter as Note["severity"];
    return f;
  }, [kindFilter, statusFilter, anchorTypeFilter, anchorId, severityFilter]);

  // note.service.list has NO server limit (returns all project notes), so the
  // client-side search below is complete. NOTE the double `.data` — useNotes
  // returns NoteListResult `{ data: Note[], pagination }`.
  // Anchor + promoted-target titles arrive ENRICHED on each note (C4:
  // note.anchor / note.promotedTarget) — no client entity maps.
  const notesQuery = useNotes(projectId, filters);
  const notes = notesQuery.data?.data ?? [];
  const { isLoading, error, refetch } = notesQuery;

  // Hybrid search (C4): the AND model. Structured filters narrow via the list
  // endpoint (the `notes` rows above); free text narrows via server FTS5
  // (GET /search, entity_type=note, project-scoped). The visible set is the
  // ID-SET INTERSECTION of both, ordered by FTS rank (hit order, best first) —
  // a note matching the text but excluded by a structured filter stays hidden,
  // and vice versa. The wrapper passes limit=100 explicitly, so free-text
  // results cap at the 100 best-ranked hits.
  const hasFreeText = debouncedSearch.trim().length > 0;
  const ftsQuery = useFtsSearch(debouncedSearch, {
    projectId,
    entityType: "note",
  });
  const visibleNotes = useMemo(() => {
    if (!hasFreeText) return notes;
    const hits = ftsQuery.data ?? [];
    const byId = new Map(notes.map((n) => [n.id, n]));
    return hits.map((h) => byId.get(h.entityId)).filter((n): n is Note => n !== undefined);
  }, [notes, hasFreeText, ftsQuery.data]);

  // Avoid a false "no notes match" flash while the FIRST fts fetch for a
  // query is in flight (subsequent keystrokes keep previous hits rendered
  // via placeholderData).
  const searchPending = hasFreeText && ftsQuery.isLoading;

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
        <Inbox className="text-muted-foreground size-6" />
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
          <Search className="text-muted-foreground absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
          <Input
            placeholder="Search notes..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-9 pl-9"
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
            <p className="text-destructive text-sm">Failed to load notes. Please try again.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Loading state */}
      {(isLoading || searchPending) && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <NoteSkeleton key={i} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !searchPending && !error && visibleNotes.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
          <Inbox className="text-muted-foreground/40 mb-3 size-10" />
          <p className="text-muted-foreground text-sm">
            {hasActiveFilters ? "No notes match your filters" : "No notes yet"}
          </p>
          {hasActiveFilters && (
            <Button className="mt-3" size="sm" variant="outline" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>
      )}

      {/* Note grid */}
      {!isLoading && !searchPending && !error && visibleNotes.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleNotes.map((note) => (
            <NoteCard key={note.id} note={note} isHuman={isHuman} />
          ))}
        </div>
      )}
    </div>
  );
}
