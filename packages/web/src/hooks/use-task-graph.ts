import { useQuery } from "@tanstack/react-query";
import { getTaskGraph } from "@/lib/api";

export const taskGraphKeys = {
  all: ["task-graph"] as const,
  detail: (projectId: string, epicId: string) => [...taskGraphKeys.all, projectId, epicId] as const,
};

export function useTaskGraph(projectId: string | undefined, epicId: string | undefined) {
  return useQuery({
    queryKey: taskGraphKeys.detail(projectId!, epicId!),
    queryFn: () => getTaskGraph(projectId!, epicId!),
    enabled: !!projectId && !!epicId,
  });
}
