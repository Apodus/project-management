import { useQuery } from "@tanstack/react-query";
import {
  getProjectActivity,
  getTaskActivity,
  type ActivityFilters,
} from "@/lib/api";

export const activityKeys = {
  all: ["activity"] as const,
  project: (projectId: string, filters?: ActivityFilters) =>
    [...activityKeys.all, "project", { projectId, ...filters }] as const,
  task: (taskId: string) =>
    [...activityKeys.all, "task", taskId] as const,
};

export function useProjectActivity(
  projectId: string | undefined,
  filters?: ActivityFilters,
) {
  return useQuery({
    queryKey: activityKeys.project(projectId!, filters),
    queryFn: () => getProjectActivity(projectId!, filters),
    enabled: !!projectId,
  });
}

export function useTaskActivity(taskId: string | undefined) {
  return useQuery({
    queryKey: activityKeys.task(taskId!),
    queryFn: () => getTaskActivity(taskId!),
    enabled: !!taskId,
  });
}
