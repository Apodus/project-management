import { FolderOpen } from "lucide-react";

export function ProjectListPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <FolderOpen className="size-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
      </div>
      <p className="text-muted-foreground">
        Project listing will be implemented in Step 11 (data fetching).
      </p>
    </div>
  );
}
