import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getMilestones,
  createMilestone,
  updateMilestone,
  deleteMilestone,
  type CreateMilestone,
  type UpdateMilestone,
} from "@/lib/api";

export const milestoneKeys = {
  all: ["milestones"] as const,
  lists: () => [...milestoneKeys.all, "list"] as const,
  list: (projectId: string) =>
    [...milestoneKeys.lists(), { projectId }] as const,
};

export function useMilestones(projectId: string | undefined) {
  return useQuery({
    queryKey: milestoneKeys.list(projectId!),
    queryFn: () => getMilestones(projectId!),
    enabled: !!projectId,
  });
}

export function useCreateMilestone() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      data,
    }: {
      projectId: string;
      data: CreateMilestone;
    }) => createMilestone(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: milestoneKeys.lists() });
    },
  });
}

export function useUpdateMilestone() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateMilestone }) =>
      updateMilestone(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: milestoneKeys.lists() });
    },
  });
}

export function useDeleteMilestone() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteMilestone(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: milestoneKeys.lists() });
    },
  });
}
