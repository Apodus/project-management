import { EventEmitter } from "node:events";

// ─── Event names ─────────────────────────────────────────────────

export const EVENT_NAMES = {
  // Project events
  PROJECT_CREATED: "project.created",
  PROJECT_UPDATED: "project.updated",
  PROJECT_ARCHIVED: "project.archived",

  // Proposal events
  PROPOSAL_CREATED: "proposal.created",
  PROPOSAL_TRANSITIONED: "proposal.transitioned",
  PROPOSAL_COMMENTED: "proposal.commented",
  PROPOSAL_PLANNED: "proposal.planned",
  PROPOSAL_CLAIMED: "proposal.claimed",
  PROPOSAL_RELEASED: "proposal.released",

  // Epic events
  EPIC_CREATED: "epic.created",
  EPIC_UPDATED: "epic.updated",
  EPIC_ARCHIVED: "epic.archived",
  EPIC_CLAIMED: "epic.claimed",
  EPIC_RELEASED: "epic.released",

  // Task events
  TASK_CREATED: "task.created",
  TASK_UPDATED: "task.updated",
  TASK_STATUS_CHANGED: "task.status_changed",
  TASK_ASSIGNED: "task.assigned",
  TASK_COMMENTED: "task.commented",
  TASK_ARCHIVED: "task.archived",

  // Comment events
  COMMENT_CREATED: "comment.created",
  COMMENT_UPDATED: "comment.updated",
  COMMENT_DELETED: "comment.deleted",

  // Task claim events
  TASK_CLAIMED: "task.claimed",
  TASK_RELEASED: "task.released",

  // Force-claim events (reason-required claim takeover)
  TASK_CLAIM_FORCED: "task.claim_forced",
  EPIC_CLAIM_FORCED: "epic.claim_forced",
  PROPOSAL_CLAIM_FORCED: "proposal.claim_forced",

  // Claim-lease reclaim event (Phase C2 — emitted by claim-lease.service after
  // a stale claim is reclaimed in mode `on`). onAll auto-forwards it to the SSE
  // stream; action maps to "assigned" (see events/listeners.ts).
  CLAIM_LEASE_RECLAIMED: "claim.lease.reclaimed",

  // Stale-claim alert (Campaign C3 §P5a — emitted by claims-health.service
  // computeClaimsHealth when a project has work items claimed-but-inactive past
  // the lease TTL+grace). Edge-triggered (once per stale episode, latched on
  // claims_alert_state), mirroring train.stuck. onAll auto-forwards it to the
  // SSE stream (banner) AND it drives the outbound Discord listener
  // (events/alerts-listener.ts). Identity-masked: the payload carries NO holder
  // id — only an aggregate count + the oldest-stale age.
  CLAIM_STALE_ALERT: "claim.stale_alert",

  // Merge lock events
  MERGE_LOCK_ACQUIRED: "merge.lock.acquired",
  MERGE_LOCK_QUEUED: "merge.lock.queued",
  MERGE_LOCK_RELEASED: "merge.lock.released",
  MERGE_LOCK_GRANTED: "merge.lock.granted",
  MERGE_LOCK_EXPIRED: "merge.lock.expired",

  // Merge request events (Phase 7.1 Stage 2 — request lifecycle)
  MERGE_REQUEST_QUEUED: "merge.request.queued",
  // A re-queue (integrating → queued) emitted by resetToQueued — distinct from
  // the worker's initial enqueue (MERGE_REQUEST_QUEUED) so a post-verify drift /
  // push-race / suffix-invalidation / crash-recovery re-queue is legible on the
  // live stream instead of masquerading as a fresh submit. Carries `reason`.
  // onAll auto-forwards it to the SSE stream; action becomes "request.requeued".
  MERGE_REQUEST_REQUEUED: "merge.request.requeued",
  MERGE_REQUEST_INTEGRATING: "merge.request.integrating",
  MERGE_REQUEST_LANDED: "merge.request.landed",
  MERGE_REQUEST_REJECTED: "merge.request.rejected",
  MERGE_REQUEST_ABANDONED: "merge.request.abandoned",

  // Merge attempt events (Phase 7.1 Stage 2 — attempt lifecycle)
  MERGE_ATTEMPT_STARTED: "merge.attempt.started",
  MERGE_ATTEMPT_COMPLETED: "merge.attempt.completed",

  // Merge batch markers (Phase 7.2 — integrator-relayed, not persisted)
  MERGE_BATCH_STARTED: "merge.batch.started",
  MERGE_BATCH_MEMBER_LANDED: "merge.batch.member_landed",
  MERGE_BATCH_MEMBER_INVALIDATED: "merge.batch.member_invalidated",
  MERGE_BATCH_COMPLETED: "merge.batch.completed",

  // Merge group events (Phase 7.3 — PM-owned, emitted by merge-group.service)
  MERGE_GROUP_STARTED: "merge.group.started",
  MERGE_GROUP_MEMBER_LANDED: "merge.group.member_landed",
  MERGE_GROUP_LANDED: "merge.group.landed",
  MERGE_GROUP_REJECTED: "merge.group.rejected",

  // Merge incident events (Phase 7.3 — PM-owned, emitted by merge-incident.service)
  MERGE_INCIDENT_OPENED: "merge.incident.opened",
  MERGE_INCIDENT_AUTO_RESOLVED: "merge.incident.auto_resolved",
  MERGE_INCIDENT_HUMAN_RESOLVED: "merge.incident.human_resolved",

  // Audit log events (Phase 7.4 §2.6 — PM-owned, emitted by audit.service
  // after each immutable audit write commits)
  AUDIT_RECORDED: "audit.recorded",

  // Train control + alert events (Phase 7.4 §9 — observability + break-glass).
  // Only the integrator-health alert is wired in Step 3; train.paused/resumed
  // + train.stuck/abandon_rate_high arrive in Steps 4/7. onAll auto-forwards
  // these to the SSE stream — no routes/events.ts edit needed.
  TRAIN_INTEGRATOR_UNHEALTHY: "train.integrator_unhealthy",
  TRAIN_PAUSED: "train.paused",
  TRAIN_RESUMED: "train.resumed",
  // On-read, edge-triggered alerts (Step 7 — §7.3). Evaluated in
  // metrics.service.checkAlerts; both ride the SSE stream (onAll) AND drive
  // the outbound Discord listener (events/alerts-listener.ts).
  TRAIN_STUCK: "train.stuck",
  TRAIN_ABANDON_RATE_HIGH: "train.abandon_rate_high",
  // A single-repo (parallelism=1, ungrouped) request stranded `integrating` —
  // an attempt started but never completed, older than verify_timeout+grace.
  // Closes the gap left by train.stuck (needs in-flight=0) and
  // integrator_unhealthy (needs a stale heartbeat); neither catches a request
  // stuck integrating while the integrator is still alive.
  TRAIN_INTEGRATION_STALLED: "train.integration_stalled",

  // Smart-verification (Phase 7.5 §9 — the shadow-mode false-pass detector).
  // Emitted (relayed, not persisted) when shadow mode finds a cached verdict
  // that disagrees with the real run. onAll auto-forwards it to the SSE stream;
  // action becomes "cache_mismatch".
  VERIFY_CACHE_MISMATCH: "verify.cache_mismatch",

  // Merge resolution events (Phase 7.6 §7 — PM-owned, emitted by
  // merge-resolution.service after each transition commits). The resolver
  // lifecycle: pending → resolving → resolved | escalated | failed. onAll
  // auto-forwards these to the SSE stream; routes/events.ts additively
  // projects resolution_id / origin_request_id / resolved_request_id.
  MERGE_RESOLUTION_PENDING: "merge.resolution.pending",
  MERGE_RESOLUTION_STARTED: "merge.resolution.started",
  MERGE_RESOLUTION_SUCCEEDED: "merge.resolution.succeeded",
  MERGE_RESOLUTION_ESCALATED: "merge.resolution.escalated",
  MERGE_RESOLUTION_FAILED: "merge.resolution.failed",
} as const;

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

// ─── Event payload ───────────────────────────────────────────────

export interface EventPayload {
  /** The full entity object (after the mutation) */
  entity: unknown;
  /** The type of entity: "project", "task", "epic", "proposal", "comment" */
  entityType: string;
  /** The entity's ID */
  entityId: string;
  /** The associated project ID (may be null for top-level entities) */
  projectId: string | null;
  /** The user who performed the action (id and metadata) */
  actorId: string | null;
  /** ISO timestamp of when the event occurred */
  timestamp: string;
  /** Field-level diff for updates */
  changes?: Record<string, { from: unknown; to: unknown }> | null;
  /** Previous status for transitions */
  previousStatus?: string;
  /** Tracks recursion depth for automation-triggered events */
  _automationDepth?: number;
}

// ─── Typed event bus ─────────────────────────────────────────────

export type EventListener = (payload: EventPayload) => void;

export class TypedEventBus {
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    // Allow many listeners (e.g. activity log, notifications, webhooks)
    this.emitter.setMaxListeners(50);
  }

  /**
   * Emit a typed event with a payload.
   */
  emit(event: EventName, payload: EventPayload): void {
    this.emitter.emit(event, payload);
  }

  /**
   * Register a listener for a specific event.
   */
  on(event: EventName, listener: EventListener): void {
    this.emitter.on(event, listener);
  }

  /**
   * Register a listener for all events matching a pattern.
   * The pattern is a prefix, e.g. "task." matches all task events.
   * Returns a cleanup function that removes all the per-event wrappers.
   */
  onAll(listener: (event: EventName, payload: EventPayload) => void): () => void {
    // Create per-event wrappers and store them so we can remove individually
    const wrappers = new Map<EventName, (payload: EventPayload) => void>();

    for (const eventName of Object.values(EVENT_NAMES)) {
      const wrapper = (payload: EventPayload) => {
        listener(eventName, payload);
      };
      wrappers.set(eventName, wrapper);
      this.emitter.on(eventName, wrapper);
    }

    // Return a cleanup function
    return () => {
      for (const [eventName, wrapper] of wrappers) {
        this.emitter.removeListener(eventName, wrapper);
      }
      wrappers.clear();
    };
  }

  /**
   * Remove all listeners. Useful for tests.
   */
  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }

  /**
   * Get the count of listeners for a specific event.
   */
  listenerCount(event: EventName): number {
    return this.emitter.listenerCount(event);
  }
}

// ─── Singleton ───────────────────────────────────────────────────

let eventBus: TypedEventBus | null = null;

/**
 * Get the singleton event bus instance.
 */
export function getEventBus(): TypedEventBus {
  if (!eventBus) {
    eventBus = new TypedEventBus();
  }
  return eventBus;
}

/**
 * Reset the event bus singleton. Used in tests to ensure isolation.
 */
export function resetEventBus(): void {
  if (eventBus) {
    eventBus.removeAllListeners();
    eventBus = null;
  }
}
