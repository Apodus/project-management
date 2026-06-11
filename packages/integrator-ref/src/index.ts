import { Command } from "commander";
import path from "node:path";
import { simpleGit } from "simple-git";
import { createBindingResolver } from "./binding-clone.js";
import { ConfigError, loadConfig, type CliArgs } from "./config.js";
import { PmClient } from "./pm-client.js";
import { createLogger } from "./logger.js";
import { createGitOps } from "./git-ops.js";
import { createWorktreePool } from "./worktree-pool.js";
import { createResolverPool } from "./resolver-pool.js";
import { createClaudeResolverRunner } from "./resolver-runner.js";
import { makeOnOutcome } from "./resolution-outcome.js";
import { createSseSubscriber } from "./sse-subscriber.js";
import { reclaimStrandedGroups, reclaimStrandedRequests } from "./recovery.js";
import { runBatchLoop, type GroupLaneDeps } from "./batch.js";
import type { RepoLane } from "./group-integration.js";
import { chaosFailOuterPushOnce } from "./chaos.js";
import type { GitOps, PushResult } from "./git-ops.js";
import { buildHeartbeat } from "./heartbeat.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  const program = new Command()
    .name("pm-integrator")
    .description("Reference integrator process for the PM merge train")
    .version(VERSION)
    .option("--project <id>", "Project ULID")
    .option("--resource <name>", "Train lane resource name", "main")
    .option("--pm-url <url>", "PM API base URL")
    .option("--token <envVar>", "Env var containing PM API token", "PM_API_TOKEN")
    .option("--log-level <level>", "pino log level (trace|debug|info|warn|error|fatal)")
    .option("--poll-interval-sec <sec>", "Polling interval in seconds", "30")
    .parse(process.argv);

  const args = program.opts() as CliArgs & { pollIntervalSec?: string };
  // Phase 7.4 §3.2: the integrator's package version, reported on every
  // heartbeat. Sourced from the generated version.ts (single source of truth =
  // package.json), which is also what we pass to commander's .version() above.
  const version = VERSION;
  const logger = createLogger(args.logLevel ?? process.env.PM_LOG_LEVEL ?? "info");

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

  process.stdout.write(`Integrator ready for project ${cfg.projectId} resource ${cfg.resource}\n`);

  // ── Crash recovery: reclaim any stranded `integrating` requests. ──
  // N-tolerant: loops over EVERY `integrating` request in the lane and resets
  // each to `queued`. Takes no worktree/gitOps — purely a PM-side sweep — so it
  // is unchanged from the 7.1 wiring.
  const reclaim = await reclaimStrandedRequests(pmClient, cfg.projectId, cfg.resource, logger);
  if (reclaim.scanned > 0) {
    logger.info(reclaim, "Crash-recovery sweep complete");
  }

  // ── Worktree pool + git-ops factory (phase 7.2). ──
  // The serial 7.1 path used a single worktree + a single gitOps bound to it.
  // The batch path leases worktrees from a size-`parallelism` pool and builds a
  // GitOps per-worktree via the factory (each member runs in its own slot).
  // At parallelism:1 the pool is a size-1 pool, so the observable behavior is a
  // batch-of-one that is byte-identical to the 7.1 serial loop.
  //
  // gitlinkPurgePaths: every declared inner gitlink_path is purged of stale
  // materialized overlays on each resetForAttempt — git itself is blind to
  // plain files at a committed gitlink path, so a leftover group-assembly
  // overlay would otherwise poison every later verify in the slot. Applied to
  // ALL pools (default/lane/resolver); the purge is self-guarding (only a
  // populated, .git-less dir at an actual 160000 gitlink is removed), so it is
  // a no-op for repos where the path is not a gitlink. Empty linked_repos ⇒ []
  // ⇒ byte-identical to before.
  const gitlinkPurgePaths = cfg.linkedRepos.flatMap((r) => (r.gitlinkPath ? [r.gitlinkPath] : []));
  const pool = createWorktreePool({
    parallelism: cfg.parallelism,
    worktreeRoot: cfg.worktreeRoot,
    worktreeName: cfg.worktreeName,
    gitRepoUrl: cfg.gitRepoUrl,
    gitRemote: cfg.gitRemote,
    gitMainBranch: cfg.gitMainBranch,
    cleanKeep: cfg.cleanKeep,
    gitlinkPurgePaths,
  });
  const makeGitOps = (p: string) => createGitOps(simpleGit(p));

  // ── Phase 7.4 §3.2 (Step 12): the shared in-flight counters + heartbeat. ──
  // A single mutable object threaded into the batch + group lane deps; the
  // single-threaded loop mutates it synchronously. The heartbeat reads it to
  // derive `status` and the `in_flight` payload. Created here so the boot beat
  // (below, after ensureAll) reports the true idle state.
  const inFlight = { requests: 0, batches: 0, groups: 0 };

  // ── C2 (failure legibility): shared lane-health state. ──
  // The lock releaser (batch + group lanes) records a FAILED lane-lock release
  // here (and clears it on a later success); every heartbeat carries it to PM
  // (integrator_health.last_release_failure) so "why is the lane idling while
  // work queues" is answerable from the dashboard. Same mutable-object idiom
  // as `inFlight`.
  const laneHealth = { lastReleaseFailure: null as { at: string; message: string } | null };

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

  // ── Phase 7.6 §3/§5.1: resolver pool — constructed ONLY when enabled. ──
  // With resolver.enabled = false (default) this stays undefined, the conflict
  // seam is inert, and the train is byte-identical to 7.5. When enabled we build
  // a SEPARATE pool (size = resolver.maxConcurrent) whose worktrees carry a
  // distinct `-resolver-<i>` name so they never collide with verify-pool slots.
  let resolverPool: ReturnType<typeof createResolverPool> | undefined;
  if (cfg.resolver.enabled) {
    resolverPool = createResolverPool({
      worktreeRoot: cfg.worktreeRoot,
      worktreeName: cfg.worktreeName,
      gitRepoUrl: cfg.gitRepoUrl,
      gitRemote: cfg.gitRemote,
      gitMainBranch: cfg.gitMainBranch,
      cleanKeep: cfg.cleanKeep,
      gitlinkPurgePaths,
      maxConcurrent: cfg.resolver.maxConcurrent,
      // ── Phase 7.6 Step 6 worker deps. ──
      pmClient,
      logger,
      gitOps: makeGitOps,
      verifySteps: cfg.verifySteps,
      defaultVerifyCommand: cfg.verifyCommand,
      runner: createClaudeResolverRunner(cfg),
      timeBudgetSec: cfg.resolver.timeBudgetSec,
      tokenBudget: cfg.resolver.tokenBudget,
      prompt: cfg.resolver.prompt,
      // ──────────────────────────────────────────────────────────────────
      // STEP-7 SEAM (design §5.3/§5.4): the onOutcome handler. On `resolved` it
      // PUSHES the resolved commit from `outcome.worktreePath` (reachable ONLY
      // in the resolver clone until pushed), then RESUBMITS it as a new merge
      // request carrying `resolvedFrom = origin.id` (+ origin.verifyCmd) and
      // records `resolvedRequestId` (→ resolved). On `escalate` it transitions
      // the resolution (escalated/failed) and posts a `merge_rejection` comment
      // on the origin task. Step 6 keeps the worktree LEASED until this resolves.
      // ──────────────────────────────────────────────────────────────────
      onOutcome: makeOnOutcome({
        pmClient,
        makeGitOps,
        logger,
        cfg: { projectId: cfg.projectId, gitRemote: cfg.gitRemote },
      }),
    });
    try {
      await resolverPool.gc();
      await resolverPool.ensureAll();
    } catch (err) {
      logger.fatal(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to initialize resolver worktree pool",
      );
      process.exit(1);
      return;
    }
    logger.info(
      { size: resolverPool.size, maxConcurrent: cfg.resolver.maxConcurrent },
      "Resolver pool ready (Phase 7.6)",
    );
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
        cleanKeep: cfg.cleanKeep,
        gitlinkPurgePaths,
      });
      // Binding clone: a LOCAL `--mirror` clone of the linked repo, used ONLY to
      // resolve a member's ref (commitSha/branch). `repo.path` may be a remote
      // URL (the documented "clone URL" form) — and simple-git refuses to bind
      // to anything that isn't an existing local directory — so we cannot
      // `simpleGit(repo.path)` it directly. Instead we maintain a local mirror
      // under worktreeRoot (refs + objects only; no working tree, no LFS smudge
      // — all that ref resolution needs) and FETCH it before each resolution to
      // pick up the worker's just-pushed branch/commit. resolveRefInClone returns
      // null (not throw) for an absent ref — `--verify <ref>^{commit}` FAILS when
      // the object/ref is not present in THIS clone (unlike a bare rev-parse of a
      // full sha, which echoes any 40-hex string back), so the commitSha-first
      // binding resolves in exactly one repo. Extracted + unit-tested in
      // ./binding-clone.ts (the file:// URL case guards the remote-URL regression).
      const bindDir = path.join(cfg.worktreeRoot, `bind-${repo.name}.git`);
      const binding = createBindingResolver(repo.path, bindDir);
      const lane: RepoLane = {
        role: repo.role,
        name: repo.name,
        acquire: () => lanePool.acquire(),
        release: (wt) => lanePool.release(wt),
        gitOps: (p) => createGitOps(simpleGit(p)),
        gitlinkPath: repo.gitlinkPath,
        resolveRefInClone: (ref) => binding.resolveRefInClone(ref),
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
              logger.warn({ worktree: p }, "CHAOS: failing outer push once (orphan trigger)");
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

  // ── Phase 7.4 §3.5/§3.6 (Step 12): the health heartbeat. ──
  // The integrator POSTs a heartbeat on a fixed interval REGARDLESS of whether
  // it holds a lock or is idle (the dedicated-channel design, §3.1) — PM tracks
  // last-seen per (project, resource) and raises integrator_unhealthy on a stale
  // beat. This is INDEPENDENT of the lock heartbeat (which only runs during a
  // batch). One boot beat fires immediately so "last heard" is fresh the moment
  // the integrator comes up; the timer then re-beats every heartbeatIntervalSec.
  // Fire-and-forget: a failed heartbeat POST must NEVER break / reject into the
  // loop. We swallow the promise with .catch and never await it.
  const emitHeartbeat = (): void => {
    pmClient
      .postHeartbeat(
        cfg.projectId,
        buildHeartbeat({ resource: cfg.resource, pool, inFlight, version, laneHealth }),
      )
      .catch((e) => logger.warn(`heartbeat post failed: ${String(e)}`));
  };
  emitHeartbeat(); // boot beat
  const heartbeatTimer = setInterval(emitHeartbeat, cfg.heartbeatIntervalSec * 1000);
  heartbeatTimer.unref?.();

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

  const pollIntervalMs = Math.max(1, Number(args.pollIntervalSec ?? "30") || 30) * 1000;

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
      // Phase 7.5 Step 5: the verify_steps DAG (empty → synthetic single step).
      verifySteps: cfg.verifySteps,
      // Phase 7.5 Step 6: the verify-cache kill-switch + mode (default off → the
      // byte-identical no-cache path). Threaded into the single-repo runVerifyTask
      // cache ctx AND the group lane's per-repo ctx (via RunBatchLoopDeps).
      cacheEnabled: cfg.cacheEnabled,
      cacheMode: cfg.cacheMode,
      gitRemote: cfg.gitRemote,
      gitMainBranch: cfg.gitMainBranch,
      groupLane,
      // Phase 7.6.1: gate + budget for the reclaim sweep that recovers
      // `resolving` resolutions stranded by a dead/timed-out resolver session.
      // Off ⇒ no sweep (byte-identical to pre-7.6.1).
      resolverEnabled: cfg.resolver.enabled,
      resolverTimeBudgetSec: cfg.resolver.timeBudgetSec,
      // Phase 7.4 §3.2: the shared in-flight counters the batch + group lane
      // mutate; the heartbeat reads them to mint the in_flight payload + status.
      inFlight,
      // C2: the lane-health state the lock releaser writes + the heartbeat reads.
      laneHealth,
      // Telemetry sink: post each batch marker to the PM relay endpoint. This is
      // a SYNCHRONOUS void handler that swallows its promise — a failed telemetry
      // POST must NEVER reject into / crash the drain loop, so we `.catch` it and
      // never return/await the promise (BatchDeps onBatchEvent is `(e) => void`).
      onBatchEvent: (evt) => {
        pmClient
          .postBatchEvent(cfg.projectId, evt)
          .catch((e) => logger.warn(`batch event post failed: ${String(e)}`));
      },
      // Phase 7.6 §5.1: the conflict-resolution seam. Present ONLY when the
      // resolver is enabled (resolverPool constructed above). The open+enqueue
      // handle opens a PM resolution row then enqueues a job onto the resolver
      // pool; `maybeOpenResolution` wraps the call non-fatally. Absent ⇒ the
      // conflict path is byte-identical to 7.5.
      resolver: resolverPool
        ? ((rp) => ({
            enabled: true as const,
            openAndEnqueue: async (args: {
              originRequestId: string;
              conflictingFiles: string[];
              baseSha: string;
              ref: string;
            }) => {
              const resolution = await pmClient.openResolution(
                cfg.projectId,
                cfg.resource,
                args.originRequestId,
                args.conflictingFiles,
              );
              rp.enqueue({
                resolutionId: resolution.id,
                originRequestId: args.originRequestId,
                conflictingFiles: args.conflictingFiles,
                baseSha: args.baseSha,
                ref: args.ref,
                resource: cfg.resource,
              });
              return resolution.id;
            },
          }))(resolverPool)
        : undefined,
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
  clearInterval(heartbeatTimer); // Phase 7.4 §3.6: no leaked heartbeat timer.
  logger.info("Integrator stopped cleanly");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(
    `integrator-ref fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
