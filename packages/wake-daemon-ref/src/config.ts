import { readFileSync } from "node:fs";

/**
 * Configuration for the wake daemon (Campaign C2 P2).
 *
 * The daemon watches one or more `(workerKey[, projectId])` pairs. For each it
 * polls `GET /api/v1/escalations/undelivered?worker_key=K[&project_id=P]` and,
 * when a watched worker has unread directed replies, spawns a fresh client
 * worker turn (default `claude -p`) seeded with the reply so the worker can read
 * the thread and act — then advances the delivery cursor via mark-delivered.
 *
 * Zero-config: a single worker just sets `PM_WORKER_KEY` (+ a PM token); the
 * daemon auto-derives a single watch entry from it. `--watch <key>[:<projectId>]`
 * (repeatable) or `--config <file>` ({ watch: [...] }) cover multi-worker hosts.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** A single thing the daemon watches: a worker key, optionally project-scoped. */
export interface WatchEntry {
  workerKey: string;
  /** Narrow the undelivered query to one project; absent ⇒ all projects. */
  projectId?: string;
}

export interface WakeDaemonConfig {
  pmUrl: string;
  token: string;
  watch: WatchEntry[];
  pollIntervalSec: number;
  workerCommand: string;
  workerCwd: string;
  timeBudgetSec: number;
  tokenBudget?: number;
  maxConcurrentWakes: number;
  minWakeIntervalSec: number;
  /**
   * BINDING ADDITION 1 — the per-escalation give-up threshold. After this many
   * consecutive wake failures for one escalation (without its unread maxSeq
   * advancing) the daemon PARKS it: no further spawns until a new reply arrives.
   * Prevents the infinite-spawn storm a missing/misconfigured `claude` binary
   * would otherwise cause (the daemon has no terminal reject sink).
   */
  maxConsecutiveFailures: number;
  logLevel: string;
  promptTemplate: string;
}

export interface CliArgs {
  pmUrl?: string;
  token?: string;
  logLevel?: string;
  pollIntervalSec?: string;
  watch?: string[];
  config?: string;
}

export interface ConfigEnv {
  PM_API_URL?: string;
  PM_API_TOKEN?: string;
  PM_WORKER_KEY?: string;
  PM_PROJECT_ID?: string;
  PM_LOG_LEVEL?: string;
  PM_WAKE_WORKER_COMMAND?: string;
  PM_WAKE_PROMPT?: string;
  [k: string]: string | undefined;
}

/**
 * The built-in wake prompt. `{escalation}` and `{messages}` are substituted (the
 * prompt module fills them); a custom `PM_WAKE_PROMPT` may omit either placeholder
 * (substitution is replace-if-present).
 */
export const DEFAULT_WAKE_PROMPT = [
  "You are a software worker being re-woken because a human (or another worker) has",
  "replied to an escalation YOU raised. The escalation thread is below. Read it in",
  "full, then act on it using your own PM MCP tools: post a reply (pm_add_comment /",
  "the escalation reply tool), make any change the instruction calls for, and",
  "resolve the escalation when the matter is settled. Do NOT raise a new escalation",
  "for this — continue the existing thread.",
  "",
  "{escalation}",
  "",
  "Unread replies you have not yet seen:",
  "{messages}",
].join("\n");

const DEFAULT_POLL_INTERVAL_SEC = 15;
const DEFAULT_WORKER_COMMAND = "claude -p";
const DEFAULT_TIME_BUDGET_SEC = 900;
const DEFAULT_MAX_CONCURRENT_WAKES = 1;
const DEFAULT_MIN_WAKE_INTERVAL_SEC = 60;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

function parseWatchSpec(spec: string): WatchEntry {
  // `<key>[:<projectId>]`. A project id (ULID) never contains a colon, so a
  // single split on the FIRST colon is unambiguous.
  const idx = spec.indexOf(":");
  if (idx === -1) return { workerKey: spec };
  const workerKey = spec.slice(0, idx);
  const projectId = spec.slice(idx + 1);
  return projectId ? { workerKey, projectId } : { workerKey };
}

export function loadConfig(args: CliArgs, env: ConfigEnv): WakeDaemonConfig {
  const pmUrl = (args.pmUrl ?? env.PM_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");

  const token = env.PM_API_TOKEN;
  if (!token) {
    // Pool-claim is optional / can be deferred; a static token is the floor for
    // P2. Fatal so the operator notices immediately rather than silently never
    // delivering.
    throw new ConfigError("PM_API_TOKEN is empty; set it to a valid PM API token");
  }

  // Watch entries: explicit --config / --watch take precedence; otherwise auto
  // from PM_WORKER_KEY (+ optional PM_PROJECT_ID). Multiple sources accumulate.
  const watch: WatchEntry[] = [];
  if (args.config) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(args.config, "utf8"));
    } catch (err) {
      throw new ConfigError(
        `failed to read --config ${args.config}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const arr = (parsed as { watch?: unknown }).watch;
    if (!Array.isArray(arr)) {
      throw new ConfigError(`--config ${args.config} must contain a "watch" array`);
    }
    for (const e of arr) {
      const we = e as { workerKey?: unknown; projectId?: unknown };
      if (typeof we.workerKey !== "string" || we.workerKey.length === 0) {
        throw new ConfigError(`--config watch entries require a non-empty "workerKey"`);
      }
      watch.push({
        workerKey: we.workerKey,
        projectId: typeof we.projectId === "string" && we.projectId ? we.projectId : undefined,
      });
    }
  }
  if (args.watch) {
    for (const spec of args.watch) {
      if (spec.length > 0) watch.push(parseWatchSpec(spec));
    }
  }
  if (watch.length === 0 && env.PM_WORKER_KEY) {
    watch.push({
      workerKey: env.PM_WORKER_KEY,
      projectId: env.PM_PROJECT_ID || undefined,
    });
  }
  if (watch.length === 0) {
    throw new ConfigError(
      "no worker key to watch: set PM_WORKER_KEY, or pass --watch <key>[:<projectId>] / --config <file>",
    );
  }

  const pollIntervalSec = positiveInt(args.pollIntervalSec, DEFAULT_POLL_INTERVAL_SEC);

  return {
    pmUrl,
    token,
    watch,
    pollIntervalSec,
    workerCommand: env.PM_WAKE_WORKER_COMMAND || DEFAULT_WORKER_COMMAND,
    workerCwd: process.cwd(),
    timeBudgetSec: DEFAULT_TIME_BUDGET_SEC,
    tokenBudget: undefined,
    maxConcurrentWakes: DEFAULT_MAX_CONCURRENT_WAKES,
    minWakeIntervalSec: DEFAULT_MIN_WAKE_INTERVAL_SEC,
    maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
    logLevel: args.logLevel ?? env.PM_LOG_LEVEL ?? "info",
    promptTemplate: env.PM_WAKE_PROMPT || DEFAULT_WAKE_PROMPT,
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
