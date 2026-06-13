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
 * In P1 `mode` is PARSED and validated but has NO behavioral branch — it is
 * inert (the loop only ever claims, governed by `enabled`).
 */
export const RESPONDER_MODES = ["off", "shadow", "on"] as const;
export type ResponderMode = (typeof RESPONDER_MODES)[number];

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
  /** off|shadow|on. DEFAULT shadow. Parsed only in P1 (inert). */
  mode: ResponderMode;
  pollIntervalSec: number;
  maxConcurrent: number;
  /** Spawn-rate cap (parse only in P1 — P2 enforces). */
  spawnBudget: SpawnBudget;
  /** Per-session wall-clock budget (parse only in P1 — P2 enforces). */
  timeBudgetSec: number;
  /** Optional per-session token budget (parse only in P1 — P2 surfaces). */
  tokenBudget?: number;
  logLevel: string;
}

export interface CliArgs {
  pmUrl?: string;
  logLevel?: string;
  pollIntervalSec?: string;
  project?: string[];
  enabled?: boolean;
  mode?: string;
}

export interface ConfigEnv {
  PM_API_URL?: string;
  PM_API_TOKEN?: string;
  PM_PROJECT_ID?: string;
  PM_RESPONDER_ENABLED?: string;
  PM_RESPONDER_MODE?: string;
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
