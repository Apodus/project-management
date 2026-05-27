import { useParams } from "@tanstack/react-router";
import { ListTodo } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function TaskListPage() {
  const { projectId } = useParams({ strict: false });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <ListTodo className="size-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">Tasks</h1>
      </div>
      {projectId && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Project:</span>
          <Badge variant="secondary">
            <code className="font-mono text-xs">{projectId}</code>
          </Badge>
        </div>
      )}
      <p className="text-muted-foreground">
        Task listing will be implemented in Step 11 (data fetching).
      </p>
    </div>
  );
}
