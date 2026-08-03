// All enums as `as const` arrays with derived union types.
// This is the single source of truth for allowed values.

export const PROJECT_STATUSES = ["active", "paused", "archived", "completed"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROPOSAL_STATUSES = [
  "open",
  "discussing",
  "accepted",
  "in_progress",
  "completed",
  "rejected",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const CLAIM_STATUSES = ["unclaimed", "claimed_by_you", "claimed_by_other"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

// Campaign C3 (liveness surfacing §P1) — the identity-masked liveness view of a
// claim, derived on read from the C2 claim-lease (deriveLiveness) + the caller:
//   unclaimed — no holder
//   yours     — the caller holds it (regardless of lease liveness; self-stale → yours)
//   live      — held by another, lease live (or absent → fail-safe-to-live)
//   stale     — held by another, lease lapsed past TTL+grace
// Sits alongside CLAIM_STATUSES (which is holder-vs-caller only); CLAIM_STATES
// additionally folds in lease liveness for non-self holders.
export const CLAIM_STATES = ["unclaimed", "live", "stale", "yours"] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

export const EPIC_STATUSES = ["draft", "active", "completed", "cancelled"] as const;
export type EpicStatus = (typeof EPIC_STATUSES)[number];

export const TASK_STATUSES = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const MILESTONE_STATUSES = ["open", "closed"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TASK_TYPES = ["feature", "bug", "chore", "spike", "design", "research"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const EFFORT_SIZES = ["xs", "s", "m", "l", "xl"] as const;
export type EffortSize = (typeof EFFORT_SIZES)[number];

export const USER_ROLES = ["admin", "member"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_TYPES = ["human", "ai_agent"] as const;
export type UserType = (typeof USER_TYPES)[number];

export const COMMENT_TYPES = [
  "comment",
  "progress_update",
  "decision",
  "question",
  "handoff",
  "review_note",
  "design_discussion",
  "merge_rejection",
  "merge_incident",
] as const;
export type CommentType = (typeof COMMENT_TYPES)[number];

export const DEPENDENCY_TYPES = ["blocks", "relates_to"] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

// Epic-graph node health (C1.P4). Precedence ladder (first match wins):
//   done > blocked > at_risk > not_started > on_track
export const EPIC_HEALTHS = ["not_started", "on_track", "at_risk", "blocked", "done"] as const;
export type EpicHealth = (typeof EPIC_HEALTHS)[number];

// Phase 7.5 — verify cache mode (design §2/§4.3). Per-project cache_mode
// governs how the verify cache is used when cache_enabled is true:
//   off    — never look up, never write (inert; same as cache_enabled:false)
//   on     — hit skips the run and reuses the verdict; miss runs + records
//   shadow — always run, compare the real verdict to the cached one (emit
//            verify.cache_mismatch on a discrepancy), ALWAYS use the real verdict
export const CACHE_MODES = ["off", "on", "shadow"] as const;
export type CacheMode = (typeof CACHE_MODES)[number];

// Phase 7.5 — the binary verify verdict stored in verify_cache (design §2/§3.1).
// Named VerifyResultValue (NOT VerifyResult) to avoid colliding with the
// integrator-ref VerifyResult INTERFACE (git-ops.ts).
export const VERIFY_RESULTS = ["pass", "fail"] as const;
export type VerifyResultValue = (typeof VERIFY_RESULTS)[number];

// Campaign C2/C4 (claim-lease) — the claim-lease engine is ALWAYS active: every
// agent claim creates a lease (unconditional, see acquireLease), liveness is
// always derived, and the reclaim sweep ALWAYS clears a lapsed claim. There is
// no on/off/shadow kill-switch — a claim without a lease is impossible by
// construction, so "no lease ⇒ stale by definition". Only the durations are
// tunable (PM_LEASE_TTL_SEC / PM_LEASE_GRACE_SEC).

// Per-project responder auto-implement mode (campaign — per-project settings).
// Governs how the responder's auto-implement land path runs for a project, the
// same off/shadow/on kill-switch ladder as CACHE_MODES:
//   off    — never auto-implement (inert)
//   shadow — observe the branch/diff without landing (safe observe-first rung)
//   on     — autonomous (the merge-train verify gate is still the floor)
// Identical by VALUE to responder-ref's RESPONDER_MODES, but defined here as its
// own const so shared/server carry no dependency on the daemon package (and no
// semantic coupling to CACHE_MODES — a distinct concern).
export const AUTO_IMPLEMENT_MODES = ["off", "shadow", "on"] as const;
export type AutoImplementMode = (typeof AUTO_IMPLEMENT_MODES)[number];

// T1·P3 — per-project notes-triage rollout mode. Same off/shadow/on ladder as
// AUTO_IMPLEMENT_MODES, defined as its OWN const for semantic independence
// (notes-triage is a distinct concern; identical by VALUE only — no coupling),
// exactly as AUTO_IMPLEMENT_MODES is kept distinct from CACHE_MODES.
export const NOTES_TRIAGE_MODES = ["off", "shadow", "on"] as const;
export type NotesTriageMode = (typeof NOTES_TRIAGE_MODES)[number];

// T2·P1 — triage decision kinds. The disposition recorded on a uniform
// `triage_decisions` side-log row that BOTH shadow- and on-mode triage write
// (via a decoupled record() that NEVER mutates a note). This is the contract T3
// reads. Plain text in the DB (no enum CHECK), validated in the app layer.
//   promote_standard / promote_fast_track — would mint a standard/fast_track proposal
//   dismiss     — would terminally dismiss the note
//   needs_human — would punt the note to a human
//   give_up     — the triage actor declined to act (no disposition)
export const TRIAGE_DECISION_KINDS = [
  "promote_standard",
  "promote_fast_track",
  "dismiss",
  "needs_human",
  "give_up",
] as const;
export type TriageDecisionKind = (typeof TRIAGE_DECISION_KINDS)[number];

// T1·P2 — proposal flavor. An ADVISORY routing label, NOT an authz seal: a
// fast_track proposal is byte-identical in lifecycle to a standard one (same
// transition map, same claim/implement gates). It only signals intent/routing.
export const PROPOSAL_KINDS = ["standard", "fast_track"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

// The lease TTL: a holder must heartbeat within this window or the lease
// lapses and becomes reclaimable. 30 minutes.
export const LEASE_TTL_MS_DEFAULT = 30 * 60 * 1000;
// The reclaim grace beyond expiry before a lapsed lease is actually swept.
// Deliberately LONG (24h) because the campaign ships in shadow mode — we
// want to observe lapses without aggressively reclaiming while the engine
// is not yet the source of truth.
export const LEASE_GRACE_MS_DEFAULT = 24 * 60 * 60 * 1000;
// Campaign C2 (notes triage §P5) — an OPEN note aging past this threshold fires
// the edge-triggered backlog-age alert. On-read constant idiom, mirroring
// LEASE_GRACE_MS_DEFAULT (detection is a side effect of an on-read aggregate,
// latched on notes_alert_state). 7 days.
export const NOTES_BACKLOG_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
// Campaign C4 (agent escalation channel §P3) — a NON-RESOLVED escalation with NO
// directed reply aging past this threshold fires the edge-triggered unanswered-SLA
// alert (escalation.sla_breached). Same on-read constant idiom as
// NOTES_BACKLOG_THRESHOLD_MS (detection is a side effect of an on-read aggregate,
// latched on escalation_alert_state). 1 hour — an unanswered escalation is far
// more time-sensitive than an untriaged note.
export const ESCALATION_SLA_BREACH_THRESHOLD_MS = 60 * 60 * 1000;
// T3·P4 (notes triage autonomy) — the "triage not draining" threshold. When
// on-mode triage is enabled but the OLDEST open note has aged past this AND the
// triage agent has recorded NO decision within this same window, the
// edge-triggered triage.stalled alert fires (latched on
// notes_alert_state.triage_stalled_notified). Same on-read constant idiom as
// NOTES_BACKLOG_THRESHOLD_MS / ESCALATION_SLA_BREACH_THRESHOLD_MS. 6 hours —
// tunable; set well beyond the daemon poll interval + per-note assessment
// time-budget + brief outages, so it is operator-actionable (a genuine "triage
// is not draining" signal) and never a flap. This is HONEST about what it
// observes — a stalled drain, NOT a daemon-down proof (a quiet-but-alive daemon
// records nothing; see triage-metrics.service heartbeat).
export const TRIAGE_STALL_THRESHOLD_MS = 6 * 60 * 60 * 1000;
// A stricter-than-sweep margin (60s) ADDED to the grace when pick-next decides
// whether to reclaim-then-claim a stale-claimed task (C3.P3, mode `on` only).
// A pick is a hostile takeover of another holder's work, so it demands a lease
// be lapsed by an extra margin beyond the plain reclaim grace — a just-lapsed
// lease (its holder possibly mid-action) is never grabbed out from under them.
export const LEASE_PICK_MARGIN_MS_DEFAULT = 60 * 1000;

// Train phase-timing taxonomy (campaign 2026-08-03 §P1 — "where did the 39
// minutes go"). The phase set is PARTITIONED into two disjoint halves, and the
// partition itself is the anti-double-count invariant:
//   DERIVED  — PM computes these on read from timestamps it already owns
//              (merge_requests.enqueued_at/picked_up_at, merge_request_groups.
//              created_at). They are NEVER stored and NEVER ingested: the ingest
//              schema's phase enum is MERGE_PHASES_OBSERVED, so an over-eager
//              daemon that also emits `queue_wait` is rejected at the wire (400)
//              instead of silently double-counting the wait.
//   OBSERVED — only the integrator can see these (it is the only process inside
//              the worktree), so they arrive over the ingest route and nowhere
//              else.
// MERGE_PHASES is DERIVED ++ OBSERVED in PIPELINE ORDER — forming → queue_wait →
// assemble → materialize → rebase → verify → land. That order IS the render-order
// contract the aggregation (P3) and the stacked bar / event trace (P4/P5) read;
// never sort it alphabetically, and insert a new phase at its real place in the
// pipeline.
export const MERGE_PHASES_DERIVED = ["forming", "queue_wait"] as const;
export type MergeDerivedPhase = (typeof MERGE_PHASES_DERIVED)[number];

export const MERGE_PHASES_OBSERVED = [
  "assemble",
  "materialize",
  "rebase",
  "verify",
  "land",
] as const;
export type MergeObservedPhase = (typeof MERGE_PHASES_OBSERVED)[number];

export const MERGE_PHASES = [...MERGE_PHASES_DERIVED, ...MERGE_PHASES_OBSERVED] as const;
export type MergePhase = (typeof MERGE_PHASES)[number];

// How a DERIVED phase's `startedAt` was chosen — the discriminator that keeps a
// re-queued request honest. `exact` = the window really did start at submit /
// group creation. `requeued` = a prior integration ended inside the window (the
// request was put back), so the window was re-anchored to that end and only the
// LAST queue segment is charged to queue time.
export const MERGE_PHASE_BASES = ["exact", "requeued"] as const;
export type MergePhaseBasis = (typeof MERGE_PHASE_BASES)[number];

// Train event-trace taxonomy (campaign 2026-08-03 §P5 — "what happened lately
// and what took how long"). One vocabulary shared by the merged feed's three
// producers, so a reader never has to know which table an entry came from.
//
// SOURCE is provenance, not meaning: `phase` = a merge_phase_timings row,
// `audit` = an audit_log row, `entity` = a fact read straight off an entity
// table (a pickup timestamp, a group's terminal state, an incident's opened_at).
// It exists for two reasons only: composite-id uniqueness and a deterministic
// tiebreak when two entries share an instant.
export const TRAIN_TRACE_SOURCES = ["phase", "audit", "entity"] as const;
export type TrainTraceSource = (typeof TRAIN_TRACE_SOURCES)[number];

// KIND is what happened. Deliberately EXCLUDED, and the exclusion list is the
// same one the Discord train feed uses (events/train-feed-listener.ts) because
// the two surfaces must tell ONE story: attempt start/complete, the Phase-7.2
// batch markers, `merge.resolution.*` (its own dashboard card) and the `train.*`
// threshold alerts (edge-triggered aggregates that live on the health card).
export const TRAIN_TRACE_KINDS = [
  // Telemetry — one completed phase of a trip.
  "phase",
  // Trip starts.
  "picked_up",
  "group_started",
  // Trip outcomes.
  "landed",
  "rejected",
  "group_landed",
  "group_rejected",
  "group_partially_landed",
  "requeued",
  "cancelled",
  // Cross-repo incidents.
  "incident_opened",
  // Lane control + break-glass (every one of these is an operator act).
  "paused",
  "resumed",
  "lock_force_released",
  "force_landed",
  "force_rejected",
  "force_cancelled",
  // Assembly-time interpretations of a cross-repo outer member.
  "outer_converted",
  "outer_gitlink_normalized",
] as const;
export type TrainTraceKind = (typeof TRAIN_TRACE_KINDS)[number];

// What an entry is ABOUT. `lane` covers the lane-level acts (pause / resume /
// force-release) whose "subject" is the resource name, not a row id.
export const TRAIN_TRACE_SUBJECT_TYPES = ["request", "group", "incident", "lane"] as const;
export type TrainTraceSubjectType = (typeof TRAIN_TRACE_SUBJECT_TYPES)[number];

// How an entry's `elapsed` number was obtained — the discriminator that stops a
// renderer printing "took 42m" over a number that is not a duration OF the
// event. See schemas/train-trace.ts for the full contract; the two derived
// bases are exactly MERGE_PHASES_DERIVED, so a derived elapsed always says
// WHICH wait it measured, and `none` is the explicit "this event has no
// anchored duration" case (it carries NO number at all — never a zero).
export const TRAIN_TRACE_ELAPSED_BASES = [
  "phase",
  "forming",
  "queue_wait",
  "since_pickup",
  "none",
] as const;
export type TrainTraceElapsedBasis = (typeof TRAIN_TRACE_ELAPSED_BASES)[number];

export const GIT_REF_TYPES = ["branch", "commit", "pull_request", "landed_sha"] as const;
export type GitRefType = (typeof GIT_REF_TYPES)[number];

export const GIT_REF_STATUSES = ["open", "merged", "closed"] as const;
export type GitRefStatus = (typeof GIT_REF_STATUSES)[number];

export const ENTITY_TYPES = ["project", "proposal", "epic", "task", "comment"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ACTIVITY_ACTIONS = [
  "created",
  "updated",
  "status_changed",
  "assigned",
  "commented",
  "dependency_added",
  "dependency_removed",
  "label_added",
  "label_removed",
  "archived",
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];
