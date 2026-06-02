import type { Project, ResolverConfig } from "@/lib/api";

/**
 * Extract the `settings.integrator.resolver` block from a project's opaque
 * settings JSON (Phase 7.6), applying the server defaults for any absent field.
 * `token_budget` / `prompt` / `command` stay absent when the server omitted them
 * (absent token_budget = unlimited, absent prompt = built-in default).
 */
export function resolverConfigFromProject(
  project: Pick<Project, "settings"> | undefined,
): ResolverConfig {
  const settings = (project?.settings ?? {}) as {
    integrator?: { resolver?: Partial<ResolverConfig> };
  };
  const resolver = settings.integrator?.resolver ?? {};
  const config: ResolverConfig = {
    enabled: resolver.enabled ?? false,
    max_concurrent: resolver.max_concurrent ?? 1,
    time_budget_sec: resolver.time_budget_sec ?? 600,
  };
  if (resolver.token_budget != null) config.token_budget = resolver.token_budget;
  if (resolver.command != null) config.command = resolver.command;
  if (resolver.prompt != null) config.prompt = resolver.prompt;
  return config;
}
