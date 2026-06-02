import { useQuery } from "@tanstack/react-query";
import { getEpicGraph } from "@/lib/api";

export const epicGraphKeys = {
  all: ["epic-graph"] as const,
  detail: (projectId: string) => [...epicGraphKeys.all, projectId] as const,
};

export function useEpicGraph(projectId: string | undefined) {
  return useQuery({
    queryKey: epicGraphKeys.detail(projectId!),
    queryFn: () => getEpicGraph(projectId!),
    enabled: !!projectId,
  });
}
