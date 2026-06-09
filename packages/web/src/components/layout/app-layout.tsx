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
import { useClaimsHealth } from "@/hooks/use-train";
import { useNotesHealth } from "@/hooks/use-notes";
import { useFaviconBadge } from "@/hooks/use-favicon-badge";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useCurrentUser } from "@/hooks/use-auth";
import { useProjectStore } from "@/stores/project-store";

export function AppLayout() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const { data: currentUser } = useCurrentUser();
  const { open: commandPaletteOpen, setOpen: setCommandPaletteOpen } =
    useCommandPalette();
  const { open: shortcutsOpen, setOpen: setShortcutsOpen } =
    useKeyboardShortcuts();

  // Establish SSE connection for real-time updates, scoped to current project
  useSSE(currentProjectId, currentUser?.id);

  // Poll stale-claim health (Campaign C3 §P5a) from the always-open layout: the
  // read is the detection trigger — it fires the edge-triggered claim.stale_alert
  // (SSE banner + Discord) once per stale episode. Guarded on a current project.
  useClaimsHealth(currentProjectId ?? undefined);

  // Poll notes-backlog health (Campaign C3) from the always-open layout: the
  // read is the detection trigger — it fires the edge-triggered note.backlog_alert
  // (SSE toast + Discord) once per backlog episode. Guarded on a current project.
  useNotesHealth(currentProjectId ?? undefined);

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
