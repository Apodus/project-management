import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getTasks,
  getTask,
  getTaskComments,
  getTaskSubtasks,
  updateTask,
  addTaskComment,
  transitionTask,
  type TaskFilters,
  type UpdateTask,
} from "@/lib/api";

export const taskKeys = {
  all: ["tasks"] as const,
  lists: () => [...taskKeys.all, "list"] as const,
  list: (projectId: string, filters?: TaskFilters) =>
    [...taskKeys.lists(), { projectId, ...filters }] as const,
  details: () => [...taskKeys.all, "detail"] as const,
  detail: (id: string) => [...taskKeys.details(), id] as const,
  comments: (id: string) => [...taskKeys.all, "comments", id] as const,
  subtasks: (id: string) => [...taskKeys.all, "subtasks", id] as const,
};

export function useTasks(projectId: string | undefined, filters?: TaskFilters) {
  return useQuery({
    queryKey: taskKeys.list(projectId!, filters),
    queryFn: () => getTasks(projectId!, filters),
    enabled: !!projectId,
  });
}

export function useTask(id: string | undefined) {
  return useQuery({
    queryKey: taskKeys.detail(id!),
    queryFn: () => getTask(id!),
    enabled: !!id,
  });
}

export function useTaskComments(taskId: string | undefined) {
  return useQuery({
    queryKey: taskKeys.comments(taskId!),
    queryFn: () => getTaskComments(taskId!),
    enabled: !!taskId,
  });
}

export function useTaskSubtasks(taskId: string | undefined) {
  return useQuery({
    queryKey: taskKeys.subtasks(taskId!),
    queryFn: () => getTaskSubtasks(taskId!),
    enabled: !!taskId,
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateTask }) =>
      updateTask(id, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
      queryClient.invalidateQueries({
        queryKey: taskKeys.detail(variables.id),
      });
    },
  });
}

export function useAddTaskComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      body,
      type,
      metadata,
    }: {
      taskId: string;
      body: string;
      type?: string;
      metadata?: Record<string, unknown> | null;
    }) => addTaskComment(taskId, body, type, metadata),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: taskKeys.comments(variables.taskId),
      });
      queryClient.invalidateQueries({
        queryKey: taskKeys.detail(variables.taskId),
      });
    },
  });
}

export function useTransitionTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      toStatus,
      comment,
    }: {
      taskId: string;
      toStatus: string;
      comment?: string;
    }) => transitionTask(taskId, toStatus, comment),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
      queryClient.invalidateQueries({
        queryKey: taskKeys.detail(variables.taskId),
      });
    },
  });
}
