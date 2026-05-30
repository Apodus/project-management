import { Command } from "commander";
import { simpleGit } from "simple-git";
import { ConfigError, loadConfig, type CliArgs } from "./config.js";
import { PmClient } from "./pm-client.js";
import { createLogger } from "./logger.js";
import { createGitOps } from "./git-ops.js";
import { createWorktreePool } from "./worktree-pool.js";
import { createSseSubscriber } from "./sse-subscriber.js";
import { reclaimStrandedGroups, reclaimStrandedRequests } from "./recovery.js";
import { runBatchLoop, type GroupLaneDeps } from "./batch.js";
import type { RepoLane } from "./group-integration.js";
import { chaosFailOuterPushOnce } from "./chaos.js";
import type { GitOps, PushResult } from "./git-ops.js";

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

  // ── Phase 7.3 group lane (Step 10) — only when linkedRepos are declared. ──
  // Build a per-repo pool + binding clone for each linked repo, role from
  // config. Absent linkedRepos → groupLane stays undefined → exact 7.2 path.
  let groupLane: GroupLaneDeps | undefined;
  if (cfg.linkedRepos.length > 0) {
    const inner = cfg.linkedRepos.find((r) => r.role === "inner");
    const outer = cfg.linkedRepos.find((r) => r.role === "outer");
    if (!inner || !outer) {
      logger.fatal(
        { linkedRepos: cfg.linkedRepos.map((r) => r.role) },
        "Group integration requires exactly one inner and one outer linked repo",
      );
      process.exit(2);
      return;
    }
    const makeLane = (
      repo: (typeof cfg.linkedRepos)[number],
    ): { lane: RepoLane; pool: ReturnType<typeof createWorktreePool> } => {
      const lanePool = createWorktreePool({
        parallelism: cfg.parallelism,
        worktreeRoot: cfg.worktreeRoot,
        worktreeName: `${cfg.worktreeName}-${repo.role}`,
        gitRepoUrl: repo.path,
        gitRemote: cfg.gitRemote,
        gitMainBranch: cfg.gitMainBranch,
      });
      // Binding clone: a simple-git over the repo's local clone path, used ONLY
      // to resolve a member's ref (commitSha/branch). resolveRefInClone MUST
      // return null (not throw) for an absent ref so FIX 1 can fail loud only
      // on a true ambiguity.
      const bindGit = simpleGit(repo.path);
      const lane: RepoLane = {
        role: repo.role,
        name: repo.name,
        acquire: () => lanePool.acquire(),
        release: (wt) => lanePool.release(wt),
        gitOps: (p) => createGitOps(simpleGit(p)),
        gitlinkPath: repo.gitlinkPath,
        resolveRefInClone: async (ref: string): Promise<string | null> => {
          // `--verify <ref>^{commit}` FAILS (throws) when the object/ref is not
          // present in THIS clone — unlike a bare `rev-parse <full-sha>`, which
          // echoes any 40-hex string back without checking existence. This is
          // what makes the commitSha-first binding resolve in exactly one repo.
          try {
            return (await bindGit.revparse(["--verify", `${ref}^{commit}`])).trim();
          } catch {
            return null;
          }
        },
      };
      return { lane, pool: lanePool };
    };
    const innerBuilt = makeLane(inner);
    const outerBuilt = makeLane(outer);

    // ── CHAOS (test-only): PM_CHAOS_FAIL_OUTER_PUSH=once makes the OUTER push in
    //    the §6 atomic land return a PushFailure exactly ONCE (the deterministic
    //    orphan trigger for E2E flow c/d). The first outer push (after inner
    //    landed) fails → orphan + incident; every subsequent push (incl. the §7
    //    recovery roll-forward, which uses the OUTER lane's gitOps) delegates to
    //    the real gitOps. Gated; no-op in production.
    //
    //    NOTE: group assembly builds BOTH the inner and outer GitOps from the
    //    INNER lane's `gitOps` factory (group-integration wires
    //    `gitOps: innerLane.gitOps` for assembleGroup). So to induce the LAND's
    //    outer push to fail we wrap the INNER lane factory and discriminate by
    //    the outer worktree's path suffix ("-outer"); the OUTER lane's factory is
    //    left real so the recovery push succeeds. (Mirrors the
    //    group-land.test.ts failingPushGitOps technique.) ──
    if (chaosFailOuterPushOnce()) {
      const realInnerGitOps = innerBuilt.lane.gitOps;
      let outerPushFailed = false;
      const outerMarker = `${cfg.worktreeName}-${outer.role}`;
      innerBuilt.lane.gitOps = (p: string): GitOps => {
        const g = realInnerGitOps(p);
        if (!p.includes(outerMarker)) return g;
        return {
          ...g,
          async push(remote: string, branch: string): Promise<PushResult> {
            if (!outerPushFailed) {
              outerPushFailed = true;
              logger.warn(
                { worktree: p },
                "CHAOS: failing outer push once (orphan trigger)",
              );
              return { ok: false, reason: "network", stderr: "induced chaos outer push failure" };
            }
            return g.push(remote, branch);
          },
        };
      };
    }
    try {
      await innerBuilt.pool.gc();
      await innerBuilt.pool.ensureAll();
      await outerBuilt.pool.gc();
      await outerBuilt.pool.ensureAll();
    } catch (err) {
      logger.fatal(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to initialize linked-repo worktree pools",
      );
      process.exit(1);
      return;
    }
    groupLane = {
      innerLane: innerBuilt.lane,
      outerLane: outerBuilt.lane,
      integratorId: undefined,
      innerLogsDir: undefined,
      outerLogsDir: undefined,
    };

    // ── Crash recovery: reclaim stranded GROUPS (design §9 finding 2 / §6.4). ──
    // Only when a group lane exists (linkedRepos declared). A group left
    // `integrating` by a crash with NO open incident is the §6.4
    // crash-between-PUSH-1-and-incident-write window — reset the whole group
    // (atomic group+members) so it re-integrates as a clean atom. A group WITH
    // an open incident is a real orphan, left for the §7 rollforward sweep.
    const reclaimGroups = await reclaimStrandedGroups(
      pmClient,
      cfg.projectId,
      cfg.resource,
      logger,
    );
    if (reclaimGroups.scanned > 0) {
      logger.info(reclaimGroups, "Stranded-group recovery sweep complete");
    }
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
      groupLane,
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
