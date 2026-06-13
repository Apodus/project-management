// ─── Escalation raise rate-limit (Campaign C4 §P4) ────────────────
// An anti-spam, per-origin_worker_key in-memory sliding-window rate
// limiter for the escalation RAISE path. It mirrors the responder
// spawn-budget gate (responder-ref/loop.ts canSpawn/recordSpawn): a
// per-key array of admission timestamps, pruned to the window on each
// check, with a strict-`<` gate against the max.
//
// DB-PURE: this limiter never touches SQLite (the dedup lives in the
// service; the limiter lives beside the route). State is process-local
// (one server process) — acceptable for a small-team LAN tool, like the
// responder's in-memory budget.
//
// Governed by env (read once at module load, like PM_LEASE_MODE):
//   - ESCALATION_RAISE_MAX (default 20): admissions per window.
//   - ESCALATION_RAISE_WINDOW_SEC (default 60): the window width.
//   - ESCALATION_RAISE_RATELIMIT_HARD (default false): when "true" a
//     limited raise THROWS 429 at the route; otherwise SOFT-advisory
//     (the raise proceeds, the response carries rateLimited:true).
//
// FAIL-OPEN: any limiter throw is caught at the call site → the raise
// proceeds (rateLimited:false). A raise is NEVER dropped by the limiter.

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Per-window admission cap (strict `<` gate). */
export function raiseMax(): number {
  return readIntEnv("ESCALATION_RAISE_MAX", 20);
}

/** Sliding-window width in seconds. */
export function raiseWindowSec(): number {
  return readIntEnv("ESCALATION_RAISE_WINDOW_SEC", 60);
}

/** Whether a limited raise hard-fails (429) instead of soft-advising. */
export function raiseRateLimitHard(): boolean {
  return (process.env.ESCALATION_RAISE_RATELIMIT_HARD ?? "").toLowerCase() === "true";
}

// Per-key sliding window of admission timestamps (ms epoch).
const windows = new Map<string, number[]>();

/**
 * Check the per-key raise budget against a sliding window. Prunes the
 * key's timestamps to `(now - windowSec*1000, now]` IN PLACE, then
 * applies a strict-`<` gate against `raiseMax()` (no off-by-one, like
 * canSpawn). RECORDS the admission timestamp on admission (so concurrent
 * admissions in the same tick see the reservation).
 *
 * @returns `true` when the raise is ADMITTED (within budget), `false`
 *   when the budget is exceeded (the caller decides soft vs hard).
 */
export function checkRaiseRate(workerKey: string, now: number = Date.now()): boolean {
  const windowSec = raiseWindowSec();
  const max = raiseMax();
  const cutoff = now - windowSec * 1000;

  const kept = (windows.get(workerKey) ?? []).filter((t) => t > cutoff && t <= now);

  if (kept.length < max) {
    kept.push(now);
    windows.set(workerKey, kept);
    return true;
  }

  // Exceeded — keep the pruned window (do NOT record the rejected raise).
  windows.set(workerKey, kept);
  return false;
}

/** Test-only: clear all sliding windows between cases. */
export function resetRaiseRateLimiter(): void {
  windows.clear();
}
