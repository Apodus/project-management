import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  instantiateTemplate,
  createTemplateFromTask,
  type CreateTemplateData,
  type UpdateTemplateData,
  type InstantiateTemplateData,
  type CreateTemplateFromTaskData,
} from "@/lib/api";

export const templateKeys = {
  all: ["templates"] as const,
  lists: () => [...templateKeys.all, "list"] as const,
  list: (projectId?: string, type?: string) =>
    [...templateKeys.lists(), { projectId, type }] as const,
};

export function useTemplates(projectId?: string, type?: string) {
  return useQuery({
    queryKey: templateKeys.list(projectId, type),
    queryFn: () => getTemplates(projectId, type),
  });
}

export function useCreateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTemplateData) => createTemplate(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: templateKeys.lists() });
    },
  });
}

export function useUpdateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateTemplateData }) =>
      updateTemplate(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: templateKeys.lists() });
    },
  });
}

export function useDeleteTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTemplate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: templateKeys.lists() });
    },
  });
}

export function useInstantiateTemplate() {
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: InstantiateTemplateData }) =>
      instantiateTemplate(id, data),
  });
}

export function useCreateTemplateFromTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, data }: { taskId: string; data: CreateTemplateFromTaskData }) =>
      createTemplateFromTask(taskId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: templateKeys.lists() });
    },
  });
}
