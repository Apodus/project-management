import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════
// Phase 7.4 observability wire schemas (design §3.2/§3.4, §5.6, §8.3).
//
// These are the CANONICAL shapes for the dashboard data API. The server
// routes (routes/integrator-health.ts, routes/train.ts, routes/merge-
// requests.ts) carry structurally-identical Zod-4 mirrors in their
// createRoute/.openapi() blocks (the established Zod-3-shared / Zod-4-route
// split, 7.2 §2 / 7.3 §2.1) — never import these Zod-3 schemas into a route.
//
// Naming convention (matched to the shipped routes):
//   • heartbeat / health / metrics / in-flight ⇒ snake_case on the wire
//     (mirroring routes/integrator-health.ts + routes/train.ts §5.6).
//   • the per-request timeline ⇒ camelCase (mirroring routes/merge-requests.ts).
// ═══════════════════════════════════════════════════════════════════

// ─── Heartbeat (§3.2 — the integrator POSTs this) ─────────────────
// pool_utilization.size/leased + status + version are required; in_flight
// defaults to all-zero. snake_case on the wire — the integrator mints it.
//
// last_release_failure (C2 failure legibility) is TRI-STATE: absent (an old
// integrator that predates the field) → PM leaves the stored value untouched;
// explicit null → PM clears it; { at, message } → PM records the failed
// lane-lock release. Optional so old→new and new→old stay compatible.
export const releaseFailureSchema = z.object({
  at: z.string().min(1),
  message: z.string(),
});
export type ReleaseFailure = z.infer<typeof releaseFailureSchema>;

export const integratorHeartbeatSchema = z.object({
  resource: z.string().min(1).default("main"),
  status: z.enum(["idle", "integrating"]),
  pool_utilization: z.object({
    size: z.number().int(),
    leased: z.number().int(),
  }),
  in_flight: z
    .object({
      requests: z.number().int().default(0),
      batches: z.number().int().default(0),
      groups: z.number().int().default(0),
    })
    .default({ requests: 0, batches: 0, groups: 0 }),
  version: z.string().min(1),
  last_release_failure: releaseFailureSchema.nullable().optional(),
});
export type IntegratorHeartbeat = z.infer<typeof integratorHeartbeatSchema>;

// ─── Integrator health view (§3.4 — the on-read GET response) ─────
// Carries the derived staleness_ms + healthy flag + the denormalized payload.
// status is "idle" | "integrating" | "never_seen" (never-seen = no heartbeat
// has ever arrived). last_seen_at/staleness_ms are null in the never_seen view.
export const integratorHealthView = z.object({
  resource: z.string(),
  status: z.string(),
  healthy: z.boolean(),
  last_seen_at: z.string().nullable(),
  staleness_ms: z.number().nullable(),
  pool_size: z.number().nullable(),
  pool_leased: z.number().nullable(),
  in_flight_requests: z.number(),
  in_flight_batches: z.number(),
  in_flight_groups: z.number(),
  version: z.string().nullable(),
  integrator_id: z.string().nullable(),
  // C2: the lane's most recent failed lock release (null = none recorded /
  // cleared by a subsequent successful release). Why a lane idles while work
  // queues — durable on integrator_health, surfaced on the dashboard.
  last_release_failure: releaseFailureSchema.nullable(),
});
export type IntegratorHealthView = z.infer<typeof integratorHealthView>;

// ─── SLO compliance (§6.2) ────────────────────────────────────────
// A per-dimension verdict: target_sec/measured_ms for the time-to-land
// dimension, target/measured (0–1 ratios) for the rate dimensions. A
// dimension with no configured target is OMITTED (not present), not null.
export const sloDimensionSchema = z.object({
  target_sec: z.number().optional(),
  target: z.number().optional(),
  measured_ms: z.number().nullable().optional(),
  measured: z.number().nullable().optional(),
  compliant: z.boolean(),
});
export type SloDimension = z.infer<typeof sloDimensionSchema>;

export const sloBlockSchema = z.object({
  p95_time_to_land: sloDimensionSchema.optional(),
  verify_success_rate: sloDimensionSchema.optional(),
  abandon_rate: sloDimensionSchema.optional(),
  // AND of the configured dimensions; null when none are configured.
  overall_compliant: z.boolean().nullable(),
});
export type SloBlock = z.infer<typeof sloBlockSchema>;

// ─── Metric bundle (§5.6 — the metrics GET response) ──────────────
// Computed on-read per (project, resource) lane. The embedded `health` block
// is the §3.4 view so the dashboard gets metrics + freshness in one request.
export const metricsBundleSchema = z.object({
  resource: z.string(),
  queue_depth: z.number(),
  in_flight: z.number(),
  time_to_land: z.object({
    p50_ms: z.number().nullable(),
    p95_ms: z.number().nullable(),
    p99_ms: z.number().nullable(),
    sample_size: z.number(),
  }),
  verify_success_rate: z.object({
    ratio: z.number().nullable(),
    passed: z.number(),
    total: z.number(),
  }),
  abandon_rate: z.object({
    ratio: z.number().nullable(),
    abandoned: z.number(),
    resolved: z.number(),
  }),
  pool_utilization: z.object({
    size: z.number().nullable(),
    leased: z.number().nullable(),
    ratio: z.number().nullable(),
  }),
  health: integratorHealthView,
  slo: sloBlockSchema,
  window_hours: z.number(),
  computed_at: z.string(),
});
export type MetricsBundleView = z.infer<typeof metricsBundleSchema>;

// ─── Claims health (Campaign C3 §P5a — the claims-health GET response) ─
// The per-project stale-claim aggregate that backs the edge-triggered
// stale-claim alert (mirroring train.stuck). staleCount = work items claimed
// but inactive past the lease TTL+grace; oldestStaleAgeMs = elapsed time since
// the oldest stale claim lapsed (null when no stale claims). IDENTITY-MASKED:
// NO holder id is surfaced. snake_case on the wire (mirroring train.ts §5.6).
export const claimsHealthSchema = z.object({
  stale_count: z.number(),
  oldest_stale_age_ms: z.number().nullable(),
});
export type ClaimsHealthView = z.infer<typeof claimsHealthSchema>;

// ─── In-flight composition (§5.3 — the in-flight GET response) ────
// The lane's `integrating` requests (members) with each one's latest attempt +
// group_id, plus the forming/integrating group rows. The server does NOT
// compute speculativePosition/batchId — the dashboard enriches those from the
// SSE stream (7.2 events-not-tables contract). snake_case on the wire.
export const inFlightMemberSchema = z.object({
  id: z.string(),
  group_id: z.string().nullable(),
  status: z.string(),
  enqueued_at: z.string(),
  picked_up_at: z.string().nullable(),
  attempt: z
    .object({
      status: z.string(),
      base_sha: z.string(),
      tree_sha: z.string().nullable(),
      started_at: z.string().nullable(),
    })
    .nullable(),
});
export type InFlightMember = z.infer<typeof inFlightMemberSchema>;

export const inFlightGroupSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  resource: z.string(),
  state: z.string(),
  submitted_by: z.string(),
  integrator_id: z.string().nullable(),
  resolved_at: z.string().nullable(),
  resolution_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type InFlightGroup = z.infer<typeof inFlightGroupSchema>;

export const inFlightBundleSchema = z.object({
  groups: z.array(inFlightGroupSchema),
  members: z.array(inFlightMemberSchema),
});
export type InFlightBundleView = z.infer<typeof inFlightBundleSchema>;

// ─── Per-request timeline (§5.7 / §8.3 — the timeline GET response) ─
// The ordered state history of a request composed PM-side from: the request
// milestones, every attempt, the audit rows targeting it, and any orphaned-
// inner incident — sorted ascending by `at`. camelCase on the wire (the
// merge-requests.ts convention: landedSha/enqueuedAt, NOT snake_case).
export const timelineEventSchema = z.object({
  at: z.string(),
  kind: z.enum([
    "queued",
    "integrating",
    "landed",
    "rejected",
    "abandoned",
    "attempt",
    "audit",
    "incident",
  ]),
  // attempt
  attemptNumber: z.number().int().optional(),
  baseSha: z.string().nullable().optional(),
  treeSha: z.string().nullable().optional(),
  status: z.string().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  failureCategory: z.string().nullable().optional(),
  logExcerpt: z.string().nullable().optional(),
  logUrl: z.string().nullable().optional(),
  // terminal milestones
  landedSha: z.string().nullable().optional(),
  rejectCategory: z.string().nullable().optional(),
  rejectReason: z.string().nullable().optional(),
  // audit
  action: z.string().optional(),
  actorId: z.string().optional(),
  reason: z.string().nullable().optional(),
  metadataBefore: z.record(z.string(), z.unknown()).nullable().optional(),
  metadataAfter: z.record(z.string(), z.unknown()).nullable().optional(),
  // incident
  type: z.string().optional(),
  orphanedSha: z.string().optional(),
  state: z.string().optional(),
  openedAt: z.string().optional(),
  resolvedAt: z.string().nullable().optional(),
  resolution: z.unknown().optional(),
});
export type TimelineEventView = z.infer<typeof timelineEventSchema>;

export const timelineSchema = z.object({
  request: z.object({
    id: z.string(),
    projectId: z.string(),
    resource: z.string(),
    submittedBy: z.string(),
    taskId: z.string().nullable(),
    branch: z.string().nullable(),
    commitSha: z.string().nullable(),
    verifyCmd: z.string().nullable(),
    worktreePath: z.string().nullable(),
    status: z.string(),
    enqueuedAt: z.string(),
    pickedUpAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    landedSha: z.string().nullable(),
    rejectCategory: z.string().nullable(),
    rejectReason: z.string().nullable(),
    failedFiles: z.array(z.string()).nullable(),
    logExcerpt: z.string().nullable(),
    logUrl: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  events: z.array(timelineEventSchema),
});
export type TimelineView = z.infer<typeof timelineSchema>;
