/**
 * The drive runner (Campaign A3 P1).
 *
 * The vision-producing counterpart to the bounded implement runner. For an
 * `implement{systemic}` disposition, it spawns a fresh headless client turn
 * (default `claude -p`) seeded with the drive prompt so the agent investigates the
 * escalation, follows the /vision methodology, WRITES a vision `.md` INSIDE the
 * isolated worktree, and declares via a status sentinel — bounded by a wall-clock
 * time budget. ONE attempt, no retry. NO campaign execution (that's P2).
 *
 * The session runs with `cwd = input.worktreePath` — the worktree CLONE, never the
 * live repo / `main`. The runner is the INJECTABLE seam: tests pass a fake (or a
 * real `node <script>.cjs` agent stub) so no real Claude binary is needed;
 * production wires `createClaudeDriveRunner`. The spawn + SIGTERM→SIGKILL kill path
 * (via `killTree`, NOT `child.kill`, because Windows needs `taskkill /T /F`) and the
 * strict post-exit precedence are transplanted VERBATIM from the implement runner;
 * only the contract differs: a distinct `PM_DRIVE_STATUS_PATH` sentinel env var, a
 * `vision_ready`/`give_up` two-state, and — instead of the implement runner's git
 * commit cross-check — a FILE-ON-DISK SEAL.
 *
 * FILE-ON-DISK SEAL (load-bearing) — mirrors the implement runner's "NEVER infer
 * branch_ready from a clean tree". A `vision_ready` outcome is NEVER inferred from
 * the sentinel alone. The runner SHAPE-VALIDATES the sentinel (a non-empty
 * visionPath + epicName + ≥1 campaign each with a non-empty title), then resolves
 * the declared `visionPath` against the worktree, rejects any path escaping the
 * worktree (absolute or `..`-traversing), and confirms `fs.stat(abs).isFile()`. A
 * vision_ready with no real file on disk falls through to `error{spawn_error}`. The
 * drive writes a file, it NEVER commits — so there is NO git cross-check here.
 *
 * Post-exit verdict precedence is STRICT (see `finish`):
 *   1. timeout      ⇒ {kind:"error", reason:"timeout"}
 *   2. spawn_error  ⇒ {kind:"error", reason:"spawn_error"}
 *   3. sentinel     ⇒ vision_ready (shape-validated + file-on-disk sealed) | give_up
 *   4. fallback     ⇒ absent / unparseable / unrecognized ⇒ {kind:"error",
 *                     reason:"spawn_error"}. vision_ready is NEVER inferred.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PRIORITIES, type Priority } from "@pm/shared";
import type { Escalation, EscalationMessage } from "@pm/shared";
import { killTree } from "./kill-tree.js";

export interface DriveRunInput {
  /** The (systemic) escalation this session is producing a vision for. */
  escalation: Escalation;
  /** The ordered escalation thread (context for the prompt). */
  thread: EscalationMessage[];
  /**
   * The isolated worktree clone the session runs in (its cwd). NEVER the live
   * repo / main — the vision `.md` is written here.
   */
  worktreePath: string;
  budget: { timeBudgetSec: number; tokenBudget?: number };
  command: string;
  /** The fully-substituted drive prompt fed to the agent on stdin. */
  prompt: string;
  /**
   * Absolute path where the agent writes its status sentinel JSON. Injected into
   * the agent's env as `PM_DRIVE_STATUS_PATH` (DISTINCT from PM_IMPLEMENT_STATUS_PATH
   * / PM_RESPONDER_STATUS_PATH). This path MUST live OUTSIDE the worktree so the
   * sentinel never registers as a working-tree change. The runner deletes any stale
   * file here before spawning.
   */
  statusPath: string;
  logPath: string;
  /** External-cancel seam: abort kills the worker tree. */
  signal?: AbortSignal;
}

/**
 * One campaign of the produced vision's breakdown. `title` is required + non-empty;
 * `priority` is a PRIORITIES member (clamped to "medium" when the sentinel's value
 * is unrecognized); `description` is coerced to a string.
 */
export interface DriveCampaignSpec {
  title: string;
  priority: Priority;
  description: string;
}

/**
 * The drive-session outcome:
 *   - `vision_ready` — the agent wrote a vision file, SHAPE-VALIDATED + FILE-ON-DISK
 *     sealed. `visionPath` is the normalized worktree-relative path (forward slashes).
 *   - `give_up`      — the agent could not produce a vision and bowed out.
 *   - `error`        — the session itself failed: a `timeout`, a `spawn_error`, or a
 *     `vision_ready` that failed the shape validation / the file-on-disk seal.
 */
export type DriveRunResult =
  | {
      kind: "vision_ready";
      visionPath: string;
      epicName: string;
      campaigns: DriveCampaignSpec[];
      durationMs: number;
      tokensConsumed?: number;
    }
  | { kind: "give_up"; reason: string; durationMs: number }
  | {
      kind: "error";
      reason: "timeout" | "spawn_error";
      durationMs: number;
      detail?: string;
    };

export interface DriveRunner {
  run(input: DriveRunInput): Promise<DriveRunResult>;
}

const DEFAULT_DRIVE_COMMAND = "claude -p";
const DEFAULT_KILL_GRACE_MS = 5000;

/** Clamp a sentinel-declared priority to a PRIORITIES member (default "medium"). */
function clampPriority(value: unknown): Priority {
  return typeof value === "string" && (PRIORITIES as readonly string[]).includes(value)
    ? (value as Priority)
    : "medium";
}

/**
 * Shape-validate + coerce the sentinel's `campaigns` array into DriveCampaignSpec[].
 * Returns null when it is not an array, is empty, or any member has an empty title
 * (the caller maps that to error{spawn_error, "vision_ready sentinel malformed"}).
 * Each member's priority is clamped to a PRIORITIES member and description coerced.
 */
function validateCampaigns(value: unknown): DriveCampaignSpec[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: DriveCampaignSpec[] = [];
  for (const raw of value) {
    const c = raw as { title?: unknown; priority?: unknown; description?: unknown };
    if (typeof c.title !== "string" || c.title.length === 0) return null;
    out.push({
      title: c.title,
      priority: clampPriority(c.priority),
      description: typeof c.description === "string" ? c.description : String(c.description ?? ""),
    });
  }
  return out;
}

/**
 * FILE-ON-DISK SEAL: resolve the declared `visionPath` against the worktree, reject
 * any path escaping it (absolute or `..`-traversing), and confirm it is a real file.
 * Returns the normalized worktree-relative path (forward slashes) on success, or null
 * on any escape / stat throw / not-a-file (vision_ready is never trusted on
 * uncertainty — the caller maps null to error{spawn_error}).
 */
async function sealVisionFile(worktreePath: string, visionPath: string): Promise<string | null> {
  const abs = path.resolve(worktreePath, visionPath);
  const rel = path.relative(worktreePath, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    const s = await stat(abs);
    if (!s.isFile()) return null;
  } catch {
    return null;
  }
  return rel.split(path.sep).join("/");
}

/**
 * Default runner: spawn the headless vision-producing agent with the drive prompt in
 * the isolated worktree. Transplants the implement runner's spawn + timeout +
 * SIGTERM→SIGKILL(killTree) lifecycle VERBATIM; the differences are the
 * PM_DRIVE_STATUS_PATH sentinel env var and the vision file-on-disk seal (in place
 * of the git commit cross-check).
 */
export function createClaudeDriveRunner(cfg: { command?: string }): DriveRunner {
  return {
    async run(input: DriveRunInput): Promise<DriveRunResult> {
      const command = input.command ?? cfg.command ?? DEFAULT_DRIVE_COMMAND;
      const start = Date.now();
      const timeoutMs = input.budget.timeBudgetSec * 1000;

      // Delete any stale sentinel from a prior run BEFORE spawning, so a leftover
      // `vision_ready` can never be mistaken for THIS run's declaration.
      // `force: true` ⇒ no-throw when the file is absent.
      await rm(input.statusPath, { force: true });

      return new Promise<DriveRunResult>((resolve) => {
        const logStream = createWriteStream(input.logPath, { flags: "a" });

        // The agent declares its outcome by writing this JSON file; inject the
        // path. An optional token budget is surfaced for the agent to honor.
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (input.budget.tokenBudget !== undefined) {
          env.PM_DRIVE_TOKEN_BUDGET = String(input.budget.tokenBudget);
        }
        env.PM_DRIVE_STATUS_PATH = input.statusPath;

        const child = spawn(command, {
          shell: true,
          cwd: input.worktreePath,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          env,
        });

        let timedOut = false;
        let spawnErrored = false;
        let spawnErrorMsg: string | undefined;
        let settled = false;
        let sigkillTimer: NodeJS.Timeout | undefined;

        const onAbort = (): void => {
          if (child.pid !== undefined) killTree(child.pid, "SIGTERM");
        };
        const signal = input.signal;
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        child.stdout?.on("data", (d: Buffer) => logStream.write(d));
        child.stderr?.on("data", (d: Buffer) => logStream.write(d));

        // Feed the drive prompt then close stdin so the agent runs headless.
        try {
          child.stdin?.write(input.prompt);
          child.stdin?.end();
        } catch {
          /* stdin may be closed if the child already failed to spawn */
        }

        const timeout = setTimeout(() => {
          timedOut = true;
          if (child.pid !== undefined) {
            killTree(child.pid, "SIGTERM");
            sigkillTimer = setTimeout(() => {
              if (child.pid !== undefined) killTree(child.pid, "SIGKILL");
            }, DEFAULT_KILL_GRACE_MS);
            sigkillTimer.unref?.();
          }
        }, timeoutMs);
        timeout.unref?.();

        // Post-exit verdict in STRICT precedence:
        //   1. timeout      — REGARDLESS of any sentinel/file written before the kill.
        //   2. spawn_error  — the child never really ran.
        //   3. sentinel     — vision_ready (shape-validated + file-sealed) / give_up.
        //   4. fallback     — no trustworthy declaration (absent / unparseable /
        //                     unrecognized) ⇒ a spawn_error-classed error.
        //                     vision_ready is NEVER inferred from a clean exit, and a
        //                     vision_ready sentinel with no real file on disk ALSO
        //                     falls through to spawn_error.
        const finish = async (): Promise<DriveRunResult> => {
          const durationMs = Date.now() - start;
          if (timedOut) {
            return { kind: "error", reason: "timeout", durationMs };
          }
          if (spawnErrored) {
            return {
              kind: "error",
              reason: "spawn_error",
              durationMs,
              detail: spawnErrorMsg,
            };
          }

          // The agent's status sentinel is the ONLY source of vision_ready/give_up.
          // A read/parse throw must NOT reject the run — fall through to fallback.
          try {
            const raw = await readFile(input.statusPath, "utf8");
            const parsed = JSON.parse(raw) as {
              status?: unknown;
              visionPath?: unknown;
              epicName?: unknown;
              campaigns?: unknown;
              reason?: unknown;
            };
            if (parsed.status === "vision_ready") {
              // (1) SHAPE VALIDATE — never infer vision_ready from the sentinel
              // alone. A non-empty visionPath + epicName + ≥1 campaign each with a
              // non-empty title.
              const campaigns = validateCampaigns(parsed.campaigns);
              if (
                typeof parsed.visionPath !== "string" ||
                parsed.visionPath.length === 0 ||
                typeof parsed.epicName !== "string" ||
                parsed.epicName.length === 0 ||
                campaigns === null
              ) {
                return {
                  kind: "error",
                  reason: "spawn_error",
                  durationMs,
                  detail: "vision_ready sentinel malformed",
                };
              }
              // (2) FILE-ON-DISK SEAL — resolve against the worktree, reject an
              // escaping path, confirm a real file. Use the normalized worktree-
              // relative path (forward slashes), never the raw sentinel value.
              const sealed = await sealVisionFile(input.worktreePath, parsed.visionPath);
              if (sealed === null) {
                return {
                  kind: "error",
                  reason: "spawn_error",
                  durationMs,
                  detail: "vision_ready declared but no vision file on disk",
                };
              }
              return {
                kind: "vision_ready",
                visionPath: sealed,
                epicName: parsed.epicName,
                campaigns,
                durationMs,
              };
            }
            if (parsed.status === "give_up") {
              return {
                kind: "give_up",
                reason: String(parsed.reason ?? "give_up"),
                durationMs,
              };
            }
            // Recognized file but no usable status → fall through.
          } catch {
            // Absent / unreadable / unparseable sentinel → fall through.
          }

          // Fallback: no trustworthy declaration. Treated as a failed session.
          return {
            kind: "error",
            reason: "spawn_error",
            durationMs,
            detail: "status sentinel absent or unrecognized",
          };
        };

        const settle = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (sigkillTimer) clearTimeout(sigkillTimer);
          if (signal) signal.removeEventListener("abort", onAbort);
          logStream.end(() => {
            void finish().then(resolve);
          });
        };

        child.on("error", (err) => {
          if (!settled) {
            spawnErrored = true;
            spawnErrorMsg = err instanceof Error ? err.message : String(err);
          }
          settle();
        });
        child.on("exit", () => {
          settle();
        });
      });
    },
  };
}
