import { useQuery } from "@tanstack/react-query";
import {
  getEpics,
  getEpic,
  type EpicFilters,
} from "@/lib/api";

export const epicKeys = {
  all: ["epics"] as const,
  lists: () => [...epicKeys.all, "list"] as const,
  list: (projectId: string, filters?: EpicFilters) =>
    [...epicKeys.lists(), { projectId, ...filters }] as const,
  details: () => [...epicKeys.all, "detail"] as const,
  detail: (id: string) => [...epicKeys.details(), id] as const,
};

export function useEpics(projectId: string | undefined, filters?: EpicFilters) {
  return useQuery({
    queryKey: epicKeys.list(projectId!, filters),
    queryFn: () => getEpics(projectId!, filters),
    enabled: !!projectId,
  });
}

export function useEpic(id: string | undefined) {
  return useQuery({
    queryKey: epicKeys.detail(id!),
    queryFn: () => getEpic(id!),
    enabled: !!id,
  });
}
