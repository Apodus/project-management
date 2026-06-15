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
  if (integrator.verify_command != null) config.verify_command = integrator.verify_command;
  if (integrator.worktree_root != null) config.worktree_root = integrator.worktree_root;
  return config;
}

/**
 * C2 — the verify-cache config guardrail predicate (WEB MIRROR).
 *
 * Duplicated-VERBATIM mirror of the canonical `cacheConfigWarnings` in
 * packages/shared/src/schemas/project.ts (the established mirror pattern —
 * like IntegratorConfig in api.ts:71 mirroring the server schema). Keep the
 * two in lockstep. PURE + advisory (never blocks): warns when the cache is
 * armed (`cache_enabled === true` AND `cache_mode === "on"`) while any verify
 * step — including the synthetic verify_command step when verify_steps is
 * empty — declares no cache_key_inputs (the §16.2 false-pass precondition;
 * shadow-first is the safe rollout).
 */
export function cacheConfigWarnings(
  integrator:
    | {
        cache_enabled?: boolean;
        cache_mode?: string;
        verify_steps?: { id: string; cache_key_inputs?: string[] }[];
      }
    | null
    | undefined,
): string[] {
  if (!integrator) return [];
  if (integrator.cache_enabled !== true || integrator.cache_mode !== "on") {
    return [];
  }
  const steps = integrator.verify_steps ?? [];
  const missing =
    steps.length === 0
      ? [`"verify" (the synthetic verify_command step)`]
      : steps.filter((s) => (s.cache_key_inputs ?? []).length === 0).map((s) => `"${s.id}"`);
  if (missing.length === 0) return [];
  const plural = missing.length > 1;
  return [
    `verify-cache is ON (cache_enabled + cache_mode "on") but verify step${plural ? "s" : ""} ` +
      `${missing.join(", ")} declare${plural ? "" : "s"} no cache_key_inputs. ` +
      `An undeclared out-of-tree input (toolchain, env, external service) CAN false-pass a ` +
      `cached verdict (deployment guide §16.2). Run cache_mode "shadow" first and observe ` +
      `zero verify.cache_mismatch events before flipping to "on".`,
  ];
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
