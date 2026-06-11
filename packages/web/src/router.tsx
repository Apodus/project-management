import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Navigate,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppLayout } from "@/components/layout/app-layout";
import { LoginPage } from "@/pages/login-page";
import { SetupPage } from "@/pages/setup-page";
import { ApiError, getCurrentUser, getSetupStatus } from "@/lib/api";

// ─── Route-level code splitting (Campaign C3 P6) ───────────────────
// Every authenticated-layout page is a lazy route chunk
// (lazyRouteComponent(import, exportName) — the typed exportName makes a
// rename/typo a TYPECHECK error, not a runtime blank). Kept EAGER: AppLayout
// (the shell), LoginPage/SetupPage (first paint on a cold visit), and the
// index <Navigate>. defaultPreload: "intent" (already set below) prefetches a
// chunk on hover/focus, so the lazy hop is rarely felt.

const ActivityPage = lazyRouteComponent(
  () => import("@/pages/activity-page"),
  "ActivityPage",
);
const DashboardPage = lazyRouteComponent(
  () => import("@/pages/dashboard-page"),
  "DashboardPage",
);
const EpicDetailPage = lazyRouteComponent(
  () => import("@/pages/epic-detail-page"),
  "EpicDetailPage",
);
const EpicListPage = lazyRouteComponent(
  () => import("@/pages/epic-list-page"),
  "EpicListPage",
);
const EpicTimelinePage = lazyRouteComponent(
  () => import("@/pages/epic-timeline-page"),
  "EpicTimelinePage",
);
const MilestonesPage = lazyRouteComponent(
  () => import("@/pages/milestones-page"),
  "MilestonesPage",
);
const ProjectListPage = lazyRouteComponent(
  () => import("@/pages/project-list-page"),
  "ProjectListPage",
);
const ProposalDetailPage = lazyRouteComponent(
  () => import("@/pages/proposal-detail-page"),
  "ProposalDetailPage",
);
const ProposalListPage = lazyRouteComponent(
  () => import("@/pages/proposal-list-page"),
  "ProposalListPage",
);
const NotesPage = lazyRouteComponent(
  () => import("@/pages/notes-page"),
  "NotesPage",
);
const TaskDetailPage = lazyRouteComponent(
  () => import("@/pages/task-detail-page"),
  "TaskDetailPage",
);
const TaskListPage = lazyRouteComponent(
  () => import("@/pages/task-list-page"),
  "TaskListPage",
);
const BoardPage = lazyRouteComponent(
  () => import("@/pages/board-page"),
  "BoardPage",
);
const ClaimsPage = lazyRouteComponent(
  () => import("@/pages/claims-page"),
  "ClaimsPage",
);
const TrainDashboardPage = lazyRouteComponent(
  () => import("@/pages/train-dashboard-page"),
  "TrainDashboardPage",
);
const TrainAuditPage = lazyRouteComponent(
  () => import("@/pages/train-audit-page"),
  "TrainAuditPage",
);
const MergeRequestTimelinePage = lazyRouteComponent(
  () => import("@/pages/merge-request-timeline-page"),
  "MergeRequestTimelinePage",
);
const UsersPage = lazyRouteComponent(
  () => import("@/pages/settings/users-page"),
  "UsersPage",
);
const BackupPage = lazyRouteComponent(
  () => import("@/pages/settings/backup-page"),
  "BackupPage",
);
const TemplatesPage = lazyRouteComponent(
  () => import("@/pages/settings/templates-page"),
  "TemplatesPage",
);
const AutomationPage = lazyRouteComponent(
  () => import("@/pages/settings/automation-page"),
  "AutomationPage",
);
const NotificationsPage = lazyRouteComponent(
  () => import("@/pages/settings/notifications-page"),
  "NotificationsPage",
);
const ConflictResolutionPage = lazyRouteComponent(
  () => import("@/pages/settings/conflict-resolution-page"),
  "ConflictResolutionPage",
);
const IntegratorPage = lazyRouteComponent(
  () => import("@/pages/settings/integrator-page"),
  "IntegratorPage",
);
const CategoriesPage = lazyRouteComponent(
  () => import("@/pages/settings/categories-page"),
  "CategoriesPage",
);
const HelpPage = lazyRouteComponent(
  () => import("@/pages/help-page"),
  "HelpPage",
);

// ---- Root route (no layout — just an outlet) ----

const rootRoute = createRootRoute({
  component: Outlet,
});

// ---- Public routes (no sidebar) ----

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

// ---- Authenticated layout route ----
// All routes inside this layout require authentication.

const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppLayout,
  beforeLoad: async () => {
    // Check if setup is needed
    try {
      const setupStatus = await getSetupStatus();
      if (setupStatus.needsSetup) {
        throw redirect({ to: "/setup" });
      }
    } catch (e) {
      if (e instanceof Error && "to" in e) throw e; // re-throw redirect
      // If setup status fails, continue to auth check
    }

    // Check if user is authenticated
    try {
      const user = await getCurrentUser();
      return { user };
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        throw redirect({ to: "/login" });
      }
      throw redirect({ to: "/login" });
    }
  },
});

// ---- App routes (inside authenticated layout) ----

// / — redirect to /projects
const indexRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/",
  component: () => <Navigate to="/projects" />,
});

// /projects — project list
const projectListRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/projects",
  component: ProjectListPage,
});

// /projects/$projectId — project layout (renders child routes)
const projectRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/projects/$projectId",
});

// /projects/$projectId/ — dashboard
const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  component: DashboardPage,
});

// /projects/$projectId/proposals — proposal list
const projectProposalListRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/proposals",
  component: ProposalListPage,
});

// Search params type for the notes inbox (deep-link from anchored-note badges;
// `q` seeds the free-text search box — command-palette note hits land here)
export interface NotesSearch {
  anchorType?: string;
  anchorId?: string;
  status?: string;
  q?: string;
}

// /projects/$projectId/notes — notes inbox (Campaign C3)
const projectNotesRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/notes",
  component: NotesPage,
  validateSearch: (search: Record<string, unknown>): NotesSearch => ({
    anchorType:
      typeof search.anchorType === "string" ? search.anchorType : undefined,
    anchorId: typeof search.anchorId === "string" ? search.anchorId : undefined,
    status: typeof search.status === "string" ? search.status : undefined,
    q: typeof search.q === "string" ? search.q : undefined,
  }),
});

// Search params type for task list
export interface TaskListSearch {
  status?: string;
  priority?: string;
  type?: string;
  assignee?: string;
  epic?: string;
  search?: string;
  sort?: string;
  order?: "asc" | "desc";
  page?: number;
  group_by?: string;
}

// /projects/$projectId/tasks — task list
const projectTaskListRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/tasks",
  component: TaskListPage,
  validateSearch: (search: Record<string, unknown>): TaskListSearch => ({
    status: typeof search.status === "string" ? search.status : undefined,
    priority: typeof search.priority === "string" ? search.priority : undefined,
    type: typeof search.type === "string" ? search.type : undefined,
    assignee: typeof search.assignee === "string" ? search.assignee : undefined,
    epic: typeof search.epic === "string" ? search.epic : undefined,
    search: typeof search.search === "string" ? search.search : undefined,
    sort: typeof search.sort === "string" ? search.sort : undefined,
    order: search.order === "asc" || search.order === "desc" ? search.order : undefined,
    page: typeof search.page === "number" ? search.page : (typeof search.page === "string" ? parseInt(search.page, 10) || undefined : undefined),
    group_by: typeof search.group_by === "string" ? search.group_by : undefined,
  }),
});

// /projects/$projectId/board — kanban board (project-wide, demoted to power-user / direct URL)
const projectBoardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/board",
  component: BoardPage,
});

// /projects/$projectId/epics/$epicId/board — epic-scoped kanban board (the primary drill-down)
const projectEpicBoardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/epics/$epicId/board",
  component: BoardPage,
});

// /projects/$projectId/epics — epic list
const projectEpicListRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/epics",
  component: EpicListPage,
});

// /projects/$projectId/roadmap — timeline-DAG epic graph
const projectRoadmapRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/roadmap",
  component: EpicTimelinePage,
});

// /projects/$projectId/activity — activity feed
const projectActivityRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/activity",
  component: ActivityPage,
});

// /projects/$projectId/milestones — milestones
const projectMilestonesRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/milestones",
  component: MilestonesPage,
});

// /projects/$projectId/claims — claims operations panel (Campaign C3)
const projectClaimsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/claims",
  component: ClaimsPage,
});

// /projects/$projectId/train — merge train dashboard
const projectTrainRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/train",
  component: TrainDashboardPage,
});

// /projects/$projectId/train/audit — break-glass controls + audit log (admin-only)
const projectTrainAuditRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/train/audit",
  component: TrainAuditPage,
});

// /proposals/$proposalId — proposal detail
const proposalDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/proposals/$proposalId",
  component: ProposalDetailPage,
});

// /tasks/$taskId — task detail
const taskDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/tasks/$taskId",
  component: TaskDetailPage,
});

// /epics/$epicId — epic detail
const epicDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/epics/$epicId",
  component: EpicDetailPage,
});

// /merge-requests/$requestId/timeline — per-request merge timeline
const mergeRequestTimelineRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/merge-requests/$requestId/timeline",
  component: MergeRequestTimelinePage,
});

// /settings/users — user management
const settingsUsersRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/settings/users",
  component: UsersPage,
});

// /settings/backup — database backup
const settingsBackupRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/settings/backup",
  component: BackupPage,
});

// /settings/templates — templates management
const settingsTemplatesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/settings/templates",
  component: TemplatesPage,
});

// /projects/$projectId/settings/automation — automation rules
const projectAutomationRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/settings/automation",
  component: AutomationPage,
});

// /projects/$projectId/settings/notifications — webhook / Discord alerts
const projectNotificationsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/settings/notifications",
  component: NotificationsPage,
});

// /projects/$projectId/settings/conflict-resolution — auto-resolve config (admin)
const projectConflictResolutionRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/settings/conflict-resolution",
  component: ConflictResolutionPage,
});

// /projects/$projectId/settings/integrator — integrator daemon config (admin)
const projectIntegratorRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/settings/integrator",
  component: IntegratorPage,
});

// /projects/$projectId/settings/categories — epic category palette
const projectCategoriesRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/settings/categories",
  component: CategoriesPage,
});

// /help — getting started and MCP setup
const helpRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/help",
  component: HelpPage,
});

// Build the route tree
const routeTree = rootRoute.addChildren([
  loginRoute,
  setupRoute,
  appLayoutRoute.addChildren([
    indexRoute,
    projectListRoute,
    projectRoute.addChildren([
      projectIndexRoute,
      projectProposalListRoute,
      projectNotesRoute,
      projectBoardRoute,
      projectEpicBoardRoute,
      projectTaskListRoute,
      projectEpicListRoute,
      projectRoadmapRoute,
      projectActivityRoute,
      projectClaimsRoute,
      projectMilestonesRoute,
      projectTrainRoute,
      projectTrainAuditRoute,
      projectAutomationRoute,
      projectNotificationsRoute,
      projectConflictResolutionRoute,
      projectIntegratorRoute,
      projectCategoriesRoute,
    ]),
    proposalDetailRoute,
    taskDetailRoute,
    epicDetailRoute,
    mergeRequestTimelineRoute,
    settingsUsersRoute,
    settingsBackupRoute,
    settingsTemplatesRoute,
    helpRoute,
  ]),
]);

// Create the router
export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

// Type-safe router declaration
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
