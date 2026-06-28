import { mkdir } from "node:fs/promises";
import { Command } from "commander";
import { resolveNotesTriage } from "@pm/shared";
import { ConfigError, loadConfig, type CliArgs } from "./config.js";
import { TriagerClient } from "./api-client.js";
import { createLogger } from "./logger.js";
import { runTriagerLoop } from "./loop.js";
import { createClaudeInjectionSniffer } from "./injection-sniffer.js";
import { createClaudeAssessmentRunner } from "./assessment-runner.js";
import { createTriageDecide } from "./decide.js";
import { VERSION } from "./version.js";

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

async function main(): Promise<void> {
  const program = new Command()
    .name("pm-triager")
    .description("Reference triager daemon for the PM notes inbox")
    .version(VERSION)
    .option("--pm-url <url>", "PM API base URL")
    .option("--log-level <level>", "pino log level (trace|debug|info|warn|error|fatal)")
    .option("--poll-interval-sec <sec>", "Polling interval in seconds")
    .option("--project <id>", "Project id to watch (repeatable)", collect, [] as string[])
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
      logger.fatal(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to load config",
      );
    }
    // Code 2 = config/validation failure (systemd: don't restart). Code 1 is
    // reserved for unexpected runtime errors.
    process.exit(2);
    return;
  }

  const client = new TriagerClient({ baseUrl: cfg.pmUrl, token: cfg.token });

  // ── Global master kill-switch gate (GUARDRAIL 1). ──
  // PM_NOTES_TRIAGE_ENABLED is the single daemon-wide master. UNSET ⇒ allows
  // (the daemon RUNS — each project's DB toggle gates it, default OFF ⇒ ships
  // off); explicit-false ⇒ exit 0 (clean, never enter the loop, never mkdir,
  // never resolve identity). We probe the master ALONE by passing a settings
  // block whose per-project toggle is `enabled:true` — so `.enabled` reflects
  // ONLY the master decision (NOT a real project's toggle). ⚠️ The settings arg
  // MUST be `{ notesTriage: { enabled: true } }`: resolveNotesTriage reads
  // `settings.notesTriage.enabled`; the unwrapped `{ enabled: true }` would yield
  // enabled=false and the daemon would ALWAYS exit.
  const masterAllows = resolveNotesTriage(cfg.masterEnv, {
    notesTriage: { enabled: true },
  }).enabled;
  if (!masterAllows) {
    logger.info(
      { version: VERSION, projectIds: cfg.projectIds },
      "Notes triage disabled (PM_NOTES_TRIAGE_ENABLED=false); idling",
    );
    process.stdout.write("Notes triage disabled (PM_NOTES_TRIAGE_ENABLED=false); idling\n");
    process.exit(0);
    return;
  }

  // ── Assessment-session wiring. ──
  // Ensure the sentinel/log directory exists (AFTER the master gate, so a
  // master-disabled process never mkdirs). It lives OUTSIDE any git tree.
  await mkdir(cfg.logsDir, { recursive: true });

  // ── Resolve self identity (no-self-triage seed). ──
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

  // P3: the real decide seam — a cheap injection sniff GATES a bounded assessment
  // session that PRODUCES a structured decision. The decision is RETURNED but the
  // loop still ignores it (execution / recording / mode-gating is P4).
  const sniffer = createClaudeInjectionSniffer({ command: cfg.command });
  const runner = createClaudeAssessmentRunner({ command: cfg.command });
  const decide = createTriageDecide({
    sniffer,
    runner,
    logsDir: cfg.logsDir,
    command: cfg.command,
    budget: { timeBudgetSec: cfg.timeBudgetSec },
    logger,
  });

  logger.info(
    {
      version: VERSION,
      pmUrl: cfg.pmUrl,
      projectIds: cfg.projectIds,
      pollIntervalSec: cfg.pollIntervalSec,
      maxConcurrent: cfg.maxConcurrent,
      selfId,
    },
    "Triager daemon ready",
  );
  process.stdout.write(`Triager daemon ready, watching ${cfg.projectIds.length} project(s)\n`);

  // ── Shutdown handling. ──
  let stopRequested = false;
  let pollWaiter: (() => void) | undefined;
  const requestStop = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "Triager daemon shutting down");
    stopRequested = true;
    pollWaiter?.();
  };
  process.on("SIGTERM", () => requestStop("SIGTERM"));
  process.on("SIGINT", () => requestStop("SIGINT"));

  await runTriagerLoop(
    {
      client,
      logger,
      projectIds: cfg.projectIds,
      selfId,
      masterEnv: cfg.masterEnv,
      maxConcurrent: cfg.maxConcurrent,
      spawnBudget: cfg.spawnBudget,
      decide,
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

  logger.info("Triager daemon stopped cleanly");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`triager-ref fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
