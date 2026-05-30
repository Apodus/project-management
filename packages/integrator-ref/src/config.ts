import type { CacheMode, VerifyStep } from "@pm/shared";
import type { PmClient, ProjectDetail } from "./pm-client.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface IntegratorConfig {
  projectId: string;
  resource: string;
  pmUrl: string;
  token: string;
  logLevel: string;
  verifyCommand: string;
  /**
   * Phase 7.5 §2.1: the verify_steps DAG. Empty `[]` → the synthetic single-step
   * fallback over `verifyCommand` (byte-identical to 7.4). Non-empty → the
   * pipeline executor runs the DAG.
   */
  verifySteps: VerifyStep[];
  /**
   * Phase 7.5 §4.2/§4.3: the verify-cache kill-switch + mode. `cacheEnabled`
   * default false + `cacheMode` default "off" → no cache (today's behavior). The
   * pipeline runs cache-aware only when enabled AND mode !== "off" (§5.3).
   */
  cacheEnabled: boolean;
  cacheMode: CacheMode;
  verifyTimeoutSec: number;
  worktreeRoot: string;
  worktreeName: string;
  gitRemote: string;
  gitMainBranch: string;
  gitRepoUrl: string;
  parallelism: number;
  /**
   * Phase 7.4 §3.6: heartbeat cadence in seconds. The integrator POSTs a health
   * heartbeat every `heartbeatIntervalSec` seconds (plus one boot beat). Default
   * 30s — PM's 90s HEALTH_STALE_MS (§3.4) gives two missed beats of slack.
   */
  heartbeatIntervalSec: number;
  linkedRepos: {
    name: string;
    path: string;
    role: "inner" | "outer";
    gitlinkParent?: string;
    gitlinkPath?: string;
  }[];
}

export interface CliArgs {
  project?: string;
  resource?: string;
  pmUrl?: string;
  token?: string;
  logLevel?: string;
}

export interface ConfigEnv {
  PM_PROJECT_ID?: string;
  PM_API_URL?: string;
  PM_API_TOKEN?: string;
  PM_LOG_LEVEL?: string;
  [k: string]: string | undefined;
}

export async function loadConfig(
  args: CliArgs,
  env: ConfigEnv,
  pmClient: Pick<PmClient, "getProject">,
): Promise<IntegratorConfig> {
  const projectId = args.project ?? env.PM_PROJECT_ID;
  if (!projectId) {
    throw new ConfigError(
      "Project id is required: pass --project <id> or set PM_PROJECT_ID",
    );
  }

  const resource = args.resource ?? "main";

  const pmUrl = (args.pmUrl ?? env.PM_API_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );

  const tokenEnvVar = args.token ?? "PM_API_TOKEN";
  const token = env[tokenEnvVar];
  if (!token) {
    throw new ConfigError(
      `Token env var ${tokenEnvVar} is empty; set it to a valid PM API token`,
    );
  }

  const logLevel = args.logLevel ?? env.PM_LOG_LEVEL ?? "info";

  const project: ProjectDetail = await pmClient.getProject(projectId);
  const ic = project.settings?.integrator;
  if (!ic?.enabled) {
    throw new ConfigError(
      `Integrator is not enabled for project ${projectId}; set settings.integrator.enabled = true`,
    );
  }
  // FOLDED-FIX-3: mirror the canonical schema refine (project.ts) — verify_command
  // OR a non-empty verify_steps satisfies the requirement. Throw only when BOTH
  // are absent/empty. The synthetic single step is built downstream ONLY when
  // verify_steps is empty, in which case verify_command IS present here.
  const verifySteps = ic.verify_steps ?? [];
  if (!ic.verify_command && verifySteps.length === 0) {
    throw new ConfigError(
      `settings.integrator.verify_command (or a non-empty verify_steps) is required when enabled`,
    );
  }
  if (!ic.worktree_root) {
    throw new ConfigError(
      `settings.integrator.worktree_root is required when enabled`,
    );
  }

  const gitRepoUrl = project.gitRepoUrl;
  if (!gitRepoUrl) {
    throw new ConfigError(
      "project has no gitRepoUrl; the integrator needs a clonable repo URL",
    );
  }

  return {
    projectId,
    resource,
    pmUrl,
    token,
    logLevel,
    // Tolerates undefined (the synthetic step is built only when verifySteps is
    // empty, in which case verify_command IS present per the relaxed guard).
    verifyCommand: ic.verify_command ?? "",
    verifySteps,
    // Mirror the schema defaults (project.ts:122-123): cache off by default.
    cacheEnabled: ic.cache_enabled ?? false,
    cacheMode: ic.cache_mode ?? "off",
    verifyTimeoutSec: ic.verify_timeout_sec ?? 600,
    worktreeRoot: ic.worktree_root,
    worktreeName: ic.worktree_name ?? `${project.slug}-integrator`,
    gitRemote: ic.git_remote ?? "origin",
    gitMainBranch: ic.git_main_branch ?? "main",
    gitRepoUrl,
    parallelism: ic.parallelism ?? 1,
    heartbeatIntervalSec: ic.heartbeat_interval_sec ?? 30,
    linkedRepos: (ic.linked_repos ?? []).map((r) => ({
      name: r.name,
      path: r.path,
      role: r.role,
      gitlinkParent: r.gitlink_parent,
      gitlinkPath: r.gitlink_path,
    })),
  };
}
