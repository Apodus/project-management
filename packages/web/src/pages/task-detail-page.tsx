import { useParams } from "@tanstack/react-router";
import { ListTodo } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function TaskDetailPage() {
  const { taskId } = useParams({ strict: false });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <ListTodo className="size-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">Task Detail</h1>
      </div>
      {taskId && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Task ID:</span>
          <Badge variant="secondary">
            <code className="font-mono text-xs">{taskId}</code>
          </Badge>
        </div>
      )}
      <p className="text-muted-foreground">
        Task detail view will be implemented in Step 11 (data fetching).
      </p>
    </div>
  );
}
