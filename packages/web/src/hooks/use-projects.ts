import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getProjects,
  getProject,
  getProjectStats,
  createProject,
  updateProject,
  getResolverDefaults,
  type CreateProject,
  type UpdateProject,
  type ResolverConfig,
  type IntegratorConfig,
} from "@/lib/api";
import { mergeIntegratorSettings } from "@/lib/integrator";
import { trainKeys } from "@/hooks/use-train";

export const projectKeys = {
  all: ["projects"] as const,
  lists: () => [...projectKeys.all, "list"] as const,
  list: (status?: string) => [...projectKeys.lists(), { status }] as const,
  details: () => [...projectKeys.all, "detail"] as const,
  detail: (id: string) => [...projectKeys.details(), id] as const,
  stats: (id: string) => [...projectKeys.all, "stats", id] as const,
};

export function useProjects(status?: string) {
  return useQuery({
    queryKey: projectKeys.list(status),
    queryFn: () => getProjects(status),
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: projectKeys.detail(id!),
    queryFn: () => getProject(id!),
    enabled: !!id,
  });
}

export function useProjectStats(id: string | undefined) {
  return useQuery({
    queryKey: projectKeys.stats(id!),
    queryFn: () => getProjectStats(id!),
    enabled: !!id,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateProject) => createProject(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateProject }) =>
      updateProject(id, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
      queryClient.invalidateQueries({
        queryKey: projectKeys.detail(variables.id),
      });
    },
  });
}

// ─── Resolver config (Phase 7.6) ─────────────────────────────────

export const resolverKeys = {
  defaults: ["resolver", "defaults"] as const,
};

/**
 * Built-in resolver defaults — static, so cached aggressively. Sources the
 * default reconcile prompt and the "revert to defaults" values.
 */
export function useResolverDefaults() {
  return useQuery({
    queryKey: resolverKeys.defaults,
    queryFn: getResolverDefaults,
    staleTime: Infinity,
  });
}

/**
 * Update only the `settings.integrator.resolver` block. Fetches the current
 * project, MERGES the new resolver block into `settings.integrator` (preserving
 * sibling integrator fields like verify_command/verify_steps/cache and all
 * other settings sub-blocks), PATCHes, and invalidates the project + train
 * queries (the dashboard reads the resolver state through the project).
 */
export function useUpdateResolverConfig(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (resolver: ResolverConfig) => {
      if (!projectId) throw new Error("No project selected");
      // Fetch fresh so we merge onto the latest settings, not a stale cache.
      const project = await getProject(projectId);
      const existing = (project.settings ?? {}) as Record<string, unknown>;
      const integrator = (existing.integrator ?? {}) as Record<string, unknown>;
      const settings = {
        ...existing,
        integrator: { ...integrator, resolver },
      };
      // settings is opaque JSON on the wire; round-tripping the server's own
      // settings untouched, so the cast onto the structured type is safe.
      return updateProject(projectId, { settings } as UpdateProject);
    },
    onSuccess: () => {
      if (projectId) {
        queryClient.invalidateQueries({
          queryKey: projectKeys.detail(projectId),
        });
      }
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
      // The dashboard reads resolver metrics under trainKeys.all.
      queryClient.invalidateQueries({ queryKey: trainKeys.all });
    },
  });
}

/**
 * Update the editable `settings.integrator` fields. Fetches the current project,
 * MERGES the edited config into `settings.integrator` (preserving every sibling
 * integrator sub-field the config doesn't carry — verify_steps, cache_*,
 * heartbeat_interval_sec, slo, worktree_name, resolver — and every other settings
 * block), then PATCHes. `gitRepoUrl` is passed alongside so the form can update the
 * repo URL in the same save. Invalidates the project + train queries.
 */
export function useUpdateIntegratorConfig(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      config,
      gitRepoUrl,
    }: {
      config: IntegratorConfig;
      gitRepoUrl: string | null;
    }) => {
      if (!projectId) throw new Error("No project selected");
      // Fetch fresh so we merge onto the latest settings, not a stale cache.
      const project = await getProject(projectId);
      const settings = mergeIntegratorSettings(project.settings, config);
      // settings is opaque JSON on the wire; round-tripping the server's own
      // settings untouched, so the cast onto the structured type is safe.
      return updateProject(projectId, { settings, gitRepoUrl } as UpdateProject);
    },
    onSuccess: () => {
      if (projectId) {
        queryClient.invalidateQueries({
          queryKey: projectKeys.detail(projectId),
        });
      }
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
      queryClient.invalidateQueries({ queryKey: trainKeys.all });
    },
  });
}
