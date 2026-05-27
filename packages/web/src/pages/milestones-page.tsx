import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import {
  Calendar,
  Milestone as MilestoneIcon,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { Textarea } from "@/components/ui/textarea";
import { useProject } from "@/hooks/use-projects";
import {
  useMilestones,
  useCreateMilestone,
  useUpdateMilestone,
  useDeleteMilestone,
} from "@/hooks/use-milestones";
import { useEpics } from "@/hooks/use-epics";
import { useProjectStore } from "@/stores/project-store";
import { formatRelativeTime, getStatusColor } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Milestone } from "@/lib/api";

// ---- Create/Edit Milestone Dialog ----

function MilestoneDialog({
  milestone,
  projectId,
  open,
  onOpenChange,
}: {
  milestone?: Milestone;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isEdit = !!milestone;
  const createMilestone = useCreateMilestone();
  const updateMilestone = useUpdateMilestone();

  const [name, setName] = useState(milestone?.name ?? "");
  const [description, setDescription] = useState(
    milestone?.description ?? "",
  );
  const [targetDate, setTargetDate] = useState(
    milestone?.targetDate ? milestone.targetDate.split("T")[0] : "",
  );

  const isPending = createMilestone.isPending || updateMilestone.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    try {
      if (isEdit && milestone) {
        await updateMilestone.mutateAsync({
          id: milestone.id,
          data: {
            name: name.trim(),
            description: description.trim() || null,
            targetDate: targetDate || null,
          },
        });
      } else {
        await createMilestone.mutateAsync({
          projectId,
          data: {
            name: name.trim(),
            description: description.trim() || null,
            targetDate: targetDate || null,
          },
        });
      }
      onOpenChange(false);
      setName("");
      setDescription("");
      setTargetDate("");
    } catch {
      // Error handled by TanStack Query
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit Milestone" : "New Milestone"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update milestone details."
              : "Create a new milestone to group epics and track progress."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="milestone-name">
              Name
            </label>
            <Input
              id="milestone-name"
              placeholder="Milestone name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="milestone-description"
            >
              Description
            </label>
            <Textarea
              id="milestone-description"
              placeholder="Optional description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="milestone-target-date"
            >
              Target Date
            </label>
            <Input
              id="milestone-target-date"
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || isPending}>
              {isPending
                ? "Saving..."
                : isEdit
                  ? "Save Changes"
                  : "Create Milestone"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Delete Confirmation Dialog ----

function DeleteDialog({
  milestone,
  open,
  onOpenChange,
}: {
  milestone: Milestone;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteMilestone = useDeleteMilestone();

  async function handleDelete() {
    try {
      await deleteMilestone.mutateAsync(milestone.id);
      onOpenChange(false);
    } catch {
      // Error handled by TanStack Query
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Milestone</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete "{milestone.name}"? This action
            cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteMilestone.isPending}
          >
            {deleteMilestone.isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Expanded milestone row showing linked epics ----

function MilestoneEpics({
  milestoneId,
  projectId,
}: {
  milestoneId: string;
  projectId: string;
}) {
  const { data: epics, isLoading } = useEpics(projectId, {
    milestone: milestoneId,
  });

  if (isLoading) {
    return (
      <div className="px-4 py-3">
        <Skeleton className="h-4 w-48" />
      </div>
    );
  }

  if (!epics || epics.length === 0) {
    return (
      <div className="px-4 py-3 text-sm text-muted-foreground italic">
        No epics linked to this milestone.
      </div>
    );
  }

  return (
    <div className="px-4 py-3 space-y-2">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Linked Epics
      </p>
      <div className="space-y-1.5">
        {epics.map((epic) => {
          const { total, done } = epic.taskSummary;
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          return (
            <div
              key={epic.id}
              className="flex items-center justify-between rounded border bg-muted/30 px-3 py-2 text-sm"
            >
              <span className="font-medium">{epic.name}</span>
              <div className="flex items-center gap-3">
                <Badge
                  variant="secondary"
                  className={cn("text-[10px]", getStatusColor(epic.status))}
                >
                  {epic.status}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {pct}% ({done}/{total})
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Milestone table row ----

function MilestoneRow({
  milestone,
  projectId,
}: {
  milestone: Milestone;
  projectId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const updateMilestone = useUpdateMilestone();

  function handleToggleStatus() {
    const newStatus = milestone.status === "open" ? "closed" : "open";
    updateMilestone.mutate({
      id: milestone.id,
      data: { status: newStatus },
    });
  }

  return (
    <>
      <TableRow
        className="cursor-pointer"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <TableCell className="font-medium">
          <div className="flex items-center gap-2">
            <MilestoneIcon className="size-4 text-muted-foreground shrink-0" />
            {milestone.name}
          </div>
        </TableCell>
        <TableCell>
          {milestone.targetDate ? (
            <span className="flex items-center gap-1.5 text-sm">
              <Calendar className="size-3.5 text-muted-foreground" />
              {new Date(milestone.targetDate).toLocaleDateString()}
            </span>
          ) : (
            <span className="text-sm italic text-muted-foreground/50">
              Not set
            </span>
          )}
        </TableCell>
        <TableCell>
          <Badge
            variant="secondary"
            className={cn(
              "text-[11px]",
              milestone.status === "open"
                ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                : "bg-gray-100 text-gray-800 dark:bg-gray-900/40 dark:text-gray-300",
            )}
          >
            {milestone.status === "open" ? "Open" : "Closed"}
          </Badge>
        </TableCell>
        <TableCell className="text-sm text-muted-foreground max-w-[250px]">
          <span className="line-clamp-1">
            {milestone.description || (
              <span className="italic text-muted-foreground/50">
                No description
              </span>
            )}
          </span>
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {formatRelativeTime(milestone.createdAt)}
        </TableCell>
        <TableCell>
          <div
            className="flex items-center gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleToggleStatus}
              disabled={updateMilestone.isPending}
              title={
                milestone.status === "open"
                  ? "Close milestone"
                  : "Reopen milestone"
              }
            >
              {milestone.status === "open" ? (
                <span className="text-xs">Close</span>
              ) : (
                <span className="text-xs">Reopen</span>
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setEditOpen(true)}
              title="Edit milestone"
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setDeleteOpen(true)}
              title="Delete milestone"
            >
              <Trash2 className="size-3.5 text-destructive" />
            </Button>
          </div>
        </TableCell>
      </TableRow>

      {/* Expanded row: linked epics */}
      {expanded && (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/20 p-0">
            <MilestoneEpics
              milestoneId={milestone.id}
              projectId={projectId}
            />
          </TableCell>
        </TableRow>
      )}

      {/* Edit dialog */}
      <MilestoneDialog
        milestone={milestone}
        projectId={projectId}
        open={editOpen}
        onOpenChange={setEditOpen}
      />

      {/* Delete dialog */}
      <DeleteDialog
        milestone={milestone}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </>
  );
}

// ---- Skeleton Rows ----

function MilestoneTableSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, i) => (
        <TableRow key={i}>
          <TableCell>
            <Skeleton className="h-4 w-40" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-24" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-5 w-14" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-48" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-20" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-20" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

// ---- Main page ----

export function MilestonesPage() {
  const { projectId } = useParams({ strict: false });
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  // Fetch project details
  const { data: project } = useProject(projectId);
  if (project) {
    setCurrentProject(project.id, project.name);
  }

  const { data: milestones, isLoading, error } = useMilestones(projectId);

  const [createOpen, setCreateOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("");

  // Filter milestones
  const filteredMilestones = milestones?.filter((m) => {
    if (statusFilter && statusFilter !== "all") {
      return m.status === statusFilter;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <MilestoneIcon className="size-6 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">Milestones</h1>
          {project && (
            <Badge variant="outline" className="text-xs font-normal">
              {project.name}
            </Badge>
          )}
        </div>
        {projectId && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New Milestone
          </Button>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load milestones. Please try again.
        </div>
      )}

      {/* Filter bar */}
      <div className="flex items-center gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger size="sm" className="w-[130px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="closed">Closed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[200px]">Name</TableHead>
              <TableHead>Target Date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-[140px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <MilestoneTableSkeleton />}

            {!isLoading &&
              (!filteredMilestones || filteredMilestones.length === 0) && (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <MilestoneIcon className="size-8 text-muted-foreground/40" />
                      <p className="text-sm text-muted-foreground">
                        No milestones found. Create one to start tracking
                        progress.
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              )}

            {!isLoading &&
              filteredMilestones &&
              filteredMilestones.map((milestone) => (
                <MilestoneRow
                  key={milestone.id}
                  milestone={milestone}
                  projectId={projectId!}
                />
              ))}
          </TableBody>
        </Table>
      </div>

      {/* Create dialog */}
      {projectId && (
        <MilestoneDialog
          projectId={projectId}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      )}
    </div>
  );
}
