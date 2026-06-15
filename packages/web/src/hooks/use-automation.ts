import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAutomationRules,
  createAutomationRule,
  updateAutomationRule,
  deleteAutomationRule,
  toggleAutomationRule,
  type CreateAutomationRuleData,
  type UpdateAutomationRuleData,
} from "@/lib/api";

export const automationKeys = {
  all: ["automation-rules"] as const,
  lists: () => [...automationKeys.all, "list"] as const,
  list: (projectId: string) => [...automationKeys.lists(), { projectId }] as const,
};

export function useAutomationRules(projectId: string | undefined) {
  return useQuery({
    queryKey: automationKeys.list(projectId!),
    queryFn: () => getAutomationRules(projectId!),
    enabled: !!projectId,
  });
}

export function useCreateAutomationRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, data }: { projectId: string; data: CreateAutomationRuleData }) =>
      createAutomationRule(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: automationKeys.lists() });
    },
  });
}

export function useUpdateAutomationRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateAutomationRuleData }) =>
      updateAutomationRule(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: automationKeys.lists() });
    },
  });
}

export function useDeleteAutomationRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAutomationRule(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: automationKeys.lists() });
    },
  });
}

export function useToggleAutomationRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      toggleAutomationRule(id, active),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: automationKeys.lists() });
    },
  });
}
