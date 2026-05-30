# Phase 7.2 Design: Speculative Batching

**Target audience**: Claude agents (design, implementation, testing) and the human director
**Created**: 2026-05-29
**Status**: Shipped (Steps 2–10 complete) — see §16 for implementation-driven deviations
**Parent roadmap**: `roadmaps/phase-7.2-speculative-batching.md`
**Vision reference**: `roadmaps/phase-7-merge-train-vision.md` (Phase 7.2)

This document is the authoritative architecture spec for Phase 7.2 (Month 2) of the merge-train build. Every later step (Steps 2–11 of the roadmap) treats this file as the single source of truth for the in-memory batch model, speculative base chains, land serialization, suffix invalidation, the lane-ownership lock protocol, the verify-retry policy, batch observability, and the PM-invariant audit. **When this document and the roadmap disagree on a detail, this document wins.**

This doc **builds on `docs/design/phase-7.1-design.md`**. That document's contracts are unchanged unless explicitly noted here. In particular, the following 7.1 sections are inherited verbatim:

- §5 (request + attempt state machines),
- §6 (the decision matrix + the canonical idempotency rule),
- §9 (the seven SSE events + the flattened wire frame),
- §14 (the reference-integrator architecture: process model, CLI, worktree management, verify execution, categorization, the `runOnce`/`runLoop` integration loop, crash recovery),
- §15 (the failure-mode catalog).

Where 7.2 changes something — the lock scope (7.1 §7.2/§14.7 → 7.2 §9), the wire-frame projection (7.1 §9.2 → 7.2 §13), the crash-recovery sweep handling N stranded requests (7.1 §14.8 → 7.2 §12) — the change is called out at the point of divergence. Everything else in 7.1 stands.

---

## 0. Reading guide

The load-bearing sections, in dependency order: **§4** (speculative base chains + the cross-worktree SHA-materialization fact), **§6** (the structural land-gate), **§7/§8** (suffix invalidation + the re-admission decision), and **§9** (the lane-ownership lock protocol). The remaining sections (§3 model, §5 concurrency, §10 retry, §11 backpressure, §13 observability, §14 scheduler map, §15 failures) compose around those four. §12 is the PM-invariant audit that justifies decision 5 (PM needs **no** schema/state-machine changes for N concurrent `integrating` requests).

---

## 1. Goals, non-goals, and the five settled decisions

Month 2 makes the reference integrator run **N integrations in flight at once** (config `integrator.parallelism`, default 1 = today's behavior). Requests verify speculatively — B assumes A will land and rebases onto `main+A`, C onto `main+A+B` — all verifying concurrently. Lands serialize in batch order; a member failure invalidates exactly its dependent suffix, which re-verifies against the corrected base. Throughput scales toward the verify-runtime ceiling instead of being capped by serial integration.

### 1.1 The five settled decisions (non-negotiable, restated verbatim from the roadmap)

> 1. **Batch state is integrator-owned (in-memory).** PM stays exactly request-centric — the `merge_requests`/`merge_attempts` lifecycle is unchanged. PM gains NO `merge_batches` tables and NO `GET /merge-batches`. The integrator is the single source of truth for speculative ordering and the worktree pool. Batch observability is delivered by tagging the *existing* SSE events with batch context (`batchId`, `speculativePosition`) plus a small set of batch-marker events PM re-emits on behalf of the integrator (Step 7) — not by a PM-side batch model.
>
> 2. **Full speculative batching.** Member B rebases onto `main + A` (the assumed-landed predecessor chain), C onto `main + A + B`, etc. All verify concurrently. Lands serialize in batch order. On a member failure, the *dependent suffix* (every member that speculated on the failed member) is invalidated and re-verified against the corrected base; predecessors that already passed still land.
>
> 3. **The Stage-1 lock becomes lane ownership, not per-attempt serialization.** In 7.1 the integrator acquired/released the lock around each single integration. With N in flight, that no longer fits. The integrator acquires the `(project, resource)` lock **once** when it begins a batch, holds it (heartbeating) while the batch is in flight, and releases it when the lane goes idle. The lock now means "exactly one integrator owns this lane" — which is what prevents two integrator processes from racing on `main`. Lands (the actual `git push` to main) are serialized **by the integrator's own batch logic**, in batch order, while it holds the lock.
>
> 4. **`parallelism: 1` is the default and exactly reproduces 7.1 behavior** (a degenerate batch of one). 7.2 is backwards compatible: an existing deployment that doesn't set `parallelism` keeps integrating serially. game_one sets `parallelism: 3–5`.
>
> 5. **PM must tolerate multiple concurrent `integrating` requests per lane.** In 7.1, only one request was ever `integrating` at a time (the serializer guaranteed it). Under batching, N requests in one lane are `integrating` simultaneously. PM has no invariant that forbids this (the state lives per-row), but the design step must audit for any implicit assumption (queries, the integrator's crash-recovery sweep, the merge-lock holder model) and confirm nothing breaks.

Implementing agents may make tactical decisions within these constraints. The integrator-owned-state decision, the full-speculative strategy, the lane-ownership lock model, and `parallelism: 1` backwards-compatibility are not negotiable.

### 1.2 Non-goals (and one explicit vision override)

- **No PM-side batch model.** No `merge_batches` table, no batch row, no batch FK on `merge_requests`. (Decision 1.)
- **No `GET /merge-batches` query API.** **Vision-override:** vision §7.2 mentions a "Batch query API" for the dashboard. Decision 1 deliberately overrides that: there is no durable batch entity to query, so there is no batch query endpoint. The dashboard (Phase 7.4) reconstructs batch state by consuming the `batchId`-tagged events and the `merge.batch.*` markers from the existing SSE stream (§13). If 7.4 finds it genuinely needs durable batch history, that is revisited then — not built now.
- **No cross-repo atomicity** (rynx + outer gitlink) — Phase 7.3.
- **No dashboard / audit log / break-glass UI** — Phase 7.4. (7.2 emits the events the dashboard consumes.)
- **No verify-result caching / multi-stage verify / test-impact analysis** — Phase 7.5.
- **No multi-lane-per-process, no `train.integrator` role** — Phase 7.6. One process owns exactly one `(project, resource)` lane (7.1 §14.1).

### 1.3 Prime invariant

> **`parallelism: 1` is a degenerate batch of one, observably identical in PM state to 7.1's `runOnce`.**

One worktree, one member at a time, base = live `main`, immediate land. The PM-visible sequence of transitions and events (`queued → integrating → landed`/`rejected`, one attempt per request, one acquire/release per land) is byte-for-byte what 7.1 produced. §14 maps each `runOnce` step to its scheduler home and pins this as a regression guard (Step 4, Step 10).

---

## 2. Canonical naming

This section is the authoritative naming table for Phase 7.2. Every later section, test name, event payload field, config key, and module file cites these names verbatim. Drift between locations is a defect. Names defined in 7.1 §2 (request/attempt statuses, reject categories, `landed_sha`, `merge_rejection`, the `main` resource) are unchanged and not repeated here.

| Concept | Canonical name | Notes |
|---|---|---|
| Member verify-state enum | `MEMBER_STATES = "pending" \| "rebasing" \| "verifying" \| "verified" \| "failed" \| "invalidated" \| "landed"` | **In-memory, integrator-side only.** NOT a PM column, NOT a Zod schema, NOT an SSE field. The PM-side `merge_requests.status` enum (7.1 §2) is unchanged. A member's verify-state is the integrator's private bookkeeping; it maps onto PM transitions as described in §3.2. |
| Batch marker events (4) | `merge.batch.started`, `merge.batch.member_landed`, `merge.batch.member_invalidated`, `merge.batch.completed` | Added to `EVENT_NAMES` (§13). PM re-emits them; PM does **not** persist them. |
| Config key | `parallelism` | camelCase `parallelism` on `IntegratorConfig` (integrator side); snake_case `parallelism` in `projects.settings.integrator` (PM side). Integer ≥ 1, default 1. |
| Event-tag field (batch id) | `batchId` | A ULID, **integrator-generated** (via the integrator's own `createId()` / ULID source). PM never mints a batchId; it only relays the one the integrator supplies. |
| Event-tag field (position) | `speculativePosition` | 0-based integer. The member's admission index within its batch. Member 0 is the prefix anchor; member K speculates on members 0..K-1. |
| New integrator module | `packages/integrator-ref/src/worktree-pool.ts` | The pool of N isolated worktrees (Step 3). |
| New integrator module | `packages/integrator-ref/src/batch.ts` | The in-memory `Batch`/`Member` model + the scheduler (Step 4). |
| Batch-events endpoint | `POST /api/v1/projects/{projectId}/merge-batches/events` | `requireIntegrator`-only relay endpoint (§13). Re-emits the 4 markers as SSE; no persistence. |

---

## 3. In-memory batch model

The batch lives **only** in the integrator process's memory. PM has no knowledge of it. A crash loses the batch object entirely; recovery rebuilds nothing — it reconciles PM truth (§12, §15) and starts a fresh batch.

### 3.1 TypeScript interfaces (`packages/integrator-ref/src/batch.ts`)

```ts
import type { VerifyResult } from "./git-ops.js";

export type MemberState =
  | "pending"      // admitted, not yet rebased
  | "rebasing"     // rebase onto speculative base in progress
  | "verifying"    // runVerify spawned, concurrent with siblings
  | "verified"     // verify passed; waiting for land-gate (predecessors)
  | "failed"       // verify non-zero OR rebase conflict → this member is rejected
  | "invalidated"  // a predecessor failed; this member's speculation is void → re-admit
  | "landed";      // pushed to main + PM land() succeeded (terminal)

/**
 * The speculative base a member rebased on top of. `liveMainSha` is the
 * `main` HEAD member 0 anchored to. `predecessorChain` is the ordered list
 * of the members this one assumes will land *before* it — it IS the
 * structural dependency set (see §4, §7). For member 0 the chain is empty.
 */
export interface SpeculativeBase {
  liveMainSha: string;
  predecessorChain: { requestId: string; rebasedTreeSha: string }[];
}

export interface VerifyHandle {
  /** Resolves with the verify result when the child exits/times out. */
  promise: Promise<VerifyResult>;
  /** Kills the verify child process tree (reuses git-ops killTree). */
  kill(): void;
}

export interface Member {
  // ── PM identity (snapshot of the merge_request row at admission) ──
  requestId: string;
  taskId: string | null;
  branch: string | null;
  commitSha: string | null;
  verifyCmd: string | null;   // resolved: request.verifyCmd ?? project default

  // ── Pool + speculation ──
  worktree: import("./worktree.js").Worktree | null;  // leased slot; null when freed
  speculativePosition: number;                        // 0-based admission index
  speculativeBase: SpeculativeBase;
  rebasedTreeSha: string | null;                      // this member's rebased HEAD; base for K+1

  // ── PM-side attempt ──
  attemptId: string | null;                           // current open attempt

  // ── Verify ──
  state: MemberState;
  verifyHandle: VerifyHandle | null;                  // live while verifying; killed on invalidate
  retryCount: number;                                 // transient-failure retries (§10)
}

export interface Batch {
  batchId: string;                 // ULID, integrator-minted
  projectId: string;
  resource: string;
  members: Member[];               // ordered by speculativePosition
  lockHeld: boolean;               // true once acquireLock returned "held"/"already_held"
  createdAt: string;               // ISO 8601
}
```

### 3.2 Member-state ↔ PM-status mapping

The member-state enum is integrator-private. It maps onto PM as follows (PM transitions use the existing 7.1 endpoints — no new request endpoints):

| MemberState | PM-side request status | PM-side attempt | Notes |
|---|---|---|---|
| `pending` | `queued` (not yet picked up) | none | Admitted to the batch object, pre-pickup. |
| `rebasing` | `integrating` (pickup done) | open attempt at `running` | `pickup` + `startAttempt(baseSha)` done; rebase in flight. |
| `verifying` | `integrating` | `running` | `runVerify` spawned. |
| `verified` | `integrating` | `running` (not yet completed) | Verify passed; attempt stays open until land (so a push-race could still cancel it). |
| `failed` | `rejected` | `failed` | `completeAttempt(failed)` + `reject(...)` (§7 step 1). |
| `invalidated` | `queued` (after `resetToQueued`) | `cancelled` | `resetToQueued` cancels the open attempt; member re-admitted (§8). |
| `landed` | `landed` | `passed` | `completeAttempt(passed, treeSha)` + `land(pushedSha)` (§6). |

### 3.3 Lane cardinality

**At most one in-flight `Batch` per `(project, resource)` lane**, and one lane per process (7.1 §14.1). game_one runs one integrator process for `(game_one, main)`; that process holds at most one `Batch` at a time. When a batch drains (§9 release), the next poll/SSE tick can start a new one. There is no concurrent-batch model; concurrency lives *within* a batch as up to `parallelism` members.

---

## 4. Speculative base chains (load-bearing)

This is the heart of the speculation. Member K rebases its branch on top of the *assumed-landed* trees of members 0..K-1, so all members verify concurrently against the world they expect to see at their land time. The exact git sequence is grounded in `packages/integrator-ref/src/git-ops.ts`.

### 4.1 Member 0 — anchored to live main

Member 0 is the prefix anchor. In its own worktree (pool slot 0):

1. `worktree.resetForAttempt()` — the existing 7.1 sequence: `reset --hard`, `clean -fdx`, `fetch <remote>`, `checkout <mainBranch>`, `reset --hard <remote>/<mainBranch>`. This puts the slot at live `main`.
2. `baseSha = gitOps.resolveRef("HEAD")` — the live `main` SHA. This is `SpeculativeBase.liveMainSha`.
3. `startAttempt(requestId, baseSha)` (PM records the speculative base — here it equals live main).
4. `const rebase = await gitOps.rebaseOnto(baseSha, ref)` where `ref = request.branch ?? request.commitSha`. On success, `rebase.treeSha` (the `RebaseSuccess.treeSha`, captured by git-ops as `git revparse HEAD` after the rebase) becomes **member 0's `rebasedTreeSha`**.

Member 0's `predecessorChain` is empty. Its `rebasedTreeSha` is the base for member 1.

### 4.2 Member K > 0 — chained onto the predecessor's rebased tree

Member K runs in its own pool slot (a **separate clone**, never a shared `.git`). Its speculative base is member K-1's `rebasedTreeSha`:

```
speculativeBase = {
  liveMainSha:      <member 0's liveMainSha>,
  predecessorChain: [ {requestId: m0.requestId, rebasedTreeSha: m0.rebasedTreeSha},
                      {requestId: m1.requestId, rebasedTreeSha: m1.rebasedTreeSha},
                      ... up to m(K-1) ]
}
```

The git sequence in K's worktree:

1. `worktree.resetForAttempt()` — clean slot, fetch the remote, sit at live `main` (the remote is the *only* place K's clone naturally knows about; the predecessor's rebased commit is **not** on the remote — see §4.3).
2. **Materialize the predecessor tree (§4.3).** Fetch member K-1's `rebasedTreeSha` into K's clone from K-1's worktree path.
3. `startAttempt(requestId, predecessorRebasedTreeSha)` — PM records the speculative base SHA K verified against (member K-1's rebased tree).
4. `const rebase = await gitOps.rebaseOnto(predecessor.rebasedTreeSha, ref)` — rebase K's branch onto the predecessor's rebased tree. On success, `rebase.treeSha` becomes **member K's `rebasedTreeSha`**, the base for member K+1.

The chain is built left to right as each member completes its rebase; member K's rebase cannot start until member K-1's `rebasedTreeSha` is known. (Verifies still run concurrently — the *rebase* step of K serializes behind K-1's rebase, but the long-pole `runVerify` of all members overlaps. This is the speculation win: verifies, not rebases, are the runtime ceiling.)

### 4.3 Chain materialization — the cross-worktree fetch (MUST implement + test in Step 5)

**Grounding fact, stated explicitly because it is easy to get wrong:** member K-1's rebased commit lives **only in K-1's clone**. It is:

- **NOT on the remote** — `rebaseOnto` rebases locally and captures the tree SHA via `git revparse HEAD`; nothing is pushed. (Pushing happens only at land time, §6, and only for the member that actually lands.)
- **NOT in K's clone** — K's clone fetched the remote in step 1, which does not contain K-1's not-yet-pushed rebased commit.

Therefore, **before K can rebase onto `predecessor.rebasedTreeSha`, K's worktree MUST fetch that SHA into K's object store.** The mechanism is an ad-hoc local fetch using K-1's worktree directory as a one-off git remote:

```
git -C <K-worktree-path> fetch <K-1-worktree-path> <predecessor.rebasedTreeSha>
```

After this fetch, the SHA is present in K's object store (as `FETCH_HEAD` / a loose object) and `rebaseOnto(predecessor.rebasedTreeSha, ref)` can resolve it. **The SHA is not assumed present — it must be fetched first.** This generalizes for chains: K only needs K-1's tree (because K-1's tree already contains K-2's, K-3's, ... transitively, since each rebase built on the prior). So one fetch of the immediate predecessor's SHA suffices.

**Step 5 owns this.** Step 5 must implement the cross-worktree fetch (extend `git-ops.ts` with a `fetchObject(fromPath, sha)` helper or equivalent) and test it under **overlapping concurrent verifies** — i.e., assert that while members are verifying concurrently, K's worktree successfully fetches and rebases onto K-1's tree even though K-1's verify has not finished. (The rebase depends on K-1's *rebased tree*, available the moment K-1's rebase completes; it does **not** depend on K-1's verify result. K-1's verify outcome only matters at land/invalidation time.)

### 4.4 Why the chain IS the dependency set

`SpeculativeBase.predecessorChain` is not a derived hint — it is the structural record of "which members does K depend on." Under full-speculative batching, K's chain is exactly members 0..K-1. This makes two later algorithms *structural* rather than guessed:

- **Suffix invalidation (§7):** "every member J that depends on failed member K" = "every J where `K.requestId ∈ J.predecessorChain`." Computed, not inferred.
- **Land-gate (§6):** K may land only when every entry in its `predecessorChain` is `landed`.

Keeping the chain explicit on each member is what lets the verifier (and the implementer) prove these invariants by inspection instead of by reasoning about positions.

### 4.5 Worked example — a 3-member chain, end to end

To make §4.1–§4.4 concrete, trace `parallelism: 3` with members `[m0, m1, m2]` (admitted in that FIFO order; live `main` is at SHA `M`):

| Step | Slot | Action | Result |
|---|---|---|---|
| 1 | 0 | `m0`: `resetForAttempt()`; `baseSha = resolveRef("HEAD")` | `baseSha = M`; `m0.speculativeBase = { liveMainSha: M, predecessorChain: [] }` |
| 2 | 0 | `m0`: `startAttempt(m0.requestId, M)`; `rebaseOnto(M, m0.ref)` | `m0.rebasedTreeSha = R0` |
| 3 | 1 | `m1`: `resetForAttempt()` (slot 1 sits at `M`); fetch `R0` from slot 0's path | `R0` now in slot 1's object store |
| 4 | 1 | `m1`: `startAttempt(m1.requestId, R0)`; `rebaseOnto(R0, m1.ref)` | `m1.rebasedTreeSha = R1`; `m1.predecessorChain = [{m0, R0}]` |
| 5 | 2 | `m2`: `resetForAttempt()` (slot 2 at `M`); fetch `R1` from slot 1's path | `R1` (which transitively contains `R0`'s changes) in slot 2's store |
| 6 | 2 | `m2`: `startAttempt(m2.requestId, R1)`; `rebaseOnto(R1, m2.ref)` | `m2.rebasedTreeSha = R2`; `m2.predecessorChain = [{m0, R0}, {m1, R1}]` |
| 7 | all | `runVerify` for `m0`, `m1`, `m2` run **concurrently** in slots 0/1/2 | three overlapping verifies |
| 8 | 0 | `m0` verified; land-gate (no predecessors): live main == `M` → `push` → `main = R0` | `m0` `landed`, `landedSha = R0` |
| 9 | 1 | `m1` verified; predecessor `m0` landed; live main == `R0` (expected) → `push` → `main = R1` | `m1` `landed`, `landedSha = R1` — **no re-verify** |
| 10 | 2 | `m2` verified; predecessors landed; live main == `R1` → `push` → `main = R2` | `m2` `landed`, `landedSha = R2` |

The fast-forward at steps 9–10 is clean **because** each member verified against exactly the tree that became `main` (R0, then R1) before it landed — the speculation paid off, and no member re-ran verify. Steps 2/4/6 (the rebases) serialize; step 7 (the verifies, the long pole) overlaps. That overlap is the throughput win.

If, say, `m1`'s verify had failed at step 7, the land loop (§6.1) would land `m0` (step 8), reject `m1`, then invalidate `m2` (its chain contains `m1`) and re-admit it against corrected base `main + m0` (= `R0`, the surviving prefix) — §7's worked example.

---

## 5. Concurrency model

- **Up to `parallelism` worktrees**, one member each. The pool (`worktree-pool.ts`, Step 3) leases an idle slot per admitted member and reclaims it on terminal/invalidated.
- **FIFO fill.** The scheduler pulls queued requests via `pmClient.listMergeRequests(projectId, { resource, status: "queued" })`. The PM `list()` service orders by `asc(enqueuedAt)` (confirmed: `merge-request.service.ts` `list()` does `.orderBy(asc(mergeRequests.enqueuedAt))`). So `queued[0]` is the oldest. The scheduler admits from the head of that list.
- **Admission order defines structure.** The order in which requests are admitted defines each member's `speculativePosition` (0, 1, 2, …) and therefore its `predecessorChain`. The first admitted is position 0 (anchored to live main); the next is position 1 (speculates on 0); and so on.
- **Concurrent verify.** Each member runs `gitOps.runVerify(cmd, timeoutMs, { cwd: <its worktree path>, logPath })` in its own worktree's cwd. The N verifies run concurrently (each is a detached child process; the scheduler awaits all their `verifyHandle.promise`s).

The scheduler is event-driven within the batch: it admits up to `parallelism` members, kicks off rebase+verify for each, then reacts to members reaching `verified`/`failed` by running the land-gate (§6) and suffix-invalidation (§7) logic, refilling freed slots (§11) until the queue drains and all members are terminal.

---

## 6. Land serialization — the structural land-gate (load-bearing)

Lands are serialized in strict `speculativePosition` order. A member lands only when **(a)** its state is `verified` AND **(b)** every predecessor (every entry in its `predecessorChain`, i.e. every member at a lower position) is `landed`.

### 6.1 The land loop and its invariant

The scheduler runs a **land loop** that walks members in ascending `speculativePosition` and lands each that is ready, halting at the first non-landed predecessor:

```
function tryLand(batch):
  for member in batch.members ordered by speculativePosition asc:
    if member.state == "landed":        continue          # already done
    if member.state != "verified":      break             # not ready (or failed/verifying) → stop
    # All predecessors are landed (loop invariant below). Land this member.
    landMember(batch, member)
    if landMember failed (stale/race):  break              # don't skip ahead
```

**Loop invariant (the structural guarantee):** the loop processes positions in ascending order and `break`s the moment it hits a member that is not `landed` and not `verified`-and-ready. Because it never skips, a member at position K is reached only after positions 0..K-1 have all been confirmed `landed` in this same pass (or a prior pass). **A member physically cannot land before its predecessors** — the gate is enforced by the loop's structure, not by an implementer remembering to check. (This is the structural answer to bug-class **(b)**: "a member lands out of order.")

### 6.2 `landMember` — fast-forward-or-reverify

At land time the scheduler holds the lane lock (§9), so `main` should be exactly where the member expected. The land step:

1. **Compute the expected `main` SHA.** For member 0: `speculativeBase.liveMainSha`. For member K: the **landed SHA of member K-1** (the immediately-preceding member, which the land loop guarantees is already `landed`). Call it `expectedMainSha`.
2. **Check live main.** `actualMainSha = gitOps.resolveRef("<remote>/<mainBranch>")` after a fetch in the member's worktree.
3. **If `actualMainSha === expectedMainSha`** (the happy, expected path under the lane lock): `gitOps.push(remote, mainBranch)` — the existing `push()` does `git push <remote> HEAD:<branch>`, fast-forwarding remote main to the member's verified rebased tree → `PushSuccess.pushedSha`. Then `completeAttempt(attemptId, { status: "passed", treeSha: pushedSha })` and `land(requestId, { landedSha: pushedSha })`. **No re-verify** — this is the speculative win: the member already verified against exactly this base, so the verified tree is known-green. Mark member `landed`, record `landedSha`, free its worktree to the pool, emit `merge.batch.member_landed` (§13).
4. **If `actualMainSha !== expectedMainSha`** (main drifted — guarded against; should not happen while we hold the lane lock, see §9): the verified tree is stale. Re-rebase the member onto live main (+ surviving prefix) and re-verify. Concretely: `resetToQueued(requestId, "main drifted at land; re-verify")` and re-admit at the head of the batch's admission (the member becomes `invalidated`→re-admitted per §8 mechanics, with the corrected base). This is the same machinery as suffix invalidation; the drift case simply triggers it for a single member.

### 6.3 Push-race handling

If `push()` returns `PushFailure` with `reason: "non_fast_forward"` (the 7.1 push-race signal), treat it as the §6.2 step-4 drift case: `completeAttempt(cancelled)`, `resetToQueued`, re-admit with corrected base. Other push failures (`auth`/`network`/`other`) are real failures → `completeAttempt(failed, category="other")` + `reject` + suffix invalidation (§7), exactly as 7.1 `runOnce` does for a non-fast-forward-other push error.

---

## 7. Suffix invalidation (load-bearing)

A member transitions to `failed` when **verify exits non-zero on its own** (real failure, §10) **OR** a **rebase conflict at admission** (`rebaseOnto` returns `RebaseConflict`). Both reuse `categorize.ts` and the `RebaseConflict` path exactly as 7.1 `runOnce` does. On a member `K` failing, the scheduler runs the four-step suffix-invalidation algorithm.

### 7.1 Step 1 — reject K (identical to 7.1)

Reject member K via the existing flow: `completeAttempt(K.attemptId, { status: "failed", failureCategory, failureReason, failedFiles, logExcerpt, logUrl })` then `reject(K.requestId, { category, reason, failedFiles, logExcerpt, logUrl })`. PM transactionally inserts the `merge_rejection` comment on the linked task and emits `merge.request.rejected` (7.1 §12.3). This is byte-identical to 7.1's rejection; nothing about rejection changes.

### 7.2 Step 2 — compute the dependent suffix STRUCTURALLY

The dependent suffix is **every member J where `K.requestId ∈ J.predecessorChain`** (§4.4). Under full-speculative batching that set is exactly `{ J : speculativePosition(J) > speculativePosition(K) }` — every member admitted after K, because every later member's chain includes K. **It is computed from `predecessorChain`, never guessed from positions alone** (positions are the fast equivalence; the chain is the source of truth, so the algorithm stays correct even if a future phase introduces non-contiguous dependencies). This is the structural answer to bug-class **(a)**: "invalidate too much / too little." Predecessors of K (position < K) are **untouched** — they keep their `verified`/`landed` state. Failure isolation is by construction.

### 7.3 Step 3 — tear down each suffix member

For each member J in the dependent suffix:

1. **Kill its verify.** `J.verifyHandle?.kill()` — reuses `git-ops` `killTree` (cross-platform: `taskkill /T /F` on Windows, process-group `kill` on POSIX). The verify child and its subtree die.
2. **Free its worktree** back to the pool (`pool.release(J.worktree)`), so the slot can host a re-admitted member.
3. **Transition J to `invalidated`** (member-state). PM-side this is handled in step 4 via `resetToQueued`.

### 7.4 Step 4 — re-admit with the corrected base

The surviving prefix is members `0..K-1` (K is excluded — it's rejected). Re-admit each invalidated suffix member against the **corrected base = live `main` + surviving prefix**, with positions shifted down by one (each former position P > K becomes P-1, since K left the batch). The re-admitted members rebuild their `predecessorChain` over the surviving prefix and re-rebase + re-verify (§4). The re-admission mechanism is `resetToQueued` + re-pickup, justified in §8.

**Concrete example (the Step-6 test heart):** a 3-member batch `[0, 1, 2]`. Member 1 fails verify. Member 0 (position 0, no dependency on 1) is **untouched** and still lands. Member 1 is rejected. Member 2 (position 2, `predecessorChain` includes 1) is the dependent suffix → killed, freed, re-admitted with corrected base `main + 0` (NOT `main + 0 + 1`), re-verified, and lands. A *tail* failure (member 2 fails) lands 0 and 1, rejects 2, invalidates **nothing**. A *head* failure (member 0 fails) invalidates the **entire** suffix (1 and 2). "A single failure invalidates exactly the dependent suffix — never more, never less" is the vision's success criterion and is asserted by Step 6 tests.

---

## 8. Re-admission decision: `resetToQueued` + re-pickup (not in-place re-base)

**Decision: re-admission is via `resetToQueued` + re-pickup, NOT in-place re-base.** This is the authoritative choice for §7 step 4 and §6.2/§6.3 (drift/push-race).

### 8.1 Why `resetToQueued`

An invalidated member is mid-`integrating` with a `running` attempt (its open attempt was started at admission, §3.2). `resetToQueued` is **exactly "un-pick-it-up"**:

> **Grounded behavior (cite the code, not the stale comment).** `merge-request.service.ts:resetToQueued` runs a `db.transaction` that calls `cancelOpenAttempts(row.id)` (flipping the member's open `pending`/`running` attempt → `cancelled`), then sets the request `status: "queued"`, clears `pickedUpAt`, and after commit emits `merge.attempt.completed` (cancelled) for each cancelled attempt plus a re-`merge.request.queued`. **The function's in-code header comment is stale** — it says *"Step 4 does NOT cancel open attempts here … Step 5 will extend resetToQueued."* The code shipped with that extension: `resetToQueued` **does** cancel open attempts today (it imports and calls `cancelOpenAttempts` inside the transaction). Document and rely on the **current behavior**, not the stale comment.

So one `resetToQueued` call atomically: cancels the stale attempt (attempt history stays truthful — the cancelled attempt records that this speculation was abandoned), clears `pickedUpAt`, and returns the request to `queued`. The re-admitted member then goes through the normal admission path (pickup → new `startAttempt` with the corrected base SHA).

### 8.2 Why NOT in-place re-base

In-place re-base would leave the request `integrating` with a `running` attempt while the integrator silently swaps the member's `baseSha` and re-rebases. Two problems:

1. **Attempt history lies.** The `running` attempt's `baseSha` was the *old* (now-invalidated) speculative base; re-basing in place without completing/cancelling it leaves a record claiming the member is verifying against a base it abandoned.
2. **Crash recovery can't distinguish it.** Crash recovery (`recovery.ts`) keys off `status: "integrating"` and resets every such request. An in-place re-based member looks identical to a live, healthy member; on a crash mid-re-base, recovery couldn't tell "this was being re-based against a corrected base" from "this is genuinely in flight." `resetToQueued` puts the member cleanly back to `queued`, where recovery has nothing to do.

### 8.3 Cost is negligible

The warm-worktree loss (the re-admitted member's slot is freed and re-leased) is negligible: an invalidated member **must re-rebase and re-verify against the corrected base anyway** (its prior speculation was on a base that no longer holds), so there is no warm state worth preserving. The re-admitted member rejoins at the head of the next admission by FIFO — its `enqueuedAt` is unchanged, so it sorts ahead of any never-yet-admitted requests with later `enqueuedAt`, preserving fairness (§11).

---

## 9. Lane-ownership lock protocol (load-bearing)

Grounded in `merge-lock.service.ts`. This is the structural race-guard of decision 3: the lock now means **"exactly one integrator owns this lane,"** acquired once per batch, not once per attempt.

### 9.1 Acquire once at batch start

When the scheduler decides to start a batch (queued work exists, no batch in flight), it calls `pmClient.acquireLock(projectId, resource, intent)` **once**. The `intent` is a lane-level landing intent (derived from the first/representative member: its `taskId`, `branch`, `commitSha`, `verifyCmd`, `worktreePath`). The result:

- **`status: "held"` or `"already_held"`** → this integrator owns the lane. Proceed to admit members. (`acquire` uses an atomic `WHERE holder_id IS NULL` claim with a `changes === 0` race re-check — confirmed in `merge-lock.service.ts:acquire` — so two integrators cannot both win.)
- **`status: "queued"`** → another integrator already owns the lane. Do **NOT** start a batch. Idle and retry on the next poll tick (mirrors 7.1 `runOnce`'s `lock_unavailable` → `runLoop` `waitForWork` backoff). The second integrator never enters the land path because it never acquires.

### 9.2 Heartbeat for the whole batch lifetime

A **single** heartbeat timer calls `pmClient.heartbeatLock(projectId, resource)` every 60s for the entire batch lifetime — from acquire until release. This **replaces** 7.1's per-`runOnce` heartbeat (which started on pickup and cleared when that single verify finished). In 7.2 the timer spans the whole batch (potentially many members landing/failing/re-admitting). The lease `LEASE_TTL_MS = 5 * 60 * 1000` (5 min) is reused unchanged; the 60s heartbeat keeps it fresh.

### 9.3 Release on drain

The lane lock is released when **the queue is empty AND all members are terminal** (`landed`, `failed`, or — for the batch's accounting — no `invalidated` member remains un-re-admitted). At drain:

- `pmClient.releaseLock(projectId, resource, { landedSha: <last landed member's SHA> })` if any member landed (the existing "main moved at X" signal). The `landedSha` recorded on the lock reflects the **last** land of the batch (an accepted observability nuance — see §12 finding 5; it parallels 7.1 §7.4's note that the lock's `landedSha` lags).
- `pmClient.releaseLock(projectId, resource, { reason: <summary> })` if every member was rejected (no land).

Then emit `merge.batch.completed` (§13).

### 9.4 Crash while holding

If the integrator crashes mid-batch while holding the lane lock:

- The in-memory `Batch` is lost (§3).
- The lock's `LEASE_TTL_MS` (5 min) sweep frees it — `sweepExpired` runs at the top of every lock operation, so the next integrator's `acquireLock` reclaims it (the stale holder is evicted, the claim succeeds).
- On restart, crash recovery (§12, the `reclaimStrandedRequests` sweep) resets **all** `integrating` requests in the lane back to `queued`. Since `main` is only ever advanced while holding the live lock (§9.5), no orphaned push can have happened that recovery doesn't see.

This is the §15 "integrator crash mid-batch" row.

### 9.5 Contrast with 7.1 + why the lock is the race-guard

**7.1:** the lock was acquired and released **inside each `runOnce`** — `acquire` on pickup, `release` on every exit path (land/reject/push-race), heartbeat scoped to that one verify (`loop.ts` lines 128–169, 1039).

**7.2:** the per-attempt acquire/release in `loop.ts` is **REMOVED**. It is replaced by **one acquire at scheduler start** and **one release at drain**, with a single batch-lifetime heartbeat. Individual members no longer touch the lock.

The lock is the structural guard for bug-class **(c)** ("two integrators push main concurrently"): a `git push` to main happens only inside `landMember` (§6.2), which runs only while the integrator holds the lane lock. A second integrator process gets `status: "queued"` from `acquire` and never reaches the land path. The single `holderId` + the TTL sweep + the atomic `WHERE holder_id IS NULL` claim make "exactly one lane owner" enforceable by the database, not by policy. Step 9 implements this migration and tests "a second integrator can't land concurrently."

---

## 10. Verify retry policy

Extends `categorize.ts` without changing its category output (the category feeds the reject payload and must stay stable). The retry decision is a **separate classification layered on top**.

### 10.1 Transient vs real

| Class | Signals | Action |
|---|---|---|
| **Transient** (retry) | (1) **Spawn failure** — `ENOENT`/`EACCES`: `git-ops` `runVerify` surfaces these via the child `error` handler as `exitCode: 127` with the error text in `stderr`. (2) **OOM / signal-kill NOT from our timeout** — a `SIGKILL`/`SIGTERM` that the integrator did **not** fire. (3) **Infra/network timeout** distinct from the verify command's own timeout. | Retry the **same member, same speculative base**, after backoff. No PM rejection. |
| **Real** (no retry) | Verify **exited non-zero on its own**: `exitCode !== 0 && !timedOut && !spawnError`. Also: rebase conflict at admission. | → member `failed` → reject + suffix invalidation (§7). |

**The killed-but-not-by-us nuance.** `categorize.ts` currently maps **any** `SIGKILL`/`SIGTERM` (and `exitCode === 124`, and `timedOut`) to `verify_timeout`. But the integrator knows whether **it** fired the timeout: `git-ops` `runVerify` returns `timedOut: true` only when its own deadline timer fired (it sets `timedOut = true` immediately before calling `killTree`). So a signal-kill with `timedOut === false` is a kill the integrator did **not** cause (OOM-killer, operator `kill`, container eviction) → **transient**. To express this cleanly, thread a `killedByTimeout` boolean (= the `VerifyResult.timedOut` flag) into the retry classifier. Do **not** change `categorize.ts`'s category output — when a transient retry ultimately gives up (cap reached), the *final* failure is still categorized normally for the reject payload.

### 10.2 Backoff and cap

- Backoff schedule: **1s, 5s, 15s**.
- Cap: **N = 3 retries per member**. After the cap, treat the failure as **real** → `failed` → reject + suffix invalidation.

### 10.3 The classifier helper

Recommend a pure helper `classifyTransient(result: VerifyResult, killedByTimeout: boolean): "transient" | "real"` in the integrator (layered on `categorize.ts`, not inside it):

```ts
function classifyTransient(r: VerifyResult, killedByTimeout: boolean): "transient" | "real" {
  if (r.exitCode === 127) return "transient";                 // spawn failure (ENOENT/EACCES)
  if (r.signal && !killedByTimeout) return "transient";       // killed, but not by us (OOM, operator)
  // (infra/network verify-harness timeouts surface as the integrator's own infra layer,
  //  classified transient there; the verify command's *own* timeout is `killedByTimeout` → real-ish,
  //  i.e. verify_timeout, which is NOT retried — a verify that times out on its own is a real failure.)
  return "real";                                              // exited non-zero on its own
}
```

Note: a verify that hits **its own** `verify_timeout_sec` deadline (`killedByTimeout === true`) is a **real** failure (category `verify_timeout`) — the project's verify genuinely did not finish in time. It is rejected, not retried.

### 10.4 Surface retries as attempts

Each retry is a **new attempt row** for the member: a fresh `startAttempt` (same `baseSha` = same speculative base) + a `completeAttempt` recording the transient outcome. This is consistent with `getNextAttemptNumber` (confirmed: `SELECT MAX(attemptNumber) WHERE request_id = ?`, per-request monotonic) and the `UNIQUE(requestId, attemptNumber)` index. So a member that retries twice then passes shows three attempt rows (#1 cancelled/failed-transient, #2 cancelled/failed-transient, #3 passed). Step 8 implements this; tests assert "a simulated transient retries then lands; a real failure rejects immediately; the cap is honored."

---

## 11. Backpressure

A new queued request is admitted only when **(a) the pool has an idle worktree AND (b) the lane lock is held.** Both are required.

- When **all `parallelism` worktrees are leased**, queued requests are **neither picked up nor dropped**: the scheduler simply does not call `pickup`/`transitionToIntegrating` for them. They stay `queued` in PM (their `pickedUpAt` is null), visible to `pm_list_merge_requests` with a queue position.
- As members reach terminal (`landed`/`failed`) or `invalidated`, their slots free. The scheduler admits the next FIFO request (`listMergeRequests(status:queued)[0]` by `enqueuedAt`) into the freed slot, assigning it the next `speculativePosition` and a `predecessorChain` over the currently-surviving prefix.
- **Re-queued members (§8) compete in the same FIFO** and win by `enqueuedAt` — their `enqueuedAt` predates any request submitted after them, so a re-admitted member is admitted before a brand-new request, preserving submission order.

The admission rule is the single gate; there is no separate queue inside the integrator. PM's `queued` set + the pool's idle count + the lock-held flag fully determine admission. (Step 4 tests: "backpressure holds the 4th request while 3 worktrees are busy"; Step 10 E2E: "5 submitted with parallelism 3 → all land, never more than 3 in flight.")

---

## 12. PM-invariant audit (decision 5)

**Conclusion up front: PM tolerates N concurrent `integrating` requests per lane with ZERO PM-side code changes.** The only PM additions in 7.2 are the optional event-tag fields (`batchId`, `speculativePosition`) and the thin batch-events relay endpoint — both purely additive (§13). The lane-lock semantic shift is **entirely integrator-side**. Each finding below is verified against source.

1. **Crash-recovery sweep — safe.** `reclaimStrandedRequests` (`recovery.ts`) already iterates `for (const req of stranded)` over **all** requests returned by `listMergeRequests(status: "integrating")` and calls `resetToQueued` on each, counting 409s as `skipped`. It has **no** "expect exactly one" assumption. It handles N stranded `integrating` requests today. (Step 9 confirms with a test; no code change needed — the loop is already N-safe.)
2. **Request-service state machine — safe.** `merge-request.service.ts` transition guards (`assertCanTransition`) are **per-row**: each operation reads one request row and checks that row's `status`. There is no cross-row "is any *other* request in this lane already `integrating`?" check anywhere. N rows can be `integrating` simultaneously without any guard tripping.
3. **`list()` consumer — safe.** `list()` has no cardinality assumption (it paginates and orders by `enqueuedAt`). The only behavioral change is **integrator-side**: 7.1 took `queued[0]`; 7.2 takes up to `parallelism` from the head. PM's `list` is unchanged.
4. **Attempt numbering — safe.** `getNextAttemptNumber` is **per-request** (`SELECT MAX(attemptNumber) WHERE request_id = ?`), and `UNIQUE(requestId, attemptNumber)` is per-request. N members each have their own independent attempt sequence; concurrent members never collide because each numbers within its own `requestId`.
5. **Merge-lock holder model — SEMANTIC shift, NO code change.** The lock is now lane-scoped (held for a whole batch) rather than per-attempt. Its landing-intent fields (`taskId`/`branch`/`commitSha`/`verifyCmd`/`worktreePath`) now describe **one representative member** of the batch rather than the single in-flight request. The lock's `landedSha` updates only on the final `release` (so it reflects the last land of the batch, not each member's). This is a **semantic** change in how the integrator *uses* the lock — the `merge-lock.service.ts` code (atomic claim, sweep, heartbeat, release, queue-promote) is **unchanged**. This is an accepted observability nuance, parallel to 7.1 §7.4's note that the lock's `landedSha` can lag main.
6. **No partial unique index forbids multiple `integrating` rows — safe.** The `merge_requests` indexes (`idx_merge_requests_project_status`, `idx_merge_requests_resource_status`, `idx_merge_requests_task`) are **non-unique** (7.1 §4.1). Nothing at the schema level forbids N rows with `status = "integrating"` for the same `(projectId, resource)`. The DB tolerates N.
7. **No other `integrating` consumer assumes ≤1.** A grep across the server for `status: "integrating"` / `"integrating"` consumers finds only the request-service transitions (per-row, finding 2) and the integrator-side recovery sweep (finding 1). No dashboard, listener, or query assumes a single in-flight integrating request.

**Net:** decision 5 holds. 7.2 ships no PM state-machine, schema, or query change to support N concurrent `integrating` requests. The additive bits (§13) are the only PM touches.

---

## 13. Batch observability (decision 1: events, not tables)

Batch context reaches consumers two ways: **tagged existing events** and **four batch-marker events**. No PM batch table; PM relays.

### 13.1 Tagging existing events with `batchId` + `speculativePosition`

The integrator supplies `batchId` and `speculativePosition` as **optional body fields** on `pickup` and `startAttempt`. PM threads them onto the in-process `EventPayload.entity` (the existing spread pattern — `emit` does `entity: { ...row, ...extra }`). For `merge.request.integrating` (emitted by `transitionToIntegrating`/pickup) and `merge.attempt.started` (emitted by `startAttempt`), the extras gain `batchId` and `speculativePosition` when present. 7.1 callers that omit them are unaffected (the fields are absent → undefined → not spread).

**IMPORTANT grounding fact — the wire frame does not carry entity extras.** `routes/events.ts` projects each `EventPayload` down to a **flattened wire frame** with exactly `{ entity_type, entity_id, action, changes?, actor, timestamp, entity_title? }` (confirmed: `events.ts` builds `ssePayload` from those fields only). It does **not** spread `payload.entity`'s extras onto the wire. So `batchId`/`speculativePosition`, even when present on the in-process payload, will **NOT reach SSE clients as-is.**

**Step-7 change (RECOMMEND — minimal, additive).** Extend the `events.ts` wire-frame projection to pass through `batchId` and `speculativePosition` **when present** on `payload.entity`. The 7.4 dashboard needs them on the wire (it has no batch table to join against). The exact edit:

```ts
// In routes/events.ts, where ssePayload is built (~line 89). Read the two
// optional fields off the entity (which is the spread row+extras) and include
// them only when present, mirroring the existing entity_title pattern:
const entityObj =
  payload.entity && typeof payload.entity === "object"
    ? (payload.entity as Record<string, unknown>)
    : undefined;
const batchId =
  typeof entityObj?.batchId === "string" ? entityObj.batchId : undefined;
const speculativePosition =
  typeof entityObj?.speculativePosition === "number"
    ? entityObj.speculativePosition
    : undefined;

const ssePayload = {
  entity_type: payload.entityType,
  entity_id: payload.entityId,
  action,
  changes: payload.changes ?? undefined,
  actor,
  timestamp: payload.timestamp,
  ...(entity_title ? { entity_title } : {}),
  ...(batchId ? { batch_id: batchId } : {}),
  ...(speculativePosition !== undefined
    ? { speculative_position: speculativePosition }
    : {}),
};
```

This is additive (absent fields are omitted, exactly like `entity_title`), so 7.1 frames are byte-identical.

### 13.2 The four batch-marker events

The integrator POSTs markers to a thin endpoint; PM re-emits them as `merge.batch.*` SSE events with **no persistence**.

- **Endpoint:** `POST /api/v1/projects/{projectId}/merge-batches/events`, `requireIntegrator` (403 for non-`ai_agent`, mirroring the existing merge-request integrator endpoints). Body: `{ type, batchId, ... }` where `type ∈ { started, member_landed, member_invalidated, completed }`. The handler validates and calls `getEventBus().emit(MERGE_BATCH_*, payload)`; it writes **nothing** to the DB.
- **`EVENT_NAMES` additions** (`event-bus.ts`):

```ts
// Merge batch markers (Phase 7.2 — integrator-relayed, not persisted)
MERGE_BATCH_STARTED:            "merge.batch.started",
MERGE_BATCH_MEMBER_LANDED:      "merge.batch.member_landed",
MERGE_BATCH_MEMBER_INVALIDATED: "merge.batch.member_invalidated",
MERGE_BATCH_COMPLETED:          "merge.batch.completed",
```

- **Payloads** (the body the integrator POSTs; PM re-emits onto the event):

| Marker | Payload |
|---|---|
| `merge.batch.started` | `{ batchId, resource, memberCount, memberRequestIds: string[] }` |
| `merge.batch.member_landed` | `{ batchId, requestId, speculativePosition, landedSha }` |
| `merge.batch.member_invalidated` | `{ batchId, requestId, speculativePosition, reason, failedPredecessorRequestId }` |
| `merge.batch.completed` | `{ batchId, landed: number, rejected: number, invalidated: number }` |

These ride the existing `/api/v1/events` SSE stream. Because the markers are not entity-row events, their wire projection should pass the payload fields through (the Step-7 endpoint can emit them with an `entityType: "merge_batch"` and the batch fields carried so the dashboard reads them; the exact wire shape is a Step-7 tactical choice consistent with §13.1's pass-through).

### 13.3 Forward dependency

Phase 7.4's dashboard consumes these events (tagged `batchId`/`speculativePosition` + the four markers). It does **NOT** query a PM batch table — there isn't one (decision 1, §1.2 vision-override). The events are the entire batch-observability contract.

---

## 14. Batch scheduler architecture — how it subsumes `runOnce`/`runLoop`

The scheduler (`batch.ts`, Step 4) is a **per-member state machine** driving each `Member` through the same git/PM sequence `runOnce` does today (7.1 §14.7, `loop.ts`) — but **N concurrently**, with the lock hoisted out to batch scope (§9). Each `runOnce` step maps to a scheduler home:

| `runOnce` step (`loop.ts`) | 7.2 scheduler home |
|---|---|
| `listMergeRequests(status:queued)` → `queued[0]` | **Admission** (§5): take up to `parallelism` from the FIFO head. |
| `acquireLock` / `heartbeat` / `releaseLock` (per-attempt) | **Lane lock** (§9): once per batch at start / single batch-lifetime timer / once at drain. The per-attempt acquire/release in `loop.ts` is removed. |
| `pickupMergeRequest` | **Admission per member** (§3.2): `pickup` each admitted member. |
| `worktree.resetForAttempt()` + corruption repair | **Pool acquire + per-slot repair** (Step 3 `worktree-pool.ts`): lease a slot, `repair()` just that slot on corruption (§15). |
| `resolveRef("HEAD")` → baseSha | **Speculative base** (§4): member 0 → live main; member K → predecessor's `rebasedTreeSha` (after the §4.3 cross-worktree fetch). |
| `startAttempt(baseSha)` | **Per member** with the speculative baseSha. |
| `rebaseOnto(baseSha, ref)` | **Speculative rebase** (§4); `RebaseConflict` → member `failed` → §7. |
| `runVerify(...)` | **Concurrent** (§5): N verifies overlap, one per worktree. |
| `push` / `non_fast_forward` / `land` | **Land serialization** (§6): the ordered land-gate loop; fast-forward-or-reverify; push-race → re-admit. |
| `reject` | **Suffix invalidation** (§7): reject K + structurally compute and tear down the dependent suffix + re-admit. |
| retry-on-transient (new) | **Verify retry policy** (§10). |

`runLoop`'s outer "poll/SSE wait then drain" structure (7.1 `loop.ts:runLoop`) is preserved: when the lane is idle the scheduler `waitForWork`s; when work exists and the lane is unowned it acquires the lock and runs a batch to drain.

**`parallelism: 1` regression guard.** With `parallelism === 1`: the pool has one slot, the scheduler admits one member at a time, its `speculativePosition` is always 0, its `predecessorChain` is always empty, its base is always live `main`, it lands immediately after verify, then the next request is admitted. This is observably identical to 7.1 `runOnce` — same PM transitions, same single attempt per request, same one-acquire-one-release-per-land lock usage (the batch of one acquires at start and releases at drain = one member). Step 4 and Step 10 assert this explicitly against the 7.1 `loop.test.ts` equivalents.

---

## 15. Failure-mode catalog additions

Extends 7.1 §15. (symptom / recovery / final state):

| Failure | Symptom | Recovery | Final state |
|---|---|---|---|
| **Pool exhaustion** (all `parallelism` slots leased) | New queued requests not picked up; queue depth grows | **Backpressure** (§11): queued requests stay `queued`, none dropped, none picked up. Slots free as members terminate; the scheduler admits the next FIFO request. | Eventually admitted + landed/rejected. |
| **One slot corrupt mid-batch** | A member's git op fails on a corrupt `.git` in its slot | `pool.repair(wt)` rebuilds **that slot only** (delete + re-clone via the existing `worktree.repair()` per-slot logic — separate clones mean other slots are untouched). The member in that slot is `resetToQueued`'d and re-admitted (§8). Other members continue. | Re-admitted member lands/rejects; batch otherwise proceeds. |
| **Integrator crash mid-batch** | In-memory batch lost; lane lock held by dead process; N requests stuck `integrating` | Lane lock TTL-frees in ≤5 min (§9.4); next integrator's `acquire` reclaims. Restart crash-recovery sweep (`reclaimStrandedRequests`, §12 finding 1) resets **ALL** `integrating` in the lane → `queued`. **No orphan main advance** — a push only happens under the live lock (§9.5). | All in-flight requests re-queued; reintegrated on the next batch. |
| **Member verify hangs** | One member's verify exceeds `verify_timeout_sec` | Per-member `runVerify` timeout fires; `killTree` kills **just that** child subtree (§10); `timedOut === true` → category `verify_timeout` (real, not retried, §10.3) → reject + suffix invalidation (§7). Siblings untouched. | That member `rejected`; its dependent suffix re-admitted. |
| **Predecessor stale at land** | At `landMember`, live `main` ≠ expected predecessor SHA (or push returns `non_fast_forward`) | Fast-forward-or-reverify guard (§6.2 step 4 / §6.3): `resetToQueued` + re-admit with corrected base, re-verify. Should not occur while holding the lane lock; guarded regardless. | Member re-verified then landed. |

---

## 16. Implementation notes / deviations (post-ship)

This section records where the **shipped code** (Steps 2–10) diverged from the design above and why.
The design sections remain the authoritative *contract*; these are the soundness-driven adjustments
made during implementation. Everything not listed here shipped as designed.

1. **Step 4 / Step 5 concurrency boundary moved (4 → 5).** §14 maps "concurrent verify" to Step 5,
   but the original roadmap cut Step 4 as "core scheduler incl. concurrency." During Step 4 the
   verifier proved that **sound concurrent lands cannot precede speculation**: serialized lands over
   independent-on-`main` bases mathematically force a non-fast-forward (drift → requeue → re-verify)
   on every member after position 0 — strictly worse than serial, contradicting the §4.5 happy path.
   So Step 4 was **re-cut as a single-member-at-a-time scheduler** delivering the full skeleton
   (Batch/Member model, lane-lock-once lifecycle, pool acquire/release, structural land-gate §6.1,
   backpressure, the `computeSpeculativeBase`/`onMemberFailed` seams, `parallelism:1`==`runOnce`
   parity). **True N-concurrency + speculation arrived together in Step 5** — the only point where
   N-in-flight produces clean fast-forward lands. The campaign end-state is unchanged; only the
   concurrency-introduction boundary moved.

2. **Field/name realizations vs the §3.1 sketch.** The shipped `batch.ts` types match §3 in spirit
   but differ in surface naming: `VerifyHandle` carries `{ done, kill }` (not `{ promise, kill }`);
   the killable verify is driven by an **`AbortSignal`** (`controller.abort()` → git-ops `runVerify`'s
   `signal` option → the existing `killTree`), not a bespoke `kill()` plumbing — there is exactly one
   kill path. The `Batch` interface also carries a `nextPosition` strictly-monotonic admission counter
   (see note 3). `Member` snapshots the full `MergeRequestView` as `member.request` rather than the
   flattened `requestId`/`taskId`/`branch`/… fields shown in the §3.1 sketch.

3. **`speculativePosition` is a strictly-monotonic admission index (never `position - 1`).** A
   mandatory Step-5 verifier fix: the chaining/land predecessor is derived from the **surviving
   prefix** (members that are not `failed`/`invalidated`, ordered by position) via
   `survivingPredecessor`, **not** from `speculativePosition - 1` over the unfiltered array. A failed
   member is left in `members` with its stale position but filtered out of every surviving-prefix walk,
   so it can never be mistaken for a predecessor (neither at speculative-base time nor at
   land-time `expectedMainSha`). The admission counter (`Batch.nextPosition`) never decrements or reuses
   an index, so positions stay collision-free even as members fail/re-admit.

4. **Three cascade-race guards in suffix invalidation (§7.3).** The naïve "mark suffix invalidated +
   PM-reset each" interleaves state mutation with `await`s and races a still-running suffix verify's
   continuation. The shipped `invalidateSuffix` splits into **(FIX 1)** a synchronous first pass that
   tears down the *entire* suffix (kill verify, set `state="invalidated"`, null `verify`, release
   worktree) **before any `await`**, then **(FIX 2)** an async second pass doing the PM calls; the
   killed verify's continuation re-checks `member.state !== "verifying"` after its `runVerify` await
   (the **post-await bail-guard**, in `runVerifyTask`) and returns without double-rejecting. A **third
   window** the executor found and closed: a member is **not pushed into `batch.members` until after
   its `predecessorChain` is materialized** (so `computeSuffix` never sees an empty-chain member that
   would wrongly survive), with additional `invalidated`-state guards after the `startAttempt` and
   `rebaseOnto` awaits in `admitAndRebase`.

5. **`completeAttempt(failed)` for superseded transient retries.** §10.4 describes each retry as a
   fresh attempt row. The PM `completeAttempt` status enum is `[passed, failed, cancelled]` — a
   superseded transient attempt is completed with **`status: "failed"`** (`failureCategory: "other"`,
   reason "transient verify failure; retrying"), then a new attempt is started against the **same**
   `baseShaOf(member.base)` with identical `{ batchId, speculativePosition }` tags. The retry loop
   lives **inside** `runVerifyTask` so the handle/`AbortSignal` is stable across iterations, and the
   backoff sleep is **abortable** (a suffix-kill during backoff wakes it; a post-sleep state guard
   immediately before `startAttempt` then bails). The backoff schedule is the literal **1s / 5s / 15s**
   (cap 3), matching §10.2.

6. **Transient classification: `spawnError` == `exitCode 127`.** §10.1/§10.3 describe spawn-failure as
   "transient." In the shipped code a spawn-level failure (`ENOENT`/`EACCES`) surfaces from git-ops
   `runVerify` as `finish(127, null)` **with a `spawnError` string set**; `classifyVerifyFailure`
   (categorize.ts) keys off `spawnError` (not the literal `127`) and orders the checks
   **`timedOut` → real first** (our own verify-timeout carries `signal: SIGTERM` + null exit but must
   be real), then `spawnError` → transient, then external-signal-kill (null exit + signal) → transient,
   then `exitCode !== 0` → real. The classifier is the integrator-side `classifyVerifyFailure`, layered
   on top of the unchanged `categorize` (which still produces the reject-payload category).

7. **No `merge_batch` table; relay validates with a local Zod-4 union.** As designed (§13.2) the relay
   endpoint persists nothing. The shipped `routes/merge-batches.ts` validates the body with a **local**
   discriminated union declared in the route (the `@hono/zod-openapi` zod-4 instance), mirroring the
   integrator's `BatchEvent` type field-for-field — it does **not** import a `@pm/shared` schema. The
   `ai_agent`-only gate is an inline `user.type !== "ai_agent"` → 403 check.

---

## Appendix A: Cross-reference to Steps 2–11

Every later step finds its contracts in this document:

| Roadmap step | Sections of this doc |
|---|---|
| Step 2 — Per-project `parallelism` config | §2 (naming: `parallelism`, camelCase vs snake_case), §1.1 (decision 4, default 1). |
| Step 3 — Worktree pool (`worktree-pool.ts`) | §2 (module name), §5 (concurrency model), §11 (backpressure: idle-slot admission), §15 (corrupt-slot repair). |
| Step 4 — Batch scheduler (`batch.ts`, the core) | §3 (in-memory model), §5 (concurrency), §11 (backpressure), §14 (runOnce→scheduler map + `parallelism:1` regression guard). |
| Step 5 — Speculative rebase + concurrent verify | §4 (speculative base chains, **incl. §4.3 cross-worktree materialization — implement + test**), §5 (concurrent verify). |
| Step 6 — Land serialization + suffix invalidation | §6 (structural land-gate), §7 (suffix invalidation), §8 (re-admission decision). |
| Step 7 — Batch observability (events) | §13 (tagged events + the exact `events.ts` wire-frame edit, the 4 markers, the relay endpoint, `EVENT_NAMES` additions). |
| Step 8 — Verify retry policy | §10 (transient vs real, `classifyTransient`, backoff/cap, retries-as-attempts). |
| Step 9 — Lane-ownership lock migration | §9 (acquire-once/heartbeat/release-on-drain, crash handling, the removed per-attempt lock), §12 finding 1 (crash-recovery handles N). |
| Step 10 — Full-stack E2E for batching | §5, §6, §7, §11, §14 (`parallelism:1` parity), §15 (the failure flows). |
| Step 11 — Documentation | §2 (config key, worktree paths via Step 3, event names, endpoint), §9 (lock model), §13 (events), §15 (new failure modes). |

---

## Appendix B: Settled-decisions compliance checklist

A final self-check that each of the five non-negotiable decisions is respected by this design:

- [x] **Decision 1 (integrator-owned, in-memory; no PM batch tables / no `GET /merge-batches`).** §3 keeps the batch purely in integrator memory; §1.2 records the no-tables / no-query-API non-goals and the explicit vision-override; §12 confirms zero PM schema/state changes; §13 delivers observability via events only.
- [x] **Decision 2 (full speculative batching, suffix invalidation).** §4 builds the full `main+0+…+K-1` chains; §6 serializes lands in order; §7 invalidates exactly the dependent suffix while predecessors still land.
- [x] **Decision 3 (lock = lane ownership, once per batch).** §9 acquires once at batch start, heartbeats for the batch lifetime, releases on drain; removes the per-attempt lock; the lock is the structural guard against two integrators pushing main.
- [x] **Decision 4 (`parallelism: 1` = 7.1 behavior, default).** §1.3 prime invariant + §14 `parallelism:1` regression guard make a batch-of-one observably identical to 7.1 `runOnce`; §2 sets default 1.
- [x] **Decision 5 (PM tolerates N concurrent `integrating`).** §12's seven-point audit confirms PM needs no code change; the only PM additions are the additive event tags + relay endpoint.
