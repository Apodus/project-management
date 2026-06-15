import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  FileText,
  FolderOpen,
  Inbox,
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
import { search } from "@/lib/api";
import type { SearchResult } from "@/lib/api";

// ---- Recent items storage ----

// C4 (server FTS): search hits carry no status/priority, so NEW recents are
// stored WITHOUT badges (`status` is now optional) — a deliberate shape
// decision; previously-stored recents still render their badges. `projectId`
// is stored for note recents (the notes route is project-scoped).
interface RecentItem {
  id: string;
  title: string;
  type: "task" | "proposal" | "note";
  status?: string;
  priority?: string;
  projectId?: string;
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
  localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(items.slice(0, MAX_RECENT)));
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
    tasks: SearchResult[];
    proposals: SearchResult[];
    notes: SearchResult[];
  }>({ tasks: [], proposals: [], notes: [] });
  const [isSearching, setIsSearching] = useState(false);

  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);

  const navItems = useMemo(() => getNavItems(currentProjectId), [currentProjectId]);

  // Load recent items when palette opens
  useEffect(() => {
    if (open) {
      setRecentItems(getRecentItems());
      setQuery("");
      setSearchResults({ tasks: [], proposals: [], notes: [] });
    }
  }, [open]);

  // Search when debounced query changes — ONE server FTS call (C4), grouped
  // by entityType in rank order. Comment hits are dropped: a comment is
  // inline on its parent entity, so there is no navigation target for it.
  useEffect(() => {
    if (!debouncedQuery.trim() || !currentProjectId) {
      setSearchResults({ tasks: [], proposals: [], notes: [] });
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);

    async function doSearch() {
      try {
        const hits = await search(debouncedQuery, {
          projectId: currentProjectId!,
          limit: 24,
        });

        if (cancelled) return;

        // Hits arrive rank-ordered (best first); filter preserves that order.
        setSearchResults({
          tasks: hits.filter((h) => h.entityType === "task").slice(0, 8),
          proposals: hits.filter((h) => h.entityType === "proposal").slice(0, 8),
          notes: hits.filter((h) => h.entityType === "note").slice(0, 8),
        });
      } catch {
        // Silently fail search
        if (!cancelled) {
          setSearchResults({ tasks: [], proposals: [], notes: [] });
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

  function handleSelectHit(hit: SearchResult) {
    addRecentItem({
      id: hit.entityId,
      title: hit.title,
      type: hit.entityType as "task" | "proposal" | "note",
      ...(hit.entityType === "note"
        ? { projectId: hit.projectId ?? currentProjectId ?? undefined }
        : {}),
    });
    close();
    if (hit.entityType === "task") {
      navigate({ to: "/tasks/$taskId", params: { taskId: hit.entityId } });
    } else if (hit.entityType === "proposal") {
      navigate({
        to: "/proposals/$proposalId",
        params: { proposalId: hit.entityId },
      });
    } else if (hit.entityType === "note") {
      // Notes have no detail page — land on the project inbox pre-seeded
      // with the hit's title as the free-text query.
      const pid = hit.projectId ?? currentProjectId;
      if (pid) {
        navigate({
          to: "/projects/$projectId/notes",
          params: { projectId: pid },
          search: { q: hit.title },
        });
      }
    }
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
    } else if (item.type === "note") {
      const pid = item.projectId ?? currentProjectId;
      if (pid) {
        navigate({
          to: "/projects/$projectId/notes",
          params: { projectId: pid },
          search: { q: item.title },
        });
      } else {
        navigate({ to: "/projects" });
      }
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
    searchResults.tasks.length > 0 ||
    searchResults.proposals.length > 0 ||
    searchResults.notes.length > 0;

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder="Search tasks, proposals, or type a command..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {hasQuery && !isSearching && !hasResults && <CommandEmpty>No results found.</CommandEmpty>}
        {isSearching && (
          <div className="text-muted-foreground py-6 text-center text-sm">Searching...</div>
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
                    <Clock className="text-muted-foreground size-4" />
                    <span className="flex-1 truncate">{item.title}</span>
                    {item.status && (
                      <Badge
                        variant="secondary"
                        className={cn("text-[10px]", getStatusColor(item.status))}
                      >
                        {formatStatus(item.status)}
                      </Badge>
                    )}
                    {item.priority && (
                      <Badge
                        variant="secondary"
                        className={cn("text-[10px]", getPriorityColor(item.priority))}
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
                  <item.icon className="text-muted-foreground size-4" />
                  <span>{item.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {/* When typing: show search results */}
        {hasQuery && !isSearching && (
          <>
            {/* Server FTS hits (C4), grouped by entity type in rank order.
                keywords={[debouncedQuery]} guarantees a server-matched hit
                passes cmdk's own value filter even when the match was on
                body/description rather than the title. */}
            {searchResults.tasks.length > 0 && (
              <CommandGroup heading="Tasks">
                {searchResults.tasks.map((hit) => (
                  <CommandItem
                    key={hit.entityId}
                    value={`task-${hit.entityId}-${hit.title}`}
                    keywords={[debouncedQuery]}
                    onSelect={() => handleSelectHit(hit)}
                  >
                    <ListTodo className="text-muted-foreground size-4" />
                    <span className="flex-1 truncate">{hit.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {searchResults.proposals.length > 0 && (
              <CommandGroup heading="Proposals">
                {searchResults.proposals.map((hit) => (
                  <CommandItem
                    key={hit.entityId}
                    value={`proposal-${hit.entityId}-${hit.title}`}
                    keywords={[debouncedQuery]}
                    onSelect={() => handleSelectHit(hit)}
                  >
                    <FileText className="text-muted-foreground size-4" />
                    <span className="flex-1 truncate">{hit.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {searchResults.notes.length > 0 && (
              <CommandGroup heading="Notes">
                {searchResults.notes.map((hit) => (
                  <CommandItem
                    key={hit.entityId}
                    value={`note-${hit.entityId}-${hit.title}`}
                    keywords={[debouncedQuery]}
                    onSelect={() => handleSelectHit(hit)}
                  >
                    <Inbox className="text-muted-foreground size-4" />
                    <span className="flex-1 truncate">{hit.title}</span>
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
                  <item.icon className="text-muted-foreground size-4" />
                  <span>{item.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />

        {/* Quick actions — always shown */}
        <CommandGroup heading="Quick Actions">
          <CommandItem value="action-create-proposal" onSelect={handleCreateProposal}>
            <Plus className="text-muted-foreground size-4" />
            <span>Create Proposal</span>
            <Zap className="text-muted-foreground/50 ml-auto size-3" />
          </CommandItem>
          <CommandItem value="action-create-project" onSelect={handleCreateProject}>
            <Plus className="text-muted-foreground size-4" />
            <span>Create Project</span>
            <Zap className="text-muted-foreground/50 ml-auto size-3" />
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
