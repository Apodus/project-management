import { mkdir } from "node:fs/promises";
import { Command } from "commander";
import { ConfigError, loadConfig, type CliArgs } from "./config.js";
import { ResponderClient } from "./api-client.js";
import { createLogger } from "./logger.js";
import { runResponderLoop } from "./loop.js";
import { createClaudeResponderRunner } from "./responder-runner.js";
import { createClaudeInjectionSniffer } from "./injection-sniffer.js";
import { createClaudeImplementRunner } from "./implement-runner.js";
import { createClaudeDriveRunner } from "./drive-runner.js";
import { createWorktree, type Worktree } from "./worktree.js";
import { VERSION } from "./version.js";

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

async function main(): Promise<void> {
  const program = new Command()
    .name("pm-responder")
    .description("Reference responder daemon for the PM escalation channel")
    .version(VERSION)
    .option("--pm-url <url>", "PM API base URL")
    .option("--log-level <level>", "pino log level (trace|debug|info|warn|error|fatal)")
    .option("--poll-interval-sec <sec>", "Polling interval in seconds", "15")
    .option(
      "--project <id>",
      "Project id to watch (repeatable)",
      collect,
      [] as string[],
    )
    .option("--enabled", "Enable the responder (default off)")
    .option("--mode <mode>", "Responder mode (off|shadow|on); default shadow")
    .option("--repo-cwd <path>", "Working directory the answering session runs in (the PM repo checkout)")
    .parse(process.argv);

  const args = program.opts() as CliArgs;
  const logger = createLogger(args.logLevel ?? process.env.PM_LOG_LEVEL ?? "info");

  let cfg;
  try {
    cfg = loadConfig(args, process.env as Record<string, string | undefined>);
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.fatal({ err: err.message }, "Configuration invalid");
    } else {
      logger.fatal({ err: err instanceof Error ? err.message : String(err) }, "Failed to load config");
    }
    // Code 2 = config/validation failure (systemd: don't restart). Code 1 is
    // reserved for unexpected runtime errors.
    process.exit(2);
    return;
  }

  const client = new ResponderClient({ baseUrl: cfg.pmUrl, token: cfg.token });

  // ── Kill-switch gate. ──
  // enabled defaults FALSE. When disabled the loop is NEVER entered — we log and
  // exit 0 (clean). The loop body also defensively no-ops on !enabled, but the
  // process should not idle a poll timer when the operator has not opted in.
  if (!cfg.enabled) {
    logger.info(
      { version: VERSION, mode: cfg.mode, projectIds: cfg.projectIds },
      "Responder disabled (responder.enabled=false); idling",
    );
    process.stdout.write("Responder disabled (responder.enabled=false); idling\n");
    process.exit(0);
    return;
  }

  // ── Answering-session wiring. ──
  // Ensure the sentinel/log directory exists (AFTER the kill-switch gate, so a
  // disabled process never mkdirs). It lives OUTSIDE any git tree.
  await mkdir(cfg.logsDir, { recursive: true });
  const runner = createClaudeResponderRunner({ command: cfg.command });
  const sniffer = createClaudeInjectionSniffer({ command: cfg.command });
  // A1 P3: the write-capable implement runner + the default worktree-acquire seam
  // (createWorktree bound to the git config + worktreeRoot). The slot name maps to a
  // distinct clone directory under worktreeRoot so concurrent sessions never collide.
  const implementRunner = createClaudeImplementRunner({ command: cfg.command });
  // A3 P1: the vision-producing drive runner (reuses cfg.command). The loop creates
  // the PM epic + tasks over HTTP from its result — the session does no PM write-back.
  const driveRunner = createClaudeDriveRunner({ command: cfg.command });
  const acquireWorktree = (slotName: string): Worktree =>
    createWorktree({
      worktreeRoot: cfg.worktreeRoot,
      worktreeName: slotName,
      gitRepoUrl: cfg.worktreeGit.repoUrl,
      gitRemote: cfg.worktreeGit.remote,
      gitMainBranch: cfg.worktreeGit.mainBranch,
      cleanKeep: cfg.worktreeGit.cleanKeep,
    });

  // ── Resolve self identity (no-recursion seed). ──
  let selfId: string;
  try {
    const me = await client.getMe();
    selfId = me.id;
  } catch (err) {
    logger.fatal(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to resolve self identity via /auth/me",
    );
    process.exit(1);
    return;
  }

  logger.info(
    {
      version: VERSION,
      pmUrl: cfg.pmUrl,
      projectIds: cfg.projectIds,
      mode: cfg.mode,
      pollIntervalSec: cfg.pollIntervalSec,
      maxConcurrent: cfg.maxConcurrent,
      selfId,
    },
    "Responder daemon ready",
  );
  process.stdout.write(
    `Responder daemon ready, watching ${cfg.projectIds.length} project(s)\n`,
  );

  // ── Shutdown handling. ──
  let stopRequested = false;
  let pollWaiter: (() => void) | undefined;
  const requestStop = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "Responder daemon shutting down");
    stopRequested = true;
    pollWaiter?.();
  };
  process.on("SIGTERM", () => requestStop("SIGTERM"));
  process.on("SIGINT", () => requestStop("SIGINT"));

  await runResponderLoop(
    {
      client,
      logger,
      projectIds: cfg.projectIds,
      selfId,
      enabled: cfg.enabled,
      maxConcurrent: cfg.maxConcurrent,
      excludeOriginRepos: cfg.excludeOriginRepos,
      reclaimGraceSec: cfg.reclaimGraceSec,
      maxReclaimAttempts: cfg.maxReclaimAttempts,
      spawnBudget: cfg.spawnBudget,
      runner,
      autoImplementEnabled: cfg.autoImplement.enabled,
      sniffer,
      implementRunner,
      driveRunner,
      acquireWorktree,
      worktreeGit: {
        remote: cfg.worktreeGit.remote,
        mainBranch: cfg.worktreeGit.mainBranch,
        allowedPaths: cfg.autoImplement.allowedPaths,
      },
      verifyCmd: cfg.autoImplement.verifyCmd,
      maxConcurrentArcs: cfg.autoImplement.budget.maxConcurrentArcs,
      maxArcDurationSec: cfg.autoImplement.budget.maxArcDurationSec,
      stallTimeoutSec: cfg.autoImplement.budget.stallTimeoutSec,
      repoCwd: cfg.repoCwd,
      command: cfg.command,
      mode: cfg.mode,
      budget: { timeBudgetSec: cfg.timeBudgetSec, tokenBudget: cfg.tokenBudget },
      logsDir: cfg.logsDir,
      shouldContinue: () => !stopRequested,
      waitForWork: (pollMs: number) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, pollMs);
          t.unref?.();
          pollWaiter = () => {
            clearTimeout(t);
            resolve();
          };
        }),
    },
    { pollIntervalMs: cfg.pollIntervalSec * 1000 },
  );

  logger.info("Responder daemon stopped cleanly");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(
    `responder-ref fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
