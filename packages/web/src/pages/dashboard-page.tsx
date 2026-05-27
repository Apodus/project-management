import { useNavigate, useParams } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowRight,
  Bot,
  CheckCircle2,
  FileText,
  LayoutDashboard,
  ListTodo,
  MessageSquare,
  Milestone,
  Pencil,
  Plus,
  User,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProject, useProjectStats } from "@/hooks/use-projects";
import { useProjectActivity } from "@/hooks/use-activity";
import { useTasks } from "@/hooks/use-tasks";
import { useProposals } from "@/hooks/use-proposals";
import { useUsers } from "@/hooks/use-users";
import { useCurrentUser } from "@/hooks/use-auth";
import { useProjectStore } from "@/stores/project-store";
import {
  formatRelativeTime,
  formatStatus,
  getStatusColor,
  getPriorityColor,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActivityLogEntry, Task } from "@/lib/api";

// ---- Task status ordering for the bar chart ----

const STATUS_ORDER = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;

const STATUS_BAR_COLORS: Record<string, string> = {
  backlog: "bg-gray-400 dark:bg-gray-500",
  ready: "bg-blue-500 dark:bg-blue-400",
  in_progress: "bg-amber-500 dark:bg-amber-400",
  in_review: "bg-indigo-500 dark:bg-indigo-400",
  done: "bg-green-500 dark:bg-green-400",
  cancelled: "bg-red-400 dark:bg-red-500",
};

// ---- Proposal pipeline colors ----

const PROPOSAL_PIPELINE = [
  { status: "open", label: "Open", color: "bg-blue-500", textColor: "text-white" },
  { status: "discussing", label: "Discussing", color: "bg-amber-500", textColor: "text-white" },
  { status: "accepted", label: "Accepted", color: "bg-green-500", textColor: "text-white" },
  { status: "planned", label: "Planned", color: "bg-purple-500", textColor: "text-white" },
  { status: "in_progress", label: "In Progress", color: "bg-sky-500", textColor: "text-white" },
  { status: "completed", label: "Completed", color: "bg-emerald-500", textColor: "text-white" },
] as const;

// ---- Stats Section ----

function StatsSection({
  projectId,
}: {
  projectId: string;
}) {
  const { data: stats, isLoading } = useProjectStats(projectId);

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="py-4">
            <CardContent>
              <Skeleton className="h-8 w-16" />
              <Skeleton className="mt-2 h-4 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!stats) return null;

  const tasksByStatus = stats.tasksByStatus ?? {};
  const totalTasks = stats.totalTasks ?? 0;

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="py-4">
          <CardContent className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400">
              <ListTodo className="size-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{totalTasks}</p>
              <p className="text-xs text-muted-foreground">Total Tasks</p>
            </div>
          </CardContent>
        </Card>

        <Card className="py-4">
          <CardContent className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400">
              <CheckCircle2 className="size-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{tasksByStatus["done"] ?? 0}</p>
              <p className="text-xs text-muted-foreground">Tasks Done</p>
            </div>
          </CardContent>
        </Card>

        <Card className="py-4">
          <CardContent className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-purple-100 text-purple-600 dark:bg-purple-900/40 dark:text-purple-400">
              <Milestone className="size-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.epicCount ?? 0}</p>
              <p className="text-xs text-muted-foreground">Epics</p>
            </div>
          </CardContent>
        </Card>

        <Card className="py-4">
          <CardContent className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400">
              <FileText className="size-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.proposalCount ?? 0}</p>
              <p className="text-xs text-muted-foreground">Proposals</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Task status bar */}
      {totalTasks > 0 && (
        <Card className="py-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tasks by Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Horizontal stacked bar */}
            <div className="flex h-4 overflow-hidden rounded-full bg-muted">
              {STATUS_ORDER.map((status) => {
                const count = tasksByStatus[status] ?? 0;
                if (count === 0) return null;
                const pct = (count / totalTasks) * 100;
                return (
                  <Tooltip key={status}>
                    <TooltipTrigger asChild>
                      <div
                        className={cn(
                          "transition-all cursor-default",
                          STATUS_BAR_COLORS[status],
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{formatStatus(status)}: {count}</p>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>

            {/* Legend */}
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {STATUS_ORDER.map((status) => {
                const count = tasksByStatus[status] ?? 0;
                if (count === 0) return null;
                return (
                  <div key={status} className="flex items-center gap-1.5 text-xs">
                    <div
                      className={cn(
                        "size-2.5 rounded-full",
                        STATUS_BAR_COLORS[status],
                      )}
                    />
                    <span className="text-muted-foreground">
                      {formatStatus(status)}
                    </span>
                    <span className="font-medium">{count}</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---- Recent Activity ----

function getActionIcon(action: string) {
  switch (action) {
    case "created":
      return Plus;
    case "updated":
      return Pencil;
    case "status_changed":
    case "transitioned":
      return ArrowRight;
    case "assigned":
      return User;
    case "commented":
      return MessageSquare;
    case "archived":
      return Archive;
    default:
      return Activity;
  }
}

function getActionColor(action: string): string {
  switch (action) {
    case "created":
      return "text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/40";
    case "updated":
      return "text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/40";
    case "status_changed":
    case "transitioned":
      return "text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/40";
    case "assigned":
      return "text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/40";
    case "commented":
      return "text-sky-600 bg-sky-100 dark:text-sky-400 dark:bg-sky-900/40";
    case "archived":
      return "text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/40";
    default:
      return "text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/40";
  }
}

function CompactActivityEntry({
  entry,
  actorName,
}: {
  entry: ActivityLogEntry;
  actorName?: string;
}) {
  const Icon = getActionIcon(entry.action);
  const iconColor = getActionColor(entry.action);

  return (
    <div className="flex items-center gap-3 py-2">
      <div
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full",
          iconColor,
        )}
      >
        <Icon className="size-3" />
      </div>
      <p className="min-w-0 flex-1 truncate text-sm">
        <span className="font-medium">{actorName ?? entry.actorId ?? "System"}</span>
        {" "}
        <span className="text-muted-foreground">
          {formatStatus(entry.action).toLowerCase()} {entry.entityType}
        </span>
      </p>
      <span className="shrink-0 text-xs text-muted-foreground/60">
        {formatRelativeTime(entry.createdAt)}
      </span>
    </div>
  );
}

function RecentActivitySection({
  projectId,
  userMap,
}: {
  projectId: string;
  userMap: Map<string, { name: string; type: string }>;
}) {
  const navigate = useNavigate();
  const { data, isLoading } = useProjectActivity(projectId, { per_page: 10 });
  const entries = data?.data ?? [];

  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Recent Activity
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() =>
              navigate({
                to: "/projects/$projectId/activity",
                params: { projectId },
              })
            }
          >
            View all
            <ArrowRight className="ml-1 size-3" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-6 rounded-full" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-3 w-14" />
              </div>
            ))}
          </div>
        )}

        {!isLoading && entries.length === 0 && (
          <div className="flex flex-col items-center py-6">
            <Activity className="mb-2 size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No recent activity</p>
          </div>
        )}

        {!isLoading && entries.length > 0 && (
          <div className="divide-y">
            {entries.map((entry) => {
              const actor = entry.actorId
                ? userMap.get(entry.actorId)
                : undefined;
              return (
                <CompactActivityEntry
                  key={entry.id}
                  entry={entry}
                  actorName={actor?.name}
                />
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- My Tasks ----

function MyTasksSection({
  projectId,
  currentUserId,
}: {
  projectId: string;
  currentUserId: string;
}) {
  const navigate = useNavigate();
  const { data, isLoading } = useTasks(projectId, {
    assignee: currentUserId,
    sortBy: "priority",
    order: "asc",
    perPage: 10,
  });
  const tasks = (data?.data ?? []).filter(
    (t) => t.status !== "done" && t.status !== "cancelled",
  );

  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            My Tasks
          </CardTitle>
          {tasks.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() =>
                navigate({
                  to: "/projects/$projectId/tasks",
                  params: { projectId },
                })
              }
            >
              View all
              <ArrowRight className="ml-1 size-3" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-5 w-14" />
              </div>
            ))}
          </div>
        )}

        {!isLoading && tasks.length === 0 && (
          <div className="flex flex-col items-center py-6">
            <ListTodo className="mb-2 size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No tasks assigned to you
            </p>
          </div>
        )}

        {!isLoading && tasks.length > 0 && (
          <div className="divide-y">
            {tasks.map((task: Task) => (
              <div
                key={task.id}
                className="flex cursor-pointer items-center gap-3 py-2 transition-colors hover:bg-muted/30"
                onClick={() =>
                  navigate({ to: "/tasks/$taskId", params: { taskId: task.id } })
                }
              >
                <Badge
                  variant="secondary"
                  className={cn("shrink-0 text-[10px]", getStatusColor(task.status))}
                >
                  {formatStatus(task.status)}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {task.title}
                </span>
                <Badge
                  variant="secondary"
                  className={cn(
                    "shrink-0 text-[10px]",
                    getPriorityColor(task.priority),
                  )}
                >
                  {formatStatus(task.priority)}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Active AI Agents ----

function formatDuration(startedAt: string): string {
  const started = new Date(startedAt);
  const now = new Date();
  const diffMs = now.getTime() - started.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);

  if (diffMinutes < 1) return "just started";
  if (diffMinutes < 60) return `working for ${diffMinutes}m`;
  if (diffHours < 24) return `working for ${diffHours}h ${diffMinutes % 60}m`;
  return `working for ${Math.floor(diffHours / 24)}d ${diffHours % 24}h`;
}

function ActiveAIAgentsSection({
  projectId,
  userMap,
}: {
  projectId: string;
  userMap: Map<string, { name: string; type: string }>;
}) {
  const navigate = useNavigate();
  const { data, isLoading } = useTasks(projectId, {
    status: "in_progress",
    perPage: 50,
  });

  const tasks = data?.data ?? [];

  // Filter to tasks assigned to AI agent users
  const aiTasks = tasks.filter((t) => {
    if (!t.assigneeId) return false;
    const user = userMap.get(t.assigneeId);
    return user?.type === "ai_agent";
  });

  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Active AI Agents
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-full" />
                <div className="flex-1 space-y-1">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!isLoading && aiTasks.length === 0 && (
          <div className="flex flex-col items-center py-6">
            <Bot className="mb-2 size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No AI agents currently working
            </p>
          </div>
        )}

        {!isLoading && aiTasks.length > 0 && (
          <div className="divide-y">
            {aiTasks.map((task) => {
              const agent = task.assigneeId
                ? userMap.get(task.assigneeId)
                : undefined;
              return (
                <div
                  key={task.id}
                  className="flex cursor-pointer items-center gap-3 py-2.5 transition-colors hover:bg-muted/30"
                  onClick={() =>
                    navigate({
                      to: "/tasks/$taskId",
                      params: { taskId: task.id },
                    })
                  }
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400">
                    <Bot className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {task.title}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {agent?.name ?? task.assigneeId}
                      {task.startedAt && (
                        <span className="ml-1.5 text-muted-foreground/60">
                          {formatDuration(task.startedAt)}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Proposal Pipeline ----

function ProposalPipelineSection({
  projectId,
}: {
  projectId: string;
}) {
  const navigate = useNavigate();
  const { data: allProposals, isLoading } = useProposals(projectId);

  const counts = PROPOSAL_PIPELINE.reduce(
    (acc, stage) => {
      acc[stage.status] =
        allProposals?.filter((p) => p.status === stage.status).length ?? 0;
      return acc;
    },
    {} as Record<string, number>,
  );

  const totalProposals = allProposals?.length ?? 0;

  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Proposal Pipeline
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 flex-1" />
            ))}
          </div>
        )}

        {!isLoading && totalProposals === 0 && (
          <div className="flex flex-col items-center py-6">
            <FileText className="mb-2 size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No proposals yet
            </p>
          </div>
        )}

        {!isLoading && totalProposals > 0 && (
          <div className="flex gap-1">
            {PROPOSAL_PIPELINE.map((stage, i) => {
              const count = counts[stage.status] ?? 0;
              return (
                <button
                  key={stage.status}
                  className={cn(
                    "flex flex-1 flex-col items-center justify-center gap-1 py-3 transition-opacity hover:opacity-80",
                    stage.color,
                    stage.textColor,
                    i === 0 && "rounded-l-lg",
                    i === PROPOSAL_PIPELINE.length - 1 && "rounded-r-lg",
                  )}
                  onClick={() =>
                    navigate({
                      to: "/projects/$projectId/proposals",
                      params: { projectId },
                    })
                  }
                >
                  <span className="text-lg font-bold">{count}</span>
                  <span className="text-[10px] font-medium opacity-90">
                    {stage.label}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Attention Needed ----

function AttentionSection({
  projectId,
}: {
  projectId: string;
}) {
  const navigate = useNavigate();

  // Fetch blocked tasks count
  const { data: blockedData, isLoading: blockedLoading } = useTasks(projectId, {
    is_blocked: "true",
    perPage: 1,
  });
  const blockedCount = blockedData?.pagination?.total ?? 0;

  // Fetch open proposals count
  const { data: allProposals, isLoading: proposalsLoading } = useProposals(projectId);
  const openProposals = (allProposals ?? []).filter(
    (p) => p.status === "open" || p.status === "discussing",
  );
  const openProposalCount = openProposals.length;

  const isLoading = blockedLoading || proposalsLoading;

  if (isLoading) {
    return (
      <Card className="py-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Attention Needed
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (blockedCount === 0 && openProposalCount === 0) {
    return (
      <Card className="py-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Attention Needed
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center py-6">
            <CheckCircle2 className="mb-2 size-8 text-green-500/60" />
            <p className="text-sm text-muted-foreground">
              All clear — nothing needs attention
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Attention Needed
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {blockedCount > 0 && (
          <button
            className="flex w-full items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-left transition-colors hover:bg-red-100 dark:border-red-900/40 dark:bg-red-950/20 dark:hover:bg-red-950/40"
            onClick={() =>
              navigate({
                to: "/projects/$projectId/tasks",
                params: { projectId },
              })
            }
          >
            <AlertTriangle className="size-5 shrink-0 text-red-500" />
            <div className="flex-1">
              <p className="text-sm font-medium text-red-700 dark:text-red-400">
                {blockedCount} blocked {blockedCount === 1 ? "task" : "tasks"}
              </p>
              <p className="text-xs text-red-600/70 dark:text-red-400/60">
                Tasks waiting on dependencies
              </p>
            </div>
            <ArrowRight className="size-4 text-red-400" />
          </button>
        )}

        {openProposalCount > 0 && (
          <button
            className="flex w-full items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-left transition-colors hover:bg-amber-100 dark:border-amber-900/40 dark:bg-amber-950/20 dark:hover:bg-amber-950/40"
            onClick={() =>
              navigate({
                to: "/projects/$projectId/proposals",
                params: { projectId },
              })
            }
          >
            <FileText className="size-5 shrink-0 text-amber-500" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                {openProposalCount} open {openProposalCount === 1 ? "proposal" : "proposals"}
              </p>
              <p className="text-xs text-amber-600/70 dark:text-amber-400/60">
                Proposals awaiting review or discussion
              </p>
            </div>
            <ArrowRight className="size-4 text-amber-400" />
          </button>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Dashboard Page ----

export function DashboardPage() {
  const { projectId } = useParams({ strict: false });
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  // Fetch project details
  const { data: project } = useProject(projectId);
  if (project) {
    setCurrentProject(project.id, project.name);
  }

  // Fetch current user for "My Tasks"
  const { data: currentUser } = useCurrentUser();

  // Fetch users for activity actor names and AI agent filtering
  const { data: users } = useUsers();
  const userMap = new Map(
    (users ?? []).map((u) => [u.id, { name: u.displayName, type: u.type }]),
  );

  if (!projectId) return null;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <LayoutDashboard className="size-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        {project && (
          <Badge variant="outline" className="text-xs font-normal">
            {project.name}
          </Badge>
        )}
      </div>

      {/* Stats */}
      <StatsSection projectId={projectId} />

      {/* Two-column layout for activity + tasks */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent Activity */}
        <RecentActivitySection projectId={projectId} userMap={userMap} />

        {/* My Tasks */}
        {currentUser && (
          <MyTasksSection
            projectId={projectId}
            currentUserId={currentUser.id}
          />
        )}
      </div>

      {/* Active AI Agents + Proposal Pipeline */}
      <div className="grid gap-6 lg:grid-cols-2">
        <ActiveAIAgentsSection projectId={projectId} userMap={userMap} />
        <ProposalPipelineSection projectId={projectId} />
      </div>

      {/* Attention Needed */}
      <AttentionSection projectId={projectId} />
    </div>
  );
}
