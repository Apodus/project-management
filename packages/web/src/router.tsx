import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppLayout } from "@/components/layout/app-layout";
import { ActivityPage } from "@/pages/activity-page";
import { DashboardPage } from "@/pages/dashboard-page";
import { EpicDetailPage } from "@/pages/epic-detail-page";
import { EpicListPage } from "@/pages/epic-list-page";
import { LoginPage } from "@/pages/login-page";
import { MilestonesPage } from "@/pages/milestones-page";
import { ProjectListPage } from "@/pages/project-list-page";
import { ProposalDetailPage } from "@/pages/proposal-detail-page";
import { ProposalListPage } from "@/pages/proposal-list-page";
import { SetupPage } from "@/pages/setup-page";
import { TaskDetailPage } from "@/pages/task-detail-page";
import { TaskListPage } from "@/pages/task-list-page";
import { BoardPage } from "@/pages/board-page";
import { UsersPage } from "@/pages/settings/users-page";
import { ApiError, getCurrentUser, getSetupStatus } from "@/lib/api";

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

// /projects/$projectId/board — kanban board
const projectBoardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/board",
  component: BoardPage,
});

// /projects/$projectId/epics — epic list
const projectEpicListRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/epics",
  component: EpicListPage,
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

// /settings/users — user management
const settingsUsersRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/settings/users",
  component: UsersPage,
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
      projectBoardRoute,
      projectTaskListRoute,
      projectEpicListRoute,
      projectActivityRoute,
      projectMilestonesRoute,
    ]),
    proposalDetailRoute,
    taskDetailRoute,
    epicDetailRoute,
    settingsUsersRoute,
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
