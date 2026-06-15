import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { FileText, Hand, ListTodo, Milestone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ClaimStateBadge } from "@/components/claim-state-badge";
import { ReleaseClaimDialog } from "@/components/release-claim-dialog";
import { ReleaseToDialog } from "@/components/release-to-dialog";
import { RequestTakeoverDialog } from "@/components/request-takeover-dialog";
import { useProject } from "@/hooks/use-projects";
import { useProjectClaims } from "@/hooks/use-claims";
import { useProjectStore } from "@/stores/project-store";
import { formatRelativeTime, formatStatus, getStatusColor } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ClaimItem } from "@/lib/api";

// ─── Claims operations panel (Campaign C3) ────────────────────────
// Every active claim in the project in one table, grouped STALE-FIRST so a
// possibly-abandoned claim is the first thing an operator sees. Holder names
// come from the entity's human-facing assigneeId/claimedBy pointer (resolved
// server-side) — never from the lease layer.

// Stale first (the actionable group), then live, then yours. The server never
// returns "unclaimed" rows, but the rank is total so a future state sorts last.
const STATE_RANK: Record<ClaimItem["claimState"], number> = {
  stale: 0,
  live: 1,
  yours: 2,
  unclaimed: 3,
};

function EntityTypeIcon({ entityType }: { entityType: ClaimItem["entityType"] }) {
  switch (entityType) {
    case "task":
      return <ListTodo className="text-muted-foreground size-4" />;
    case "epic":
      return <Milestone className="text-muted-foreground size-4" />;
    case "proposal":
      return <FileText className="text-muted-foreground size-4" />;
  }
}

function EntityLink({ item }: { item: ClaimItem }) {
  const className = "font-medium hover:underline line-clamp-1";
  switch (item.entityType) {
    case "task":
      return (
        <Link to="/tasks/$taskId" params={{ taskId: item.id }} className={className}>
          {item.title}
        </Link>
      );
    case "epic":
      return (
        <Link to="/epics/$epicId" params={{ epicId: item.id }} className={className}>
          {item.title}
        </Link>
      );
    case "proposal":
      return (
        <Link to="/proposals/$proposalId" params={{ proposalId: item.id }} className={className}>
          {item.title}
        </Link>
      );
  }
}

function ClaimsTableSkeleton() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <TableRow key={i}>
          <TableCell>
            <Skeleton className="h-4 w-4" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-48" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-5 w-16" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-5 w-14" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-24" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-16" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-20" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function ClaimRow({ item }: { item: ClaimItem }) {
  return (
    <TableRow>
      <TableCell className="w-[40px]">
        <EntityTypeIcon entityType={item.entityType} />
      </TableCell>
      <TableCell className="max-w-[350px]">
        <EntityLink item={item} />
      </TableCell>
      <TableCell>
        <Badge variant="secondary" className={cn("text-[11px]", getStatusColor(item.status))}>
          {formatStatus(item.status)}
        </Badge>
      </TableCell>
      <TableCell>
        <ClaimStateBadge state={item.claimState} />
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        <span className="truncate">{item.holder.name}</span>
        {item.holder.type === "ai_agent" && (
          <Badge variant="outline" className="ml-1.5 px-1 py-0 text-[10px]">
            AI
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">
        {/* claimedAt is the lease-layer acquisition time; a legacy pre-C2 claim
            has none — fall back to the entity's updatedAt. */}
        {formatRelativeTime(item.claimedAt ?? item.updatedAt)}
      </TableCell>
      <TableCell>
        <ClaimRowActions item={item} />
      </TableCell>
    </TableRow>
  );
}

// Row actions — a plain release plus the two handoff primitives. Release clears
// the holder outright (the operator action for a dead claim); release-to
// directly transfers the claim to a named worker; request-takeover is stomp-safe
// (stale auto-grants, live only notifies — never mutated).
function ClaimRowActions({ item }: { item: ClaimItem }) {
  const [plainReleaseOpen, setPlainReleaseOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [takeoverOpen, setTakeoverOpen] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => setPlainReleaseOpen(true)}>
        Release
      </Button>
      <Button variant="outline" size="sm" onClick={() => setReleaseOpen(true)}>
        Release to…
      </Button>
      {item.claimState !== "yours" && (
        <Button variant="outline" size="sm" onClick={() => setTakeoverOpen(true)}>
          Request takeover
        </Button>
      )}
      <ReleaseClaimDialog item={item} open={plainReleaseOpen} onOpenChange={setPlainReleaseOpen} />
      <ReleaseToDialog item={item} open={releaseOpen} onOpenChange={setReleaseOpen} />
      <RequestTakeoverDialog item={item} open={takeoverOpen} onOpenChange={setTakeoverOpen} />
    </div>
  );
}

export function ClaimsPage() {
  const { projectId } = useParams({ strict: false });
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  const { data: project } = useProject(projectId);
  useEffect(() => {
    if (project) {
      setCurrentProject(project.id, project.name);
    }
  }, [project, setCurrentProject]);

  const { data, isLoading, error, refetch } = useProjectClaims(projectId);

  const items = useMemo(() => {
    const list = data?.items ?? [];
    // Stable group sort: stale first, then live, then yours; oldest-claimed
    // first inside each group so the longest-held claim tops its group.
    return [...list].sort((a, b) => {
      const rank = STATE_RANK[a.claimState] - STATE_RANK[b.claimState];
      if (rank !== 0) return rank;
      return (a.claimedAt ?? a.updatedAt).localeCompare(b.claimedAt ?? b.updatedAt);
    });
  }, [data]);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <Hand className="text-muted-foreground size-6" />
        <h1 className="text-2xl font-bold tracking-tight">Claims</h1>
        {project && (
          <Badge variant="outline" className="text-xs font-normal">
            {project.name}
          </Badge>
        )}
      </div>

      <p className="text-muted-foreground text-sm">
        Every claimed task, epic, and proposal with its liveness. A{" "}
        <span className="font-medium">stale</span> claim&apos;s lease has lapsed — the holder may
        have abandoned it; a <span className="font-medium">live</span> claim is actively held and is
        never taken over.
      </p>

      {/* Error state */}
      {error && (
        <div className="border-destructive/50 bg-destructive/10 flex flex-col items-center gap-3 rounded-lg border py-8">
          <p className="text-destructive text-sm">Failed to load claims. Please try again.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* Table */}
      {!error && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40px]" />
                <TableHead className="min-w-[250px]">Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Claim</TableHead>
                <TableHead>Holder</TableHead>
                <TableHead>Claimed</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && <ClaimsTableSkeleton />}

              {!isLoading && items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <Hand className="text-muted-foreground/40 size-8" />
                      <p className="text-muted-foreground text-sm">No active claims.</p>
                    </div>
                  </TableCell>
                </TableRow>
              )}

              {!isLoading &&
                items.map((item) => <ClaimRow key={`${item.entityType}-${item.id}`} item={item} />)}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
