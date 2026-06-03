import { useEffect } from "react";
import { useParams } from "@tanstack/react-router";
import { Network } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useProject } from "@/hooks/use-projects";
import { useProjectStore } from "@/stores/project-store";
import { EpicRoadmapCanvas } from "@/components/epic-roadmap-canvas";

export function EpicTimelinePage() {
  const { projectId } = useParams({ strict: false });
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  const { data: project } = useProject(projectId);
  useEffect(() => {
    if (project) {
      setCurrentProject(project.id, project.name);
    }
  }, [project, setCurrentProject]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <Network className="text-muted-foreground size-6" />
        <h1 className="text-2xl font-bold tracking-tight">Roadmap</h1>
        {project && (
          <Badge variant="outline" className="text-xs font-normal">
            {project.name}
          </Badge>
        )}
      </div>

      <EpicRoadmapCanvas projectId={projectId} variant="full" />
    </div>
  );
}
