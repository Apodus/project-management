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
  verifyTimeoutSec: number;
  worktreeRoot: string;
  worktreeName: string;
  gitRemote: string;
  gitMainBranch: string;
  gitRepoUrl: string;
  parallelism: number;
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
  if (!ic.verify_command) {
    throw new ConfigError(
      `settings.integrator.verify_command is required when enabled`,
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
    verifyCommand: ic.verify_command,
    verifyTimeoutSec: ic.verify_timeout_sec ?? 600,
    worktreeRoot: ic.worktree_root,
    worktreeName: ic.worktree_name ?? `${project.slug}-integrator`,
    gitRemote: ic.git_remote ?? "origin",
    gitMainBranch: ic.git_main_branch ?? "main",
    gitRepoUrl,
    parallelism: ic.parallelism ?? 1,
    linkedRepos: (ic.linked_repos ?? []).map((r) => ({
      name: r.name,
      path: r.path,
      role: r.role,
      gitlinkParent: r.gitlink_parent,
      gitlinkPath: r.gitlink_path,
    })),
  };
}
