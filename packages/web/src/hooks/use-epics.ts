import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  claimEpic,
  getEpics,
  getEpic,
  releaseEpic,
  updateEpic,
  type EpicFilters,
  type UpdateEpic,
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

export function useUpdateEpic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateEpic }) =>
      updateEpic(id, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: epicKeys.lists() });
      queryClient.invalidateQueries({
        queryKey: epicKeys.detail(variables.id),
      });
    },
  });
}

export function useClaimEpic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => claimEpic(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: epicKeys.lists() });
      queryClient.invalidateQueries({ queryKey: epicKeys.detail(id) });
    },
  });
}

export function useReleaseEpic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => releaseEpic(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: epicKeys.lists() });
      queryClient.invalidateQueries({ queryKey: epicKeys.detail(id) });
    },
  });
}
