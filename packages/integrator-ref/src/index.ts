import { Command } from "commander";
import { simpleGit } from "simple-git";
import { ConfigError, loadConfig, type CliArgs } from "./config.js";
import { PmClient } from "./pm-client.js";
import { createLogger } from "./logger.js";
import { createGitOps } from "./git-ops.js";
import { createWorktreePool } from "./worktree-pool.js";
import { createSseSubscriber } from "./sse-subscriber.js";
import { reclaimStrandedRequests } from "./recovery.js";
import { runBatchLoop } from "./batch.js";

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

  let cfg;
  try {
    cfg = await loadConfig(args, process.env as Record<string, string | undefined>, pmClient);
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
      projectId: cfg.projectId,
      resource: cfg.resource,
      verifyCommand: cfg.verifyCommand,
      worktreeRoot: cfg.worktreeRoot,
      parallelism: cfg.parallelism,
    },
    "Integrator ready",
  );

  process.stdout.write(
    `Integrator ready for project ${cfg.projectId} resource ${cfg.resource}\n`,
  );

  // ── Crash recovery: reclaim any stranded `integrating` requests. ──
  // N-tolerant: loops over EVERY `integrating` request in the lane and resets
  // each to `queued`. Takes no worktree/gitOps — purely a PM-side sweep — so it
  // is unchanged from the 7.1 wiring.
  const reclaim = await reclaimStrandedRequests(
    pmClient,
    cfg.projectId,
    cfg.resource,
    logger,
  );
  if (reclaim.scanned > 0) {
    logger.info(reclaim, "Crash-recovery sweep complete");
  }

  // ── Worktree pool + git-ops factory (phase 7.2). ──
  // The serial 7.1 path used a single worktree + a single gitOps bound to it.
  // The batch path leases worktrees from a size-`parallelism` pool and builds a
  // GitOps per-worktree via the factory (each member runs in its own slot).
  // At parallelism:1 the pool is a size-1 pool, so the observable behavior is a
  // batch-of-one that is byte-identical to the 7.1 serial loop.
  const pool = createWorktreePool({
    parallelism: cfg.parallelism,
    worktreeRoot: cfg.worktreeRoot,
    worktreeName: cfg.worktreeName,
    gitRepoUrl: cfg.gitRepoUrl,
    gitRemote: cfg.gitRemote,
    gitMainBranch: cfg.gitMainBranch,
  });
  const makeGitOps = (p: string) => createGitOps(simpleGit(p));
  try {
    // gc() removes stale slot clones from a previous run with a larger pool;
    // ensureAll() clones any missing slot. On-disk clones are reused across
    // runs (no destructive teardown), matching the 7.1 single-worktree reuse.
    await pool.gc();
    await pool.ensureAll();
  } catch (err) {
    logger.fatal(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to initialize worktree pool",
    );
    process.exit(1);
    return;
  }

  // ── SSE subscriber (latency hint; poll is the correctness floor). ──
  const sub = createSseSubscriber({
    baseUrl: pmUrl,
    token,
    projectId: cfg.projectId,
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

  await runBatchLoop(
    {
      pmClient,
      pool,
      gitOps: makeGitOps,
      logger,
      projectId: cfg.projectId,
      resource: cfg.resource,
      defaultVerifyCommand: cfg.verifyCommand,
      verifyTimeoutSec: cfg.verifyTimeoutSec,
      gitRemote: cfg.gitRemote,
      gitMainBranch: cfg.gitMainBranch,
      // Telemetry sink: post each batch marker to the PM relay endpoint. This is
      // a SYNCHRONOUS void handler that swallows its promise — a failed telemetry
      // POST must NEVER reject into / crash the drain loop, so we `.catch` it and
      // never return/await the promise (BatchDeps onBatchEvent is `(e) => void`).
      onBatchEvent: (evt) => {
        pmClient
          .postBatchEvent(cfg.projectId, evt)
          .catch((e) => logger.warn(`batch event post failed: ${String(e)}`));
      },
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
