import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  FileText,
  FolderOpen,
  LayoutDashboard,
  ListTodo,
  Milestone,
  Plus,
  Settings,
  Clock,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { formatStatus, getStatusColor, getPriorityColor } from "@/lib/format";
import { useProjectStore } from "@/stores/project-store";
import { getTasks, getProposals } from "@/lib/api";
import type { Task, Proposal } from "@/lib/api";

// ---- Recent items storage ----

interface RecentItem {
  id: string;
  title: string;
  type: "task" | "proposal";
  status: string;
  priority?: string;
  visitedAt: number;
}

const RECENT_STORAGE_KEY = "pm-command-palette-recent";
const MAX_RECENT = 5;

function getRecentItems(): RecentItem[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as RecentItem[];
  } catch {
    return [];
  }
}

function addRecentItem(item: Omit<RecentItem, "visitedAt">) {
  const items = getRecentItems().filter((i) => i.id !== item.id);
  items.unshift({ ...item, visitedAt: Date.now() });
  localStorage.setItem(
    RECENT_STORAGE_KEY,
    JSON.stringify(items.slice(0, MAX_RECENT)),
  );
}

// ---- Navigation items ----

interface NavItem {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  path: string;
  keywords: string[];
}

function getNavItems(projectId: string | null): NavItem[] {
  const base = projectId ? `/projects/${projectId}` : null;
  return [
    {
      label: "Dashboard",
      icon: LayoutDashboard,
      path: base ? base : "/projects",
      keywords: ["home", "overview", "dashboard"],
    },
    {
      label: "Tasks",
      icon: ListTodo,
      path: base ? `${base}/tasks` : "/projects",
      keywords: ["tasks", "todo", "list", "work"],
    },
    {
      label: "Proposals",
      icon: FileText,
      path: base ? `${base}/proposals` : "/projects",
      keywords: ["proposals", "ideas", "suggestions"],
    },
    {
      label: "Epics",
      icon: Milestone,
      path: base ? `${base}/epics` : "/projects",
      keywords: ["epics", "milestones", "groups"],
    },
    {
      label: "Activity",
      icon: Activity,
      path: base ? `${base}/activity` : "/projects",
      keywords: ["activity", "feed", "log", "history"],
    },
    {
      label: "Projects",
      icon: FolderOpen,
      path: "/projects",
      keywords: ["projects", "all projects", "switch"],
    },
    {
      label: "Settings",
      icon: Settings,
      path: "/settings/users",
      keywords: ["settings", "users", "admin", "configuration"],
    },
  ];
}

// ---- Debounce hook ----

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

// ---- Command Palette ----

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, 300);

  const [searchResults, setSearchResults] = useState<{
    tasks: Task[];
    proposals: Proposal[];
  }>({ tasks: [], proposals: [] });
  const [isSearching, setIsSearching] = useState(false);

  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);

  const navItems = useMemo(
    () => getNavItems(currentProjectId),
    [currentProjectId],
  );

  // Load recent items when palette opens
  useEffect(() => {
    if (open) {
      setRecentItems(getRecentItems());
      setQuery("");
      setSearchResults({ tasks: [], proposals: [] });
    }
  }, [open]);

  // Search when debounced query changes
  useEffect(() => {
    if (!debouncedQuery.trim() || !currentProjectId) {
      setSearchResults({ tasks: [], proposals: [] });
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);

    async function doSearch() {
      try {
        const [taskResult, proposalResult] = await Promise.allSettled([
          getTasks(currentProjectId!, {
            search: debouncedQuery,
            perPage: 8,
          }),
          getProposals(currentProjectId!, undefined),
        ]);

        if (cancelled) return;

        const tasks =
          taskResult.status === "fulfilled" ? taskResult.value.data : [];

        // Client-side filter proposals by query since the API may not support search
        const allProposals =
          proposalResult.status === "fulfilled" ? proposalResult.value : [];
        const lowerQuery = debouncedQuery.toLowerCase();
        const proposals = allProposals
          .filter(
            (p) =>
              p.title.toLowerCase().includes(lowerQuery) ||
              (p.description && p.description.toLowerCase().includes(lowerQuery)),
          )
          .slice(0, 8);

        setSearchResults({ tasks, proposals });
      } catch {
        // Silently fail search
        if (!cancelled) {
          setSearchResults({ tasks: [], proposals: [] });
        }
      } finally {
        if (!cancelled) {
          setIsSearching(false);
        }
      }
    }

    doSearch();
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, currentProjectId]);

  const close = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  // ---- Handlers ----

  function handleSelectTask(task: Task) {
    addRecentItem({
      id: task.id,
      title: task.title,
      type: "task",
      status: task.status,
      priority: task.priority,
    });
    close();
    navigate({ to: "/tasks/$taskId", params: { taskId: task.id } });
  }

  function handleSelectProposal(proposal: Proposal) {
    addRecentItem({
      id: proposal.id,
      title: proposal.title,
      type: "proposal",
      status: proposal.status,
    });
    close();
    navigate({
      to: "/proposals/$proposalId",
      params: { proposalId: proposal.id },
    });
  }

  function handleSelectNav(item: NavItem) {
    close();
    navigate({ to: item.path });
  }

  function handleSelectRecent(item: RecentItem) {
    // Update visit timestamp
    addRecentItem(item);
    close();
    if (item.type === "task") {
      navigate({ to: "/tasks/$taskId", params: { taskId: item.id } });
    } else {
      navigate({
        to: "/proposals/$proposalId",
        params: { proposalId: item.id },
      });
    }
  }

  function handleCreateProposal() {
    close();
    if (currentProjectId) {
      navigate({
        to: "/projects/$projectId/proposals",
        params: { projectId: currentProjectId },
      });
    } else {
      navigate({ to: "/projects" });
    }
  }

  function handleCreateProject() {
    close();
    navigate({ to: "/projects" });
  }

  const hasQuery = debouncedQuery.trim().length > 0;
  const hasResults =
    searchResults.tasks.length > 0 || searchResults.proposals.length > 0;

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder="Search tasks, proposals, or type a command..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {hasQuery && !isSearching && !hasResults && (
          <CommandEmpty>No results found.</CommandEmpty>
        )}
        {isSearching && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Searching...
          </div>
        )}

        {/* When query is empty: show recent + navigation */}
        {!hasQuery && (
          <>
            {recentItems.length > 0 && (
              <CommandGroup heading="Recent">
                {recentItems.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={`recent-${item.id}-${item.title}`}
                    onSelect={() => handleSelectRecent(item)}
                  >
                    <Clock className="size-4 text-muted-foreground" />
                    <span className="flex-1 truncate">{item.title}</span>
                    <Badge
                      variant="secondary"
                      className={cn("text-[10px]", getStatusColor(item.status))}
                    >
                      {formatStatus(item.status)}
                    </Badge>
                    {item.priority && (
                      <Badge
                        variant="secondary"
                        className={cn(
                          "text-[10px]",
                          getPriorityColor(item.priority),
                        )}
                      >
                        {formatStatus(item.priority)}
                      </Badge>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            <CommandGroup heading="Navigation">
              {navItems.map((item) => (
                <CommandItem
                  key={item.label}
                  value={`nav-${item.label}`}
                  onSelect={() => handleSelectNav(item)}
                  keywords={item.keywords}
                >
                  <item.icon className="size-4 text-muted-foreground" />
                  <span>{item.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {/* When typing: show search results */}
        {hasQuery && !isSearching && (
          <>
            {searchResults.tasks.length > 0 && (
              <CommandGroup heading="Tasks">
                {searchResults.tasks.map((task) => (
                  <CommandItem
                    key={task.id}
                    value={`task-${task.id}-${task.title}`}
                    onSelect={() => handleSelectTask(task)}
                  >
                    <ListTodo className="size-4 text-muted-foreground" />
                    <span className="flex-1 truncate">{task.title}</span>
                    <Badge
                      variant="secondary"
                      className={cn(
                        "text-[10px]",
                        getStatusColor(task.status),
                      )}
                    >
                      {formatStatus(task.status)}
                    </Badge>
                    <Badge
                      variant="secondary"
                      className={cn(
                        "text-[10px]",
                        getPriorityColor(task.priority),
                      )}
                    >
                      {formatStatus(task.priority)}
                    </Badge>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {searchResults.proposals.length > 0 && (
              <CommandGroup heading="Proposals">
                {searchResults.proposals.map((proposal) => (
                  <CommandItem
                    key={proposal.id}
                    value={`proposal-${proposal.id}-${proposal.title}`}
                    onSelect={() => handleSelectProposal(proposal)}
                  >
                    <FileText className="size-4 text-muted-foreground" />
                    <span className="flex-1 truncate">{proposal.title}</span>
                    <Badge
                      variant="secondary"
                      className={cn(
                        "text-[10px]",
                        getStatusColor(proposal.status),
                      )}
                    >
                      {formatStatus(proposal.status)}
                    </Badge>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Filtered navigation items while typing */}
            <CommandGroup heading="Navigation">
              {navItems.map((item) => (
                <CommandItem
                  key={item.label}
                  value={`nav-${item.label}`}
                  onSelect={() => handleSelectNav(item)}
                  keywords={item.keywords}
                >
                  <item.icon className="size-4 text-muted-foreground" />
                  <span>{item.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />

        {/* Quick actions — always shown */}
        <CommandGroup heading="Quick Actions">
          <CommandItem
            value="action-create-proposal"
            onSelect={handleCreateProposal}
          >
            <Plus className="size-4 text-muted-foreground" />
            <span>Create Proposal</span>
            <Zap className="ml-auto size-3 text-muted-foreground/50" />
          </CommandItem>
          <CommandItem
            value="action-create-project"
            onSelect={handleCreateProject}
          >
            <Plus className="size-4 text-muted-foreground" />
            <span>Create Project</span>
            <Zap className="ml-auto size-3 text-muted-foreground/50" />
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

// ---- Global keyboard listener hook ----

export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return { open, setOpen };
}
