import { Command } from "commander";
import { ConfigError, loadConfig, type CliArgs } from "./config.js";
import { WakeClient } from "./api-client.js";
import { createLogger } from "./logger.js";
import { createClaudeWorkerRunner } from "./worker-runner.js";
import { runWakeLoop } from "./loop.js";
import { VERSION } from "./version.js";

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

async function main(): Promise<void> {
  const program = new Command()
    .name("pm-wake-daemon")
    .description("Reference wake daemon for the PM escalation channel")
    .version(VERSION)
    .option("--pm-url <url>", "PM API base URL")
    .option("--log-level <level>", "pino log level (trace|debug|info|warn|error|fatal)")
    .option("--poll-interval-sec <sec>", "Polling interval in seconds", "15")
    .option(
      "--watch <key[:projectId]>",
      "Worker key to watch (repeatable); optional :projectId scopes it",
      collect,
      [] as string[],
    )
    .option("--config <file>", "JSON config file with a { watch: [...] } array")
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

  logger.info(
    {
      version: VERSION,
      pmUrl: cfg.pmUrl,
      watch: cfg.watch,
      pollIntervalSec: cfg.pollIntervalSec,
      workerCommand: cfg.workerCommand,
      maxConcurrentWakes: cfg.maxConcurrentWakes,
    },
    "Wake daemon ready",
  );
  process.stdout.write(`Wake daemon ready, watching ${cfg.watch.length} worker key(s)\n`);

  const client = new WakeClient({ baseUrl: cfg.pmUrl, token: cfg.token });
  const runner = createClaudeWorkerRunner();

  // ── Shutdown handling. ──
  let stopRequested = false;
  let wakeWaiter: (() => void) | undefined;
  const requestStop = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "Wake daemon shutting down");
    stopRequested = true;
    wakeWaiter?.();
  };
  process.on("SIGTERM", () => requestStop("SIGTERM"));
  process.on("SIGINT", () => requestStop("SIGINT"));

  await runWakeLoop(
    {
      client,
      runner,
      logger,
      watch: cfg.watch,
      workerCommand: cfg.workerCommand,
      workerCwd: cfg.workerCwd,
      timeBudgetSec: cfg.timeBudgetSec,
      tokenBudget: cfg.tokenBudget,
      maxConcurrentWakes: cfg.maxConcurrentWakes,
      minWakeIntervalSec: cfg.minWakeIntervalSec,
      maxConsecutiveFailures: cfg.maxConsecutiveFailures,
      promptTemplate: cfg.promptTemplate,
      shouldContinue: () => !stopRequested,
      waitForWork: (pollMs: number) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, pollMs);
          t.unref?.();
          wakeWaiter = () => {
            clearTimeout(t);
            resolve();
          };
        }),
    },
    { pollIntervalMs: cfg.pollIntervalSec * 1000 },
  );

  logger.info("Wake daemon stopped cleanly");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(
    `wake-daemon-ref fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
