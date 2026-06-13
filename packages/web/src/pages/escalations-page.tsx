import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { Siren, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useProject } from "@/hooks/use-projects";
import { useEscalations } from "@/hooks/use-escalations";
import { useProjectStore } from "@/stores/project-store";
import {
  formatRelativeTime,
  formatStatus,
  getPriorityColor,
  getStatusColor,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Escalation, EscalationFilters } from "@/lib/api";
import type { EscalationsSearch } from "@/router";

// Escalation enum vocabularies. Kept page-local (the notes-page precedent — the
// web package does not depend on @pm/shared); these mirror ESCALATION_KINDS /
// ESCALATION_STATUSES / ESCALATION_SEVERITIES in @pm/shared.
const ESCALATION_KINDS = ["bug_report", "question", "request", "blocked"] as const;
const ESCALATION_STATUSES = [
  "open",
  "acknowledged",
  "answered",
  "resolved",
  "needs_human",
] as const;
const ESCALATION_SEVERITIES = ["low", "medium", "high"] as const;

// Local kind→tint map (shaped like notes-page's getKindColor). Kept page-local
// per the established convention — do NOT edit format.ts for this vocabulary.
function getKindColor(kind: string): string {
  switch (kind) {
    case "bug_report":
      return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
    case "question":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
    case "request":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300";
    case "blocked":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    default:
      return "bg-gray-100 text-gray-800 dark:bg-gray-900/40 dark:text-gray-300";
  }
}

function EscalationCard({ escalation }: { escalation: Escalation }) {
  const { projectId, id } = escalation;
  return (
    <Link
      to="/projects/$projectId/escalations/$escalationId"
      params={{ projectId, escalationId: id }}
      className="block focus:outline-none"
    >
      <Card className="gap-3 py-4 transition-colors hover:border-primary/50">
        <CardHeader className="pb-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant="secondary"
              className={cn("text-[11px]", getKindColor(escalation.kind))}
            >
              {formatStatus(escalation.kind)}
            </Badge>
            <Badge
              variant="secondary"
              className={cn("text-[11px]", getStatusColor(escalation.status))}
            >
              {formatStatus(escalation.status)}
            </Badge>
            {escalation.severity && (
              <Badge
                variant="secondary"
                className={cn("text-[11px]", getPriorityColor(escalation.severity))}
              >
                {formatStatus(escalation.severity)}
              </Badge>
            )}
          </div>
          <CardTitle className="line-clamp-1 text-base">{escalation.title}</CardTitle>
        </CardHeader>
        <CardContent>
          {escalation.body ? (
            <p className="line-clamp-2 text-sm italic text-muted-foreground">
              {escalation.body}
            </p>
          ) : (
            <p className="text-sm italic text-muted-foreground/50">No body</p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground/70">
            <span className="font-mono">
              {escalation.originRepo}
              <span className="text-muted-foreground/50"> · </span>
              {escalation.originWorkerKey}
            </span>
            <span>{formatRelativeTime(escalation.createdAt)}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function EscalationSkeleton() {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="pb-0">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="mt-2 h-5 w-3/4" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-2/3" />
        <Skeleton className="mt-3 h-3 w-1/3" />
      </CardContent>
    </Card>
  );
}

export function EscalationsPage() {
  const { projectId } = useParams({ strict: false });
  const search = useSearch({ strict: false }) as EscalationsSearch;
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  // Fetch project details so we can set the project name in the store. Done in
  // an effect — calling a store setter during render flags a React 19 error.
  const { data: project } = useProject(projectId);
  useEffect(() => {
    if (project) {
      setCurrentProject(project.id, project.name);
    }
  }, [project, setCurrentProject]);

  // Filter state: "" / "all" sentinel → omitted from EscalationFilters. Status /
  // kind / severity seeded ONCE from deep-link search params.
  const [statusFilter, setStatusFilter] = useState<string>(search.status ?? "");
  const [kindFilter, setKindFilter] = useState<string>(search.kind ?? "");
  const [severityFilter, setSeverityFilter] = useState<string>(search.severity ?? "");
  const [originRepo, setOriginRepo] = useState<string>(search.originRepo ?? "");
  const [originWorkerKey, setOriginWorkerKey] = useState<string>("");

  const filters: EscalationFilters = useMemo(() => {
    const f: EscalationFilters = {};
    if (statusFilter && statusFilter !== "all")
      f.status = statusFilter as Escalation["status"];
    if (kindFilter && kindFilter !== "all") f.kind = kindFilter as Escalation["kind"];
    if (severityFilter && severityFilter !== "all")
      f.severity = severityFilter as NonNullable<Escalation["severity"]>;
    if (originRepo.trim()) f.originRepo = originRepo.trim();
    if (originWorkerKey.trim()) f.originWorkerKey = originWorkerKey.trim();
    return f;
  }, [statusFilter, kindFilter, severityFilter, originRepo, originWorkerKey]);

  const escalationsQuery = useEscalations(projectId, filters);
  const escalations = escalationsQuery.data?.data ?? [];
  const { isLoading, error, refetch } = escalationsQuery;

  const hasActiveFilters = !!(
    (statusFilter && statusFilter !== "all") ||
    (kindFilter && kindFilter !== "all") ||
    (severityFilter && severityFilter !== "all") ||
    originRepo.trim() ||
    originWorkerKey.trim()
  );

  function clearFilters() {
    setStatusFilter("");
    setKindFilter("");
    setSeverityFilter("");
    setOriginRepo("");
    setOriginWorkerKey("");
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <Siren className="size-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">Escalations</h1>
        {project && (
          <Badge variant="outline" className="text-xs font-normal">
            {project.name}
          </Badge>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger size="sm" className="w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {ESCALATION_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {formatStatus(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={kindFilter} onValueChange={setKindFilter}>
          <SelectTrigger size="sm" className="w-[150px]">
            <SelectValue placeholder="Kind" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All kinds</SelectItem>
            {ESCALATION_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {formatStatus(k)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={severityFilter} onValueChange={setSeverityFilter}>
          <SelectTrigger size="sm" className="w-[150px]">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            {ESCALATION_SEVERITIES.map((s) => (
              <SelectItem key={s} value={s}>
                {formatStatus(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          placeholder="Origin repo…"
          value={originRepo}
          onChange={(e) => setOriginRepo(e.target.value)}
          className="h-9 w-44"
        />

        <Input
          placeholder="Worker key…"
          value={originWorkerKey}
          onChange={(e) => setOriginWorkerKey(e.target.value)}
          className="h-9 w-44"
        />

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
              Failed to load escalations. Please try again.
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
            <EscalationSkeleton key={i} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && escalations.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
          <Siren className="mb-3 size-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            {hasActiveFilters
              ? "No escalations match your filters"
              : "No escalations yet"}
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

      {/* Escalation grid */}
      {!isLoading && !error && escalations.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {escalations.map((escalation) => (
            <EscalationCard key={escalation.id} escalation={escalation} />
          ))}
        </div>
      )}
    </div>
  );
}
