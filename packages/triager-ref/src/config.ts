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
 *
 * ── Per-project CODE REPO (repo-aware assessment) ────────────────────────────
 * To judge whether a note's issue STILL EXISTS, the assessment session must read
 * the WATCHED PROJECT'S code — not the PM checkout. Each watched project is
 * therefore paired with a DEDICATED checkout path via `--project-repo
 * <id>=<path>` (repeatable) / `PM_TRIAGE_PROJECT_REPO` (single). Before every
 * assessment the daemon refreshes that checkout to `repoRef` (default
 * `origin/main`, override `--repo-ref` / `PM_TRIAGE_REPO_REF`) with `git fetch` +
 * `git reset --hard` — so it must be a DEDICATED checkout, never a live working
 * tree. A watched project with NO configured repo is not a config error: it
 * simply resolves `needs_human` (in `decide()`) until a checkout is set up.
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

// Cost discipline = the `maxConcurrent` semaphore (concurrent sessions) + the
// per-session wall-clock `timeBudgetSec` (already wired into the runner). There
// is NO separate cost budget — the two knobs above ARE the cost envelope.

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
  /**
   * Watched-project → DEDICATED-checkout path. The assessment session `cwd`s here
   * (auto-refreshed to `repoRef` first) so the agent reads the PROJECT'S code. A
   * project absent from this map resolves `needs_human` (no blind assessment).
   */
  projectRepos: Map<string, string>;
  /** Git ref the dedicated checkout is refreshed to before each assessment. */
  repoRef: string;
  pollIntervalSec: number;
  maxConcurrent: number;
  /** Spawn-rate cap (enforced in the loop's admission gate, P5). */
  spawnBudget: SpawnBudget;
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
  /** Repeatable `<projectId>=<path>` (dedicated checkout per watched project). */
  projectRepo?: string[];
  /** Git ref the checkouts are refreshed to (default `origin/main`). */
  repoRef?: string;
}

export interface ConfigEnv {
  PM_API_URL?: string;
  PM_API_TOKEN?: string;
  PM_PROJECT_ID?: string;
  PM_POOL_SECRET?: string;
  PM_WORKER_KEY?: string;
  PM_NOTES_TRIAGE_ENABLED?: string;
  PM_TRIAGE_PROJECT_REPO?: string;
  PM_TRIAGE_REPO_REF?: string;
  PM_TRIAGE_POLL_INTERVAL_SEC?: string;
  PM_TRIAGE_TIME_BUDGET_SEC?: string;
  PM_TRIAGE_COMMAND?: string;
  PM_TRIAGE_LOGS_DIR?: string;
  PM_LOG_LEVEL?: string;
  [k: string]: string | undefined;
}

const DEFAULT_REPO_REF = "origin/main";
const DEFAULT_POLL_INTERVAL_SEC = 15;
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_MAX_SPAWNS = 10;
const DEFAULT_SPAWN_WINDOW_SEC = 3600;
const DEFAULT_TIME_BUDGET_SEC = 900;

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

  // Per-project dedicated-checkout paths. Accumulate the env single (if present)
  // then the repeatable CLI entries (CLI wins on a duplicate project id). Each is
  // strictly `<projectId>=<path>`; a malformed entry is a hard ConfigError (a
  // silently-dropped repo would leave a project blind-triaging → needs_human).
  const projectRepos = new Map<string, string>();
  for (const entry of collectRepoEntries(args, env)) {
    const [id, repoPath] = parseProjectRepo(entry);
    projectRepos.set(id, repoPath);
  }
  const repoRef = (args.repoRef ?? env.PM_TRIAGE_REPO_REF)?.trim() || DEFAULT_REPO_REF;

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
    projectRepos,
    repoRef,
    pollIntervalSec,
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    spawnBudget: { maxSpawns: DEFAULT_MAX_SPAWNS, windowSec: DEFAULT_SPAWN_WINDOW_SEC },
    timeBudgetSec,
    command,
    logsDir,
    logLevel: args.logLevel ?? env.PM_LOG_LEVEL ?? "info",
  };
}

/** Gather `<id>=<path>` repo entries: the env single first, then the CLI list. */
function collectRepoEntries(args: CliArgs, env: ConfigEnv): string[] {
  const entries: string[] = [];
  if (env.PM_TRIAGE_PROJECT_REPO) entries.push(env.PM_TRIAGE_PROJECT_REPO);
  if (args.projectRepo) entries.push(...args.projectRepo);
  return entries;
}

/** Parse a strict `<projectId>=<path>` entry; throw ConfigError on any malformity. */
function parseProjectRepo(entry: string): [string, string] {
  const eq = entry.indexOf("=");
  // eq <= 0 catches BOTH a missing `=` (indexOf → -1) and an empty id (`=path`).
  if (eq <= 0) {
    throw new ConfigError(
      `--project-repo / PM_TRIAGE_PROJECT_REPO must be "<projectId>=<path>"; got "${entry}"`,
    );
  }
  const id = entry.slice(0, eq).trim();
  const repoPath = entry.slice(eq + 1).trim();
  if (!id || !repoPath) {
    throw new ConfigError(
      `--project-repo / PM_TRIAGE_PROJECT_REPO must be "<projectId>=<path>" with a non-empty id and path; got "${entry}"`,
    );
  }
  return [id, repoPath];
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
