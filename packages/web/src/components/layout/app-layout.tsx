import { Outlet } from "@tanstack/react-router";
import { Header } from "./header";
import { Sidebar } from "./sidebar";
import {
  CommandPalette,
  useCommandPalette,
} from "@/components/command-palette";
import {
  KeyboardShortcutsDialog,
  useKeyboardShortcuts,
} from "@/components/keyboard-shortcuts-dialog";
import { useSSE } from "@/hooks/use-sse";
import { useFaviconBadge } from "@/hooks/use-favicon-badge";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useProjectStore } from "@/stores/project-store";

export function AppLayout() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const { open: commandPaletteOpen, setOpen: setCommandPaletteOpen } =
    useCommandPalette();
  const { open: shortcutsOpen, setOpen: setShortcutsOpen } =
    useKeyboardShortcuts();

  // Establish SSE connection for real-time updates, scoped to current project
  useSSE(currentProjectId);

  // Favicon badge + document title reflect unread event count
  useFaviconBadge();
  useDocumentTitle();

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onSearchClick={() => setCommandPaletteOpen(true)} />
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
      />
      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
      />
    </div>
  );
}
