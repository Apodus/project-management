import { useNavigate, useRouter } from "@tanstack/react-router";
import { Bell, LogOut, Moon, Search, Settings, Sun, User } from "lucide-react";
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
import { useThemeStore } from "@/stores/theme-store";
import { useProjectStore } from "@/stores/project-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useCurrentUser, useLogout } from "@/hooks/use-auth";

const KNOWN_SECTIONS: Record<string, string> = {
  projects: "Projects",
  proposals: "Proposals",
  tasks: "Tasks",
  epics: "Epics",
  board: "Board",
  activity: "Activity",
  milestones: "Milestones",
  settings: "Settings",
  users: "Users",
  templates: "Templates",
  automation: "Automation",
  backup: "Backup",
  help: "Help",
};

function isUlidOrId(segment: string): boolean {
  return segment.length >= 20 && /^[0-9A-HJ-NP-TV-Za-hj-np-tv-z]+$/.test(segment);
}

function Breadcrumbs() {
  const router = useRouter();
  const pathname = router.state.location.pathname;
  const { currentProjectName } = useProjectStore();

  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) {
    return <span className="text-sm text-muted-foreground">Home</span>;
  }

  const breadcrumbs: { label: string; isLast: boolean }[] = [];
  let prevSegment = "";

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;

    if (isUlidOrId(segment)) {
      if (prevSegment === "projects" && currentProjectName) {
        breadcrumbs.push({ label: currentProjectName, isLast });
      }
      // Skip IDs for proposals/tasks/epics — the detail page shows the title
    } else {
      breadcrumbs.push({
        label: KNOWN_SECTIONS[segment] ?? segment.charAt(0).toUpperCase() + segment.slice(1),
        isLast,
      });
    }
    prevSegment = segment;
  }

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
      {breadcrumbs.map((crumb, index) => (
        <span key={index} className="flex items-center gap-1.5">
          {index > 0 && (
            <span className="text-muted-foreground/50">/</span>
          )}
          <span
            className={
              crumb.isLast
                ? "font-medium text-foreground"
                : "text-muted-foreground"
            }
          >
            {crumb.label}
          </span>
        </span>
      ))}
    </nav>
  );
}

// ─── Connection status indicator ─────────────────────────────────

const STATUS_CONFIG = {
  connected: {
    color: "bg-emerald-500",
    pulse: false,
    tooltip: "Live — receiving real-time updates",
  },
  reconnecting: {
    color: "bg-amber-400",
    pulse: true,
    tooltip: "Reconnecting...",
  },
  disconnected: {
    color: "bg-red-500",
    pulse: false,
    tooltip: "Disconnected — updates paused. Click to retry.",
  },
  connecting: {
    color: "bg-muted-foreground/50",
    pulse: true,
    tooltip: "Connecting...",
  },
} as const;

function ConnectionIndicator() {
  const status = useConnectionStore((s) => s.status);
  const config = STATUS_CONFIG[status];

  const handleClick = () => {
    if (status === "disconnected") {
      // Force a page reload to re-establish SSE
      window.location.reload();
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          className={`relative inline-flex size-2 shrink-0 rounded-full ${config.color} ${
            status === "disconnected" ? "cursor-pointer" : "cursor-default"
          }`}
          aria-label={config.tooltip}
        >
          {config.pulse && (
            <span
              className={`absolute inset-0 rounded-full ${config.color} animate-ping opacity-75`}
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{config.tooltip}</TooltipContent>
    </Tooltip>
  );
}

// ─── Notification bell ───────────────────────────────────────────

function NotificationBell() {
  const unreadCount = useConnectionStore((s) => s.unreadCount);
  const clearUnread = useConnectionStore((s) => s.clearUnread);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const navigate = useNavigate();

  const handleClick = () => {
    clearUnread();
    if (currentProjectId) {
      navigate({
        to: "/projects/$projectId/activity",
        params: { projectId: currentProjectId },
      });
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleClick}
          className="relative"
          aria-label={
            unreadCount > 0
              ? `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`
              : "No new notifications"
          }
        >
          <Bell className="size-4 text-muted-foreground" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-semibold leading-none text-white">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {unreadCount > 0
          ? `${unreadCount} new update${unreadCount === 1 ? "" : "s"} — click to view activity`
          : "No new updates"}
      </TooltipContent>
    </Tooltip>
  );
}

// ─── Header ──────────────────────────────────────────────────────

export function Header({ onSearchClick }: { onSearchClick?: () => void }) {
  const { theme, toggleTheme } = useThemeStore();
  const { data: currentUser } = useCurrentUser();
  const logoutMutation = useLogout();

  const initials = currentUser?.displayName
    ? currentUser.displayName
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : null;

  return (
    <header className="flex h-14 shrink-0 items-center border-b border-border bg-background px-4">
      <Breadcrumbs />

      <div className="ml-auto flex items-center gap-1">
        <ConnectionIndicator />

        <Separator orientation="vertical" className="mx-1 h-6" />

        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-muted-foreground"
          onClick={() => onSearchClick?.()}
        >
          <Search className="size-4" />
          <span className="hidden text-xs sm:inline">
            Search...
          </span>
          <kbd className="pointer-events-none hidden h-5 select-none items-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground sm:inline-flex">
            <span className="text-xs">&#8984;</span>K
          </kbd>
        </Button>

        <NotificationBell />

        <Separator orientation="vertical" className="mx-1 h-6" />

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? (
            <Sun className="size-4" />
          ) : (
            <Moon className="size-4" />
          )}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              aria-label="User menu"
            >
              <div className="flex size-6 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                {initials ?? <User className="size-3.5" />}
              </div>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {currentUser && (
              <>
                <div className="px-2 py-1.5">
                  <p className="text-sm font-medium">
                    {currentUser.displayName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    @{currentUser.username}
                  </p>
                </div>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem disabled>
              <User className="mr-2 size-4" />
              Profile
            </DropdownMenuItem>
            <DropdownMenuItem disabled>
              <Settings className="mr-2 size-4" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
            >
              <LogOut className="mr-2 size-4" />
              {logoutMutation.isPending ? "Logging out..." : "Log out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
