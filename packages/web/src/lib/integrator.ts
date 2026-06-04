import type { IntegratorConfig, Project } from "@/lib/api";

/**
 * Extract the editable `settings.integrator` fields from a project's opaque
 * settings JSON, applying the server defaults for any absent field. Only the
 * fields the admin UI edits are surfaced; every other `settings.integrator`
 * field (verify_steps, cache_*, heartbeat_interval_sec, slo, worktree_name,
 * resolver) is left untouched here and preserved opaquely on save by
 * `mergeIntegratorSettings`. `verify_command` / `worktree_root` stay absent
 * when the server omitted them.
 */
export function integratorConfigFromProject(
  project: Pick<Project, "settings"> | undefined,
): IntegratorConfig {
  const settings = (project?.settings ?? {}) as {
    integrator?: Partial<IntegratorConfig>;
  };
  const integrator = settings.integrator ?? {};
  const config: IntegratorConfig = {
    enabled: integrator.enabled ?? false,
    verify_timeout_sec: integrator.verify_timeout_sec ?? 600,
    git_remote: integrator.git_remote ?? "origin",
    git_main_branch: integrator.git_main_branch ?? "main",
    parallelism: integrator.parallelism ?? 1,
    linked_repos: integrator.linked_repos ?? [],
    clean_keep: integrator.clean_keep ?? [],
  };
  if (integrator.verify_command != null)
    config.verify_command = integrator.verify_command;
  if (integrator.worktree_root != null)
    config.worktree_root = integrator.worktree_root;
  return config;
}

/**
 * Merge an edited IntegratorConfig back into a project's full settings object,
 * preserving every sibling settings block AND every integrator sub-field the
 * config does not carry (verify_steps, cache_*, heartbeat, slo, worktree_name,
 * resolver). settings is replaced wholesale server-side, so this client-side
 * merge is what protects the un-edited fields.
 */
export function mergeIntegratorSettings(
  existingSettings: unknown,
  config: IntegratorConfig,
): Record<string, unknown> {
  const existing = (existingSettings ?? {}) as Record<string, unknown>;
  const integrator = (existing.integrator ?? {}) as Record<string, unknown>;
  return { ...existing, integrator: { ...integrator, ...config } };
}
