# Roadmap — Kill a doomed or hung verify in minutes, not hours (2026-08-04)

**Goal.** A verify that can no longer produce a useful result must be terminated
promptly. Today the only thing that ends a verify is success, failure, or
`verify_timeout_sec` — which on the game_one lane is **9000s (2.5 hours)**. With
`parallelism: 1` that is 2.5 hours of a dead lane.

**The incident this comes from (2026-08-04).**

| local | what |
| --- | --- |
| 11:29:17 | daemon picks up `fix/dark-instruments-checkification`, verify starts at 11:29:26 |
| **11:30:08** | the worker **cancels** it (its own reason said "while QUEUED with 0 attempts" — it was already integrating) |
| 11:31:43 | msbuild starts |
| **11:37:33** | **the build SUCCEEDS** — exe + 999 MB pdb + map + final linker tlogs written. ~6 minutes, matching the lane's normal 6–15 min |
| 11:37:33 → 12:30+ | MSBuild never exits. 12 threads parked, **0 CPU, 0 IO, no children**, nothing written anywhere. `daemon.log` silent since 11:28:56 |

Two independent faults, and each alone would have cost the lane an hour:

1. The request was cancelled **7 minutes before the build even finished**, and the
   daemon never learned. Every second after 11:30:08 was spent on work nobody
   wanted.
2. The build finished but its process never exited, so the daemon's `await`
   never resolved. Nothing would have ended it before the 2.5-hour ceiling.

The 2026-08-02 wedge fix made a mid-verify cancellation **survivable** (no
permanent slot leak). This campaign makes it **responsive**.

---

## What already exists — do NOT rebuild it

Read these first; the whole campaign is new *triggers* into a kill seam that is
already built and already tested.

- **`packages/integrator-ref/src/kill-tree.ts`** — cross-platform process-tree
  kill. Windows `taskkill /pid <pid> /T /F`; POSIX negative-pid group kill
  against a `detached` child. Already wired into the verify spawn in
  **`git-ops.ts:1197-1233`** on BOTH the timeout path and the abort path
  (SIGTERM → SIGKILL), and into the Phase-7.6 resolver spawn
  (`resolver-runner.ts:181-205`).
  > An earlier note claimed the timeout kills only the shell and leaks
  > grandchildren. **That was wrong** — `killTree` has always taken the tree.
  > MSBuild survived on 2026-08-04 because no kill ever *fired*, not because a
  > kill failed. The only work owed here is a regression test (P3).
- **The abort seam** — `member.verify.kill()` → `passController.abort()` →
  `killTree` (`batch.ts:72`, `verify-pipeline.ts:260-267,361`). Suffix
  invalidation already drives it, so a verify killed this way already lands on
  the existing terminal path, and its PM writes are already 409-tolerated by
  `pmTerminalWrite` (the 2026-08-02 fix).
- **`sse-subscriber.ts`** — already running, wired at `index.ts:396`. Today it is
  a **wakeup-only latency hint**; the file's own contract is *"poll is the
  correctness floor"*. Honor that: nothing below may depend on SSE for
  correctness.

**Out of scope (game_one's files, not this repo):** `run_msbuild.ps1`'s
`/nodeReuse:false` and any `pm-verify.bat` change. MSBuild's default
`nodeReuse:true` leaves worker nodes parked after a build and is the most likely
cause of the non-exit — but that file is checked into game_one and is theirs to
change. The PM-side deliverable is the **verify-command contract note** in P3
that tells verify authors their command must exit, and hands them that
recommendation.

---

## P1 — Abort a verify whose request went terminal

While a member is verifying, notice that PM no longer considers it integrating,
and abort.

- **Correctness floor: poll.** Each in-flight member re-reads its own status on
  an interval (new per-project `verify_cancel_poll_sec`, default ~30s; `0`
  disables). Not `integrating` any more ⇒ abort.
- **Latency hint: SSE.** Optionally extend `sse-subscriber.ts` to surface
  `merge.request.abandoned` / `.rejected` / `.requeued` for a member currently
  verifying, so the abort lands in seconds instead of up to one poll interval.
  The poll must be sufficient **alone** — SSE may never be load-bearing.
- **Route through the existing seam.** Call the member's existing
  `verify.kill()`; do not add a second kill path. The terminal bookkeeping,
  slot release and 409 tolerance all already work.
- **Fail OPEN.** A failed status read, a 5xx, or a dropped SSE connection must
  leave the verify running. Only a positive, successful read showing a terminal
  status may kill. A PM blip must never kill a healthy build.
- **Legibility.** The abort is not a verify failure — record it distinctly
  (a `detail.abortedReason: "request_cancelled"` on the verify phase row, and a
  reject/abandon path that says so) so nobody reads it as "the code failed".

**Expected saving on the incident above: 52 of the 59 wasted minutes.**

## P2 — Output-stall watchdog

Kill a verify that has stopped producing output long before the 2.5-hour ceiling.

- Track the last stdout/stderr write per verify. Silence beyond
  `verify_stall_sec` (new per-project setting, **generous default ~1200s / 20m**;
  `0` disables) ⇒ kill through the same seam, reject with a distinct category.
- **The honesty constraint.** A legitimately silent phase exists — linking a
  999 MB pdb writes nothing to stdout for minutes. The default must be generous,
  the setting per-project, and the rejection message must state the threshold and
  the last-output time so an operator can raise it rather than lose trust in the
  train. Killing healthy builds would be worse than the disease.
- **Signal choice, stated as a trade.** Output silence is portable and cheap but
  imperfect (a quiet build looks hung). Child CPU/IO sampling is a truer signal
  but platform-specific. Pick output-silence, and record why — with the door left
  open to corroborate with process liveness later.
- `verify_stall_sec` is a **floor**, `verify_timeout_sec` remains the ceiling;
  the two must not fight (assert `stall < timeout` at config validation).

## P3 — Legibility + seal

- **Distinct outcomes.** An operator must be able to tell apart, from Discord and
  from the request timeline: *verify failed* · *verify killed — request was
  cancelled* · *verify killed — no output for Nm* · *verify timed out at Ns*.
  Reuse the P1-P6 phase vocabulary rather than minting a parallel one.
- **The regression test I owe.** Pin that the timeout and abort paths genuinely
  reap a **grandchild** process tree (spawn a shell that spawns a long-lived
  child; assert the grandchild is gone after the kill). This is the claim I got
  wrong by inspection; it should be provable by test, on both platforms if CI
  allows, Windows at minimum.
- **Docs.** A deployment-guide section in the §14.x voice, narrating the
  2026-08-04 incident and the two new knobs. Extend the **§14.8 verify-command
  contract** with the obligation that a verify command must *exit* — naming
  MSBuild `nodeReuse` as the known offender and `/nodeReuse:false` as the
  recommendation to hand to game_one.
- Full-suite seal + a CLAUDE.md capability-index entry if the surface warrants it.

---

## Design locks

1. **Never kill a healthy verify.** Every automatic kill needs positive evidence.
   Absence of evidence (a failed read, a dropped stream) means keep running.
2. **One kill seam.** `AbortController` → `killTree`. No new termination path.
3. **Poll is correctness, SSE is latency.** The subscriber's existing contract.
4. **Every kill is legible.** A distinct category and a reason naming both the
   evidence and the threshold — never a bare "verify failed".
5. **Generous, configurable thresholds.** Defaults must not kill the slowest
   legitimate build on the slowest box. Silence is weak evidence; treat it so.

## Sizing note

Smaller than it looks. The kill machinery, the abort seam, the 409 tolerance and
the SSE subscriber are all shipped — P1 and P2 add triggers and config, P3 adds
tests and prose. Expect roughly a third of the 2026-08-03 phase-timing campaign.
