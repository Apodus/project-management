import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
} from "@tanstack/react-router";
import { AppLayout } from "@/components/layout/app-layout";
import { EpicListPage } from "@/pages/epic-list-page";
import { ProjectListPage } from "@/pages/project-list-page";
import { ProposalDetailPage } from "@/pages/proposal-detail-page";
import { ProposalListPage } from "@/pages/proposal-list-page";
import { TaskDetailPage } from "@/pages/task-detail-page";
import { TaskListPage } from "@/pages/task-list-page";

// Root layout route — wraps everything in the app shell
const rootRoute = createRootRoute({
  component: AppLayout,
});

// / — redirect to /projects
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <Navigate to="/projects" />,
});

// /projects — project list
const projectListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: ProjectListPage,
});

// /projects/$projectId — project layout (renders child routes)
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
});

// /projects/$projectId/ — redirect to proposals
const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  component: () => {
    const { projectId } = projectIndexRoute.useParams();
    return <Navigate to="/projects/$projectId/proposals" params={{ projectId }} />;
  },
});

// /projects/$projectId/proposals — proposal list
const projectProposalListRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/proposals",
  component: ProposalListPage,
});

// /projects/$projectId/tasks — task list
const projectTaskListRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/tasks",
  component: TaskListPage,
});

// /projects/$projectId/epics — epic list
const projectEpicListRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/epics",
  component: EpicListPage,
});

// /proposals/$proposalId — proposal detail
const proposalDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/proposals/$proposalId",
  component: ProposalDetailPage,
});

// /tasks/$taskId — task detail
const taskDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/$taskId",
  component: TaskDetailPage,
});

// Build the route tree
const routeTree = rootRoute.addChildren([
  indexRoute,
  projectListRoute,
  projectRoute.addChildren([
    projectIndexRoute,
    projectProposalListRoute,
    projectTaskListRoute,
    projectEpicListRoute,
  ]),
  proposalDetailRoute,
  taskDetailRoute,
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
