import { Link, useMatches, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  FileText,
  Flag,
  FolderOpen,
  Kanban,
  LayoutDashboard,
  ListTodo,
  Milestone,
  HelpCircle,
  Settings,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useProjects } from "@/hooks/use-projects";
import { useProjectStore } from "@/stores/project-store";
import { useSidebarStore } from "@/stores/sidebar-store";

interface NavItem {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  matchPath: string;
  disabled?: boolean;
  exactMatch?: boolean;
}

function getNavItems(projectId: string | null): NavItem[] {
  const base = projectId ? `/projects/${projectId}` : "/projects";
  return [
    {
      label: "Dashboard",
      icon: LayoutDashboard,
      href: projectId ? base : "/projects",
      matchPath: "/projects/$projectId/",
      exactMatch: true,
    },
    {
      label: "Proposals",
      icon: FileText,
      href: projectId ? `${base}/proposals` : "/projects",
      matchPath: "/proposals",
    },
    {
      label: "Board",
      icon: Kanban,
      href: projectId ? `${base}/board` : "/projects",
      matchPath: "/board",
    },
    {
      label: "Tasks",
      icon: ListTodo,
      href: projectId ? `${base}/tasks` : "/projects",
      matchPath: "/tasks",
    },
    {
      label: "Epics",
      icon: Milestone,
      href: projectId ? `${base}/epics` : "/projects",
      matchPath: "/epics",
    },
    {
      label: "Milestones",
      icon: Flag,
      href: projectId ? `${base}/milestones` : "/projects",
      matchPath: "/milestones",
    },
    {
      label: "Activity",
      icon: Activity,
      href: projectId ? `${base}/activity` : "/projects",
      matchPath: "/activity",
    },
  ];
}

function NavLink({
  item,
  collapsed,
}: {
  item: NavItem;
  collapsed: boolean;
}) {
  const matches = useMatches();
  const currentPath = matches[matches.length - 1]?.fullPath ?? "";
  const isActive = item.exactMatch
    ? currentPath === item.matchPath
    : currentPath.includes(item.matchPath);

  const content = (
    <Link
      to={item.href}
      disabled={item.disabled}
      className={cn(
        "group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
        item.disabled && "pointer-events-none opacity-40",
        collapsed && "justify-center px-2",
      )}
    >
      <item.icon className="size-4 shrink-0" />
      {!collapsed && <span>{item.label}</span>}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {item.label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return content;
}

export function Sidebar() {
  const { collapsed, toggle } = useSidebarStore();
  const { currentProjectName, currentProjectId, setCurrentProject } = useProjectStore();
  const navItems = getNavItems(currentProjectId);
  const { data: projects } = useProjects();
  const navigate = useNavigate();

  function handleProjectSelect(projectId: string, projectName: string) {
    setCurrentProject(projectId, projectName);
    navigate({ to: "/projects/$projectId", params: { projectId } });
  }

  function handleViewAllProjects() {
    navigate({ to: "/projects" });
  }

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200",
        collapsed ? "w-14" : "w-60",
      )}
    >
      {/* Workspace name */}
      <div
        className={cn(
          "flex h-14 shrink-0 items-center border-b border-sidebar-border px-3",
          collapsed ? "justify-center" : "gap-2",
        )}
      >
        {!collapsed && (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-xs font-bold text-sidebar-primary-foreground">
              PM
            </div>
            <span className="truncate text-sm font-semibold text-sidebar-foreground">
              Project Mgmt
            </span>
          </div>
        )}
        {collapsed && (
          <div className="flex size-7 items-center justify-center rounded-md bg-sidebar-primary text-xs font-bold text-sidebar-primary-foreground">
            PM
          </div>
        )}
      </div>

      {/* Project switcher */}
      <div className={cn("px-3 py-3", collapsed && "px-2")}>
        {!collapsed ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="w-full justify-between text-sm"
                size="sm"
              >
                <span className="truncate">
                  {currentProjectName ?? "Select project"}
                </span>
                <ChevronDown className="size-3.5 shrink-0 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-[var(--radix-dropdown-menu-trigger-width)]"
            >
              {projects && projects.length > 0 ? (
                <>
                  {projects.map((project) => (
                    <DropdownMenuItem
                      key={project.id}
                      onClick={() =>
                        handleProjectSelect(project.id, project.name)
                      }
                      className={cn(
                        currentProjectId === project.id &&
                          "bg-accent font-medium",
                      )}
                    >
                      <span className="truncate">{project.name}</span>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleViewAllProjects}>
                    <FolderOpen className="mr-2 size-3.5" />
                    All Projects
                  </DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem onClick={handleViewAllProjects}>
                  <FolderOpen className="mr-2 size-3.5" />
                  View Projects
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="w-full">
                <ChevronDown className="size-3.5 opacity-50" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {currentProjectName ?? "Select project"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <Separator className="mb-2" />

      {/* Navigation */}
      <nav className={cn("flex-1 space-y-1 px-3", collapsed && "px-2")}>
        {navItems.map((item) => (
          <NavLink key={item.label} item={item} collapsed={collapsed} />
        ))}
      </nav>

      <Separator className="mt-2" />

      {/* Settings + collapse toggle */}
      <div
        className={cn(
          "space-y-1 px-3 py-3",
          collapsed && "px-2",
        )}
      >
        {currentProjectId && (
          <NavLink
            item={{
              label: "Automation",
              icon: Zap,
              href: `/projects/${currentProjectId}/settings/automation`,
              matchPath: "/settings/automation",
            }}
            collapsed={collapsed}
          />
        )}

        <NavLink
          item={{
            label: "Settings",
            icon: Settings,
            href: "/settings/users",
            matchPath: "/settings",
          }}
          collapsed={collapsed}
        />

        <NavLink
          item={{
            label: "Help",
            icon: HelpCircle,
            href: "/help",
            matchPath: "/help",
          }}
          collapsed={collapsed}
        />

        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <button
              onClick={toggle}
              className={cn(
                "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                collapsed && "justify-center px-2",
              )}
            >
              {collapsed ? (
                <ChevronsRight className="size-4" />
              ) : (
                <>
                  <ChevronsLeft className="size-4" />
                  <span>Collapse</span>
                </>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            {collapsed ? "Expand sidebar" : "Collapse sidebar"}
          </TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
