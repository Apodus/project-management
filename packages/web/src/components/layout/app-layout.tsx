import { Outlet } from "@tanstack/react-router";
import { Header } from "./header";
import { Sidebar } from "./sidebar";
import { useSSE } from "@/hooks/use-sse";
import { useProjectStore } from "@/stores/project-store";

export function AppLayout() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  // Establish SSE connection for real-time updates, scoped to current project
  useSSE(currentProjectId);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
