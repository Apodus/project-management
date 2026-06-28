/**
 * Configuration for the triager daemon (Campaign T2).
 *
 * The triager is the escalation responder's machine pointed at NOTES: it watches
 * one or more PROJECTS, and for each it polls
 * `GET /api/v1/projects/{projectId}/notes?status=open` and (in later phases)
 * assesses each open, non-self-authored note oldest-first, recording a triage
 * decision in the append-only side-log. The T2·P2 scaffold stops at a pure-log
 * STUB `decide()` that mutates nothing; P3 adds the assessment brain, P4 the
 * decision execution.
 *
 * Enablement mirrors the auto-implement master: the env `PM_NOTES_TRIAGE_ENABLED`
 * is the daemon-wide MASTER composed (in the loop, per project, per tick) with
 * the per-project DB toggle `project.settings.notesTriage.enabled`. There is NO
 * second `enabled` kill-switch — the master env IS the single switch. It is
 * stored VERBATIM here; `resolveNotesTriage` (from @pm/shared) owns the parse.
 */
import path from "node:path";
import os from "node:os";
import { NOTES_TRIAGE_MODES, type NotesTriageMode } from "@pm/shared";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// Re-export the rollout-mode enum so call sites import the triager's surface
// uniformly (single source of truth is @pm/shared).
export { NOTES_TRIAGE_MODES };
export type { NotesTriageMode };

/** Default headless assessment command (overridable via PM_TRIAGE_COMMAND). */
export const DEFAULT_TRIAGE_COMMAND = "claude -p";

export interface SpawnBudget {
  maxSpawns: number;
  windowSec: number;
}

/**
 * Cost/concurrency budget for the autonomous assessment sessions (shape only in
 * P2; the runner consumes it in P3/P5). Mirrors the responder's per-session
 * budget shape.
 */
export interface CostBudget {
  maxConcurrentSessions: number;
  maxSessionDurationSec: number;
}

export interface TriagerConfig {
  pmUrl: string;
  /** PM API token for the triager's ai_agent identity. REQUIRED. */
  token: string;
  /**
   * Agent-pool secret + stable worker identity (shape only in P2 — read+trimmed
   * but UNUSED; a future phase may auto-claim a pool identity like the MCP
   * server does). Carried now so wiring them later is non-breaking.
   */
  poolSecret?: string;
  workerKey?: string;
  projectIds: string[];
  /**
   * The env master `PM_NOTES_TRIAGE_ENABLED` stored VERBATIM (NOT parsed here):
   * `resolveNotesTriage` owns the master parse (undefined ⇒ master allows;
   * explicit-false ⇒ force OFF for all projects). There is NO separate `enabled`
   * field — this IS the single master kill-switch.
   */
  masterEnv: string | undefined;
  pollIntervalSec: number;
  maxConcurrent: number;
  /** Spawn-rate cap (shape only in P2 — P5 enforces). */
  spawnBudget: SpawnBudget;
  /** Cost/concurrency budget (shape only in P2 — consumed in P3/P5). */
  costBudget: CostBudget;
  /** Per-session wall-clock budget (consumed by the assessment runner in P3). */
  timeBudgetSec: number;
  /** Headless assessment command (PM_TRIAGE_COMMAND || default "claude -p"). */
  command: string;
  /** Directory for per-note status sentinels + logs (OUTSIDE any git tree). */
  logsDir: string;
  logLevel: string;
}

export interface CliArgs {
  pmUrl?: string;
  logLevel?: string;
  pollIntervalSec?: string;
  project?: string[];
}

export interface ConfigEnv {
  PM_API_URL?: string;
  PM_API_TOKEN?: string;
  PM_PROJECT_ID?: string;
  PM_POOL_SECRET?: string;
  PM_WORKER_KEY?: string;
  PM_NOTES_TRIAGE_ENABLED?: string;
  PM_TRIAGE_POLL_INTERVAL_SEC?: string;
  PM_TRIAGE_TIME_BUDGET_SEC?: string;
  PM_TRIAGE_COMMAND?: string;
  PM_TRIAGE_LOGS_DIR?: string;
  PM_LOG_LEVEL?: string;
  [k: string]: string | undefined;
}

const DEFAULT_POLL_INTERVAL_SEC = 15;
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_MAX_SPAWNS = 10;
const DEFAULT_SPAWN_WINDOW_SEC = 3600;
const DEFAULT_TIME_BUDGET_SEC = 900;
const DEFAULT_MAX_CONCURRENT_SESSIONS = 1;
const DEFAULT_MAX_SESSION_DURATION_SEC = 900;

export function loadConfig(args: CliArgs, env: ConfigEnv): TriagerConfig {
  const pmUrl = (args.pmUrl ?? env.PM_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");

  const token = env.PM_API_TOKEN;
  if (!token) {
    throw new ConfigError("PM_API_TOKEN is empty; set it to a valid PM API token");
  }

  // Pool wiring (shape only in P2): read + trim, but UNUSED. A future phase may
  // auto-claim a pool identity (like the MCP server) instead of a static token.
  const poolSecret = env.PM_POOL_SECRET?.trim() || undefined;
  const workerKey = env.PM_WORKER_KEY?.trim() || undefined;

  // Watched projects: explicit --project (repeatable) accumulate; otherwise the
  // single PM_PROJECT_ID. Watch-all is REJECTED — the triager acts on notes, so
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

  // The env master, stored VERBATIM (NOT parsed). `resolveNotesTriage` owns the
  // master parse in the loop, per project, per tick:
  //   undefined      ⇒ master ALLOWS (defer to the per-project DB toggle; the
  //                    default-OFF guarantee lives in the DB default enabled:false)
  //   explicit-false ⇒ force OFF for ALL watched projects.
  // There is NO separate `enabled` field — this IS the single master switch.
  const masterEnv = env.PM_NOTES_TRIAGE_ENABLED;

  const pollIntervalSec = positiveInt(
    args.pollIntervalSec ?? env.PM_TRIAGE_POLL_INTERVAL_SEC,
    DEFAULT_POLL_INTERVAL_SEC,
  );
  const timeBudgetSec = positiveInt(env.PM_TRIAGE_TIME_BUDGET_SEC, DEFAULT_TIME_BUDGET_SEC);

  // Assessment-session wiring (consumed in P3). command: env-or-default; logsDir:
  // where per-note status sentinels + logs land — MUST be OUTSIDE any git tree
  // (defaults to the OS temp dir), so a sentinel never registers as a working-tree
  // change.
  const command = env.PM_TRIAGE_COMMAND || DEFAULT_TRIAGE_COMMAND;
  const logsDir = env.PM_TRIAGE_LOGS_DIR ?? path.join(os.tmpdir(), "pm-triager-logs");

  return {
    pmUrl,
    token,
    poolSecret,
    workerKey,
    projectIds,
    masterEnv,
    pollIntervalSec,
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    spawnBudget: { maxSpawns: DEFAULT_MAX_SPAWNS, windowSec: DEFAULT_SPAWN_WINDOW_SEC },
    costBudget: {
      maxConcurrentSessions: DEFAULT_MAX_CONCURRENT_SESSIONS,
      maxSessionDurationSec: DEFAULT_MAX_SESSION_DURATION_SEC,
    },
    timeBudgetSec,
    command,
    logsDir,
    logLevel: args.logLevel ?? env.PM_LOG_LEVEL ?? "info",
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
