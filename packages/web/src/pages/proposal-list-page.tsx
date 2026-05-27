import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { FileText, MessageSquare, Plus } from "lucide-react";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/use-auth";
import { useProject } from "@/hooks/use-projects";
import { useProposals, useCreateProposal } from "@/hooks/use-proposals";
import { useProjectStore } from "@/stores/project-store";
import { formatRelativeTime, formatStatus, getStatusColor } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Proposal } from "@/lib/api";

const PROPOSAL_STATUSES = [
  "open",
  "discussing",
  "accepted",
  "implemented",
  "rejected",
] as const;

function ProposalCard({
  proposal,
  onClick,
}: {
  proposal: Proposal;
  onClick: () => void;
}) {
  return (
    <Card
      className="cursor-pointer gap-3 py-4 transition-shadow hover:shadow-md"
      onClick={onClick}
    >
      <CardHeader className="pb-0">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="line-clamp-1 text-base">
            {proposal.title}
          </CardTitle>
          <Badge
            variant="secondary"
            className={cn(
              "shrink-0 text-[11px]",
              getStatusColor(proposal.status),
            )}
          >
            {formatStatus(proposal.status)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {proposal.description ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {proposal.description}
          </p>
        ) : (
          <p className="text-sm italic text-muted-foreground/50">
            No description
          </p>
        )}
        <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground/70">
          <span>{formatRelativeTime(proposal.createdAt)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function ProposalSkeleton() {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="pb-0">
        <Skeleton className="h-5 w-3/4" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-2/3" />
        <Skeleton className="mt-3 h-3 w-1/4" />
      </CardContent>
    </Card>
  );
}

export function ProposalListPage() {
  const { projectId } = useParams({ strict: false });
  const navigate = useNavigate();
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  // Fetch project details so we can set the project name in the store
  const { data: project } = useProject(projectId);
  if (project) {
    setCurrentProject(project.id, project.name);
  }

  const { data: currentUser } = useCurrentUser();

  // Fetch all proposals (no status filter) so we can calculate counts per tab
  const { data: allProposals, isLoading, error, refetch } = useProposals(projectId);
  const createProposal = useCreateProposal();

  const [activeTab, setActiveTab] = useState<string>("open");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  // Compute per-status counts and filtered list
  const statusCounts = PROPOSAL_STATUSES.reduce(
    (acc, status) => {
      acc[status] = allProposals?.filter((p) => p.status === status).length ?? 0;
      return acc;
    },
    {} as Record<string, number>,
  );

  const filteredProposals =
    allProposals?.filter((p) => p.status === activeTab) ?? [];

  function handleProposalClick(proposalId: string) {
    navigate({ to: "/proposals/$proposalId", params: { proposalId } });
  }

  async function handleCreateProposal(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !projectId) return;

    try {
      const proposal = await createProposal.mutateAsync({
        projectId,
        data: {
          title: title.trim(),
          description: description.trim() || undefined,
          createdBy: currentUser?.id ?? "human-director",
        },
      });
      setDialogOpen(false);
      setTitle("");
      setDescription("");
      navigate({ to: "/proposals/$proposalId", params: { proposalId: proposal.id } });
    } catch {
      // Error is handled by TanStack Query
    }
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FileText className="size-6 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">Proposals</h1>
          {project && (
            <Badge variant="outline" className="text-xs font-normal">
              {project.name}
            </Badge>
          )}
        </div>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="size-4" />
              New Proposal
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={handleCreateProposal}>
              <DialogHeader>
                <DialogTitle>Create Proposal</DialogTitle>
                <DialogDescription>
                  Submit a new proposal for discussion. The AI agent will review
                  and discuss it with you.
                </DialogDescription>
              </DialogHeader>
              <div className="mt-4 space-y-4">
                <div className="space-y-2">
                  <label
                    htmlFor="proposal-title"
                    className="text-sm font-medium leading-none"
                  >
                    Title
                  </label>
                  <Input
                    id="proposal-title"
                    placeholder="What do you want to propose?"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    autoFocus
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor="proposal-description"
                    className="text-sm font-medium leading-none"
                  >
                    Description
                  </label>
                  <Textarea
                    id="proposal-description"
                    placeholder="Describe your proposal in detail..."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={6}
                  />
                </div>
              </div>
              <DialogFooter className="mt-6">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!title.trim() || createProposal.isPending}
                >
                  {createProposal.isPending
                    ? "Creating..."
                    : "Create Proposal"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Error state */}
      {error && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <p className="text-sm text-destructive">
              Failed to load proposals. Please try again.
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Status tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList variant="line">
          {PROPOSAL_STATUSES.map((status) => (
            <TabsTrigger key={status} value={status}>
              {formatStatus(status)}
              {!isLoading && (
                <Badge
                  variant="secondary"
                  className="ml-1.5 h-5 min-w-[20px] px-1.5 text-[10px]"
                >
                  {statusCounts[status]}
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        {PROPOSAL_STATUSES.map((status) => (
          <TabsContent key={status} value={status}>
            {/* Loading */}
            {isLoading && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <ProposalSkeleton key={i} />
                ))}
              </div>
            )}

            {/* Empty state */}
            {!isLoading && filteredProposals.length === 0 && (
              <div className="mt-4 flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
                <MessageSquare className="mb-3 size-10 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  No {formatStatus(status).toLowerCase()} proposals
                </p>
                {status === "open" && (
                  <Button
                    className="mt-3"
                    size="sm"
                    variant="outline"
                    onClick={() => setDialogOpen(true)}
                  >
                    <Plus className="size-4" />
                    Create one
                  </Button>
                )}
              </div>
            )}

            {/* Proposal cards */}
            {!isLoading && filteredProposals.length > 0 && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filteredProposals.map((proposal) => (
                  <ProposalCard
                    key={proposal.id}
                    proposal={proposal}
                    onClick={() => handleProposalClick(proposal.id)}
                  />
                ))}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
