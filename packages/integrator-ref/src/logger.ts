import { createWriteStream, renameSync, statSync } from "node:fs";
import path from "node:path";
import pino from "pino";

export type Logger = pino.Logger;

// ─── Daemon log file ──────────────────────────────────────────────
//
// The daemon logs to stdout, which the supervisor inherits into whatever
// console launched it — so when the console is gone, so is the evidence. On
// 2026-08-03 diagnosing a nine-hour lane wedge (§14.15) meant reconstructing
// the daemon's behavior from PM's activity_log, because the process that KNEW
// what it was doing had written it only to a scrollback buffer nobody had.
//
// So the daemon now also writes its own log file, next to the bundle by
// default. This is deliberately the daemon's job rather than the supervisor's:
// the log then exists however the daemon was launched (supervised, bare
// `run_daemon.bat`, or by hand), and needs no console-capture plumbing in a
// PowerShell script whose only real job is keeping the process alive.

/** Rotate at 20 MB — one generation back. Small enough to open, big enough to hold a bad night. */
const MAX_LOG_BYTES = 20 * 1024 * 1024;

/**
 * Resolve the daemon's log path: `PM_INTEGRATOR_LOG_FILE` if set, else
 * `daemon.log` beside the running bundle. `PM_INTEGRATOR_LOG_FILE=""`
 * (explicitly empty) disables the file sink — stdout only, the pre-2026-08-03
 * behavior.
 *
 * Called by the daemon entry point (`index.ts`) ONLY, and passed explicitly to
 * `createLogger`. Tests and library consumers call `createLogger(level)` with no
 * file and stay stdout-only — otherwise every vitest run would drop a
 * `daemon.log` next to the test runner's entry script.
 */
export function resolveDaemonLogFile(): string | null {
  const configured = process.env.PM_INTEGRATOR_LOG_FILE;
  if (configured !== undefined) return configured.trim() === "" ? null : configured;
  // process.argv[1] is the bundle/entry path under every documented launcher.
  const entry = process.argv[1];
  if (!entry) return null;
  return path.join(path.dirname(entry), "daemon.log");
}

/** Roll `<file>` → `<file>.1` once it passes the cap. Best-effort: a failure here must never stop the daemon. */
function rotateIfLarge(file: string): void {
  try {
    if (statSync(file).size >= MAX_LOG_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // No file yet, or a locked/undeletable previous generation — either way,
    // appending is still fine.
  }
}

export function createLogger(level: string = "info", logFile?: string | null): Logger {
  const opts: pino.LoggerOptions = {
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  const file = logFile ?? null;
  if (!file) return pino(opts);

  try {
    rotateIfLarge(file);
    // Tee: the console keeps its live output AND the file keeps the history.
    const streams: pino.StreamEntry[] = [
      { level: level as pino.Level, stream: process.stdout },
      { level: level as pino.Level, stream: createWriteStream(file, { flags: "a" }) },
    ];
    return pino(opts, pino.multistream(streams));
  } catch {
    // An unwritable log path must never prevent the daemon from running.
    return pino(opts);
  }
}
