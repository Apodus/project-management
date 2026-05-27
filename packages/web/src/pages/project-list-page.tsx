import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FolderOpen, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useProjects, useCreateProject } from "@/hooks/use-projects";
import { useProjectStore } from "@/stores/project-store";
import { formatRelativeTime, formatStatus, getStatusColor } from "@/lib/format";
import { cn } from "@/lib/utils";

export function ProjectListPage() {
  const navigate = useNavigate();
  const { data: projects, isLoading, error, refetch } = useProjects();
  const createProject = useCreateProject();
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  function handleProjectClick(project: { id: string; name: string }) {
    setCurrentProject(project.id, project.name);
    navigate({ to: "/projects/$projectId/proposals", params: { projectId: project.id } });
  }

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    try {
      const project = await createProject.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
      });
      setDialogOpen(false);
      setName("");
      setDescription("");
      handleProjectClick(project);
    } catch {
      // Error is handled by TanStack Query
    }
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FolderOpen className="size-6 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
        </div>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="size-4" />
              New Project
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={handleCreateProject}>
              <DialogHeader>
                <DialogTitle>Create Project</DialogTitle>
                <DialogDescription>
                  Create a new project to organize proposals and tasks.
                </DialogDescription>
              </DialogHeader>
              <div className="mt-4 space-y-4">
                <div className="space-y-2">
                  <label
                    htmlFor="project-name"
                    className="text-sm font-medium leading-none"
                  >
                    Name
                  </label>
                  <Input
                    id="project-name"
                    placeholder="My Project"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoFocus
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor="project-description"
                    className="text-sm font-medium leading-none"
                  >
                    Description
                  </label>
                  <Textarea
                    id="project-description"
                    placeholder="What is this project about?"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                  />
                </div>
              </div>
              <DialogFooter className="mt-6">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!name.trim() || createProject.isPending}
                >
                  {createProject.isPending ? "Creating..." : "Create Project"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Error state */}
      {error && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <p className="text-sm text-destructive">
              Failed to load projects. Please try again.
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Loading skeleton */}
      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="gap-4 py-4">
              <CardHeader className="pb-0">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="mt-2 h-4 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && projects?.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16">
          <FolderOpen className="mb-4 size-12 text-muted-foreground/50" />
          <h3 className="text-lg font-medium">No projects yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Create your first project to get started.
          </p>
          <Button
            className="mt-4"
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="size-4" />
            Create Project
          </Button>
        </div>
      )}

      {/* Project grid */}
      {!isLoading && !error && projects && projects.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Card
              key={project.id}
              className="cursor-pointer gap-3 py-4 transition-shadow hover:shadow-md"
              onClick={() => handleProjectClick(project)}
            >
              <CardHeader className="pb-0">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{project.name}</CardTitle>
                  <Badge
                    variant="secondary"
                    className={cn("shrink-0 text-[11px]", getStatusColor(project.status))}
                  >
                    {formatStatus(project.status)}
                  </Badge>
                </div>
                {project.slug && (
                  <CardDescription className="font-mono text-xs">
                    {project.slug}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent>
                {project.description ? (
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {project.description}
                  </p>
                ) : (
                  <p className="text-sm italic text-muted-foreground/50">
                    No description
                  </p>
                )}
                <p className="mt-3 text-xs text-muted-foreground/70">
                  Created {formatRelativeTime(project.createdAt)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
