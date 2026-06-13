/**
 * Configuration for the responder daemon (Campaign C3).
 *
 * The responder watches one or more PROJECTS. For each it polls
 * `GET /api/v1/projects/{projectId}/escalations?status=open` and CLAIMS each
 * open, client-authored, unheld escalation via
 * `POST /api/v1/escalations/{id}/acknowledge` (the C1 one-active-responder gate:
 * an ai_agent acking an unclaimed open escalation auto-claims it; a 403 means
 * another responder already holds it). The C3 P1 skeleton stops at the claim —
 * P2 adds the headless claude spawn that reads the thread, answers, and resolves.
 *
 * Unlike the wake daemon (which watches worker keys for the dormant-worker
 * DELIVERY path), the responder is PROJECT-scoped and is the AUTONOMOUS answerer:
 * it picks up escalations no live worker has taken.
 */
import path from "node:path";
import os from "node:os";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * The responder's mode. Note: `off` is NOT the same as `enabled=false`.
 * `enabled` is the kill-switch (idle the process entirely); `mode` selects the
 * answering behavior (`off`/`shadow`/`on`) and only acquires meaning in P3/P5.
 * As of P3, `mode` is CONSUMED: at `on` the responder posts the answering
 * session's outcome (answer / escalate-to-human); at `off`/`shadow` it spawns
 * and logs the outcome but never posts (the clean P5 shadow-handling seam).
 */
export const RESPONDER_MODES = ["off", "shadow", "on"] as const;
export type ResponderMode = (typeof RESPONDER_MODES)[number];

/** Default headless answering command (overridable via PM_RESPONDER_COMMAND). */
export const DEFAULT_RESPONDER_COMMAND = "claude -p";

export interface SpawnBudget {
  maxSpawns: number;
  windowSec: number;
}

export interface ResponderConfig {
  pmUrl: string;
  token: string;
  projectIds: string[];
  /** Kill-switch. DEFAULT FALSE — the operator must opt in. */
  enabled: boolean;
  /** off|shadow|on. DEFAULT shadow. Consumed in P3 (gates the POST). */
  mode: ResponderMode;
  pollIntervalSec: number;
  maxConcurrent: number;
  /** Spawn-rate cap (parse only in P1 — P5 enforces). */
  spawnBudget: SpawnBudget;
  /** Per-session wall-clock budget (consumed by the runner). */
  timeBudgetSec: number;
  /** Optional per-session token budget (surfaced to the runner). */
  tokenBudget?: number;
  /** Headless answering command (PM_RESPONDER_COMMAND || default "claude -p"). */
  command: string;
  /** Working directory the answering session runs in (the PM repo checkout). */
  repoCwd: string;
  /** Directory for per-escalation status sentinels + logs (OUTSIDE any git tree). */
  logsDir: string;
  logLevel: string;
}

export interface CliArgs {
  pmUrl?: string;
  logLevel?: string;
  pollIntervalSec?: string;
  project?: string[];
  enabled?: boolean;
  mode?: string;
  repoCwd?: string;
}

export interface ConfigEnv {
  PM_API_URL?: string;
  PM_API_TOKEN?: string;
  PM_PROJECT_ID?: string;
  PM_RESPONDER_ENABLED?: string;
  PM_RESPONDER_MODE?: string;
  PM_RESPONDER_COMMAND?: string;
  PM_RESPONDER_REPO_CWD?: string;
  PM_RESPONDER_LOGS_DIR?: string;
  PM_LOG_LEVEL?: string;
  [k: string]: string | undefined;
}

const DEFAULT_POLL_INTERVAL_SEC = 15;
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_MAX_SPAWNS = 10;
const DEFAULT_SPAWN_WINDOW_SEC = 3600;
const DEFAULT_TIME_BUDGET_SEC = 900;

export function loadConfig(args: CliArgs, env: ConfigEnv): ResponderConfig {
  const pmUrl = (args.pmUrl ?? env.PM_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");

  const token = env.PM_API_TOKEN;
  if (!token) {
    throw new ConfigError("PM_API_TOKEN is empty; set it to a valid PM API token");
  }

  // Watched projects: explicit --project (repeatable) accumulate; otherwise the
  // single PM_PROJECT_ID. Watch-all is REJECTED — the responder claims work, so
  // it must be scoped to projects the operator has opted in.
  const projectIds: string[] = [];
  if (args.project) {
    for (const id of args.project) {
      if (id.length > 0) projectIds.push(id);
    }
  }
  if (projectIds.length === 0 && env.PM_PROJECT_ID) {
    projectIds.push(env.PM_PROJECT_ID);
  }
  if (projectIds.length === 0) {
    throw new ConfigError(
      "no project to watch: set PM_PROJECT_ID, or pass --project <id> (repeatable). Watch-all is not allowed.",
    );
  }

  // enabled: DEFAULT FALSE. CLI --enabled (a present flag ⇒ true) overrides env.
  // PM_RESPONDER_ENABLED accepts 1/true/yes/on (case-insensitive).
  let enabled = false;
  if (args.enabled !== undefined) {
    enabled = args.enabled;
  } else if (env.PM_RESPONDER_ENABLED !== undefined) {
    enabled = parseBool(env.PM_RESPONDER_ENABLED);
  }

  // mode: DEFAULT shadow. Validate against the enum (else ConfigError). Parsed
  // only in P1 — no behavioral branch (see the ResponderMode doc above).
  const rawMode = args.mode ?? env.PM_RESPONDER_MODE ?? "shadow";
  if (!(RESPONDER_MODES as readonly string[]).includes(rawMode)) {
    throw new ConfigError(
      `invalid mode "${rawMode}"; expected one of ${RESPONDER_MODES.join("|")}`,
    );
  }
  const mode = rawMode as ResponderMode;

  const pollIntervalSec = positiveInt(args.pollIntervalSec, DEFAULT_POLL_INTERVAL_SEC);

  // Answering-session wiring (P3). command: env-or-default; repoCwd: the PM repo
  // the read-only diagnostic session runs in (defaults to the daemon's cwd);
  // logsDir: where per-escalation status sentinels + logs land — MUST be OUTSIDE
  // any git tree (defaults to the OS temp dir), so a sentinel never registers as
  // a working-tree change.
  const command = env.PM_RESPONDER_COMMAND || DEFAULT_RESPONDER_COMMAND;
  const repoCwd = args.repoCwd ?? env.PM_RESPONDER_REPO_CWD ?? process.cwd();
  const logsDir = env.PM_RESPONDER_LOGS_DIR ?? path.join(os.tmpdir(), "pm-responder-logs");

  return {
    pmUrl,
    token,
    projectIds,
    enabled,
    mode,
    pollIntervalSec,
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    spawnBudget: { maxSpawns: DEFAULT_MAX_SPAWNS, windowSec: DEFAULT_SPAWN_WINDOW_SEC },
    timeBudgetSec: DEFAULT_TIME_BUDGET_SEC,
    tokenBudget: undefined,
    command,
    repoCwd,
    logsDir,
    logLevel: args.logLevel ?? env.PM_LOG_LEVEL ?? "info",
  };
}

function parseBool(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
