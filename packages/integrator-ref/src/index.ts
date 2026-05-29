import { Command } from "commander";
import { simpleGit } from "simple-git";
import { ConfigError, loadConfig, type CliArgs } from "./config.js";
import { PmClient } from "./pm-client.js";
import { createLogger } from "./logger.js";
import { createWorktree } from "./worktree.js";
import { createGitOps } from "./git-ops.js";
import { createSseSubscriber } from "./sse-subscriber.js";
import { reclaimStrandedRequests } from "./recovery.js";
import { runLoop } from "./loop.js";

async function main(): Promise<void> {
  const program = new Command()
    .name("pm-integrator")
    .description("Reference integrator process for the PM merge train")
    .version("0.0.0")
    .option("--project <id>", "Project ULID")
    .option("--resource <name>", "Train lane resource name", "main")
    .option("--pm-url <url>", "PM API base URL")
    .option("--token <envVar>", "Env var containing PM API token", "PM_API_TOKEN")
    .option("--log-level <level>", "pino log level (trace|debug|info|warn|error|fatal)")
    .option("--poll-interval-sec <sec>", "Polling interval in seconds", "30")
    .parse(process.argv);

  const args = program.opts() as CliArgs & { pollIntervalSec?: string };
  const logger = createLogger(
    args.logLevel ?? process.env.PM_LOG_LEVEL ?? "info",
  );

  const tokenEnvVar = args.token ?? "PM_API_TOKEN";
  const token = process.env[tokenEnvVar];
  if (!token) {
    logger.fatal({ tokenEnvVar }, `Token env var ${tokenEnvVar} is empty`);
    process.exit(1);
  }
  const pmUrl = (args.pmUrl ?? process.env.PM_API_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
  const pmClient = new PmClient({ baseUrl: pmUrl, token });

  let config;
  try {
    config = await loadConfig(args, process.env as Record<string, string | undefined>, pmClient);
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.fatal({ err: err.message }, "Configuration invalid");
    } else {
      logger.fatal(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to load config",
      );
    }
    // Code 2 = config/validation failure (systemd: don't restart). Code 1
    // is reserved for unexpected runtime errors.
    process.exit(2);
    return;
  }

  logger.info(
    {
      projectId: config.projectId,
      resource: config.resource,
      verifyCommand: config.verifyCommand,
      worktreeRoot: config.worktreeRoot,
    },
    "Integrator ready",
  );

  process.stdout.write(
    `Integrator ready for project ${config.projectId} resource ${config.resource}\n`,
  );

  // ── Crash recovery: reclaim any stranded `integrating` requests. ──
  const reclaim = await reclaimStrandedRequests(
    pmClient,
    config.projectId,
    config.resource,
    logger,
  );
  if (reclaim.scanned > 0) {
    logger.info(reclaim, "Crash-recovery sweep complete");
  }

  // ── Worktree + git-ops setup. ──
  const worktree = createWorktree({
    worktreeRoot: config.worktreeRoot,
    worktreeName: config.worktreeName,
    gitRemote: config.gitRemote,
    gitMainBranch: config.gitMainBranch,
    gitRepoUrl: config.gitRepoUrl,
  });
  try {
    await worktree.ensureExists();
  } catch (err) {
    logger.fatal(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to initialize worktree",
    );
    process.exit(1);
    return;
  }
  const gitOps = createGitOps(simpleGit(worktree.path));

  // ── SSE subscriber (latency hint; poll is the correctness floor). ──
  const sub = createSseSubscriber({
    baseUrl: pmUrl,
    token,
    projectId: config.projectId,
    logger,
  });
  sub.start();

  // ── Shutdown handling. ──
  let stopRequested = false;
  const requestStop = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "Integrator shutting down");
    stopRequested = true;
    // Wake the loop if it's parked waiting for work.
    sub.wakeup.resolve();
  };
  process.on("SIGTERM", () => requestStop("SIGTERM"));
  process.on("SIGINT", () => requestStop("SIGINT"));

  const pollIntervalMs =
    Math.max(1, Number(args.pollIntervalSec ?? "30") || 30) * 1000;

  await runLoop(
    {
      pmClient,
      gitOps,
      worktree,
      logger,
      projectId: config.projectId,
      resource: config.resource,
      defaultVerifyCommand: config.verifyCommand,
      verifyTimeoutSec: config.verifyTimeoutSec,
      gitRemote: config.gitRemote,
      gitMainBranch: config.gitMainBranch,
      shouldContinue: () => !stopRequested,
      waitForWork: async (pollMs: number) => {
        const wake = sub.wakeup.wait();
        const timer = new Promise<void>((resolve) => {
          const t = setTimeout(resolve, pollMs);
          t.unref?.();
        });
        await Promise.race([wake, timer]);
        // Reset the wakeup so the next wait gets a fresh promise.
        sub.wakeup.resolve();
      },
    },
    { pollIntervalMs },
  );

  sub.stop();
  logger.info("Integrator stopped cleanly");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(
    `integrator-ref fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
