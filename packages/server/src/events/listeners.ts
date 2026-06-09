import { getEventBus, EVENT_NAMES, type EventName, type EventPayload } from "./event-bus.js";
import { logActivity } from "../services/activity.service.js";

// ─── Event-to-action mapping ────────────────────────────────────

/**
 * Map event names to activity log action strings.
 */
function eventToAction(event: EventName): string {
  switch (event) {
    // Created events
    case EVENT_NAMES.PROJECT_CREATED:
    case EVENT_NAMES.PROPOSAL_CREATED:
    case EVENT_NAMES.EPIC_CREATED:
    case EVENT_NAMES.TASK_CREATED:
    case EVENT_NAMES.COMMENT_CREATED:
    case EVENT_NAMES.NOTE_CREATED:
      return "created";

    // Updated events
    case EVENT_NAMES.PROJECT_UPDATED:
    case EVENT_NAMES.EPIC_UPDATED:
    case EVENT_NAMES.TASK_UPDATED:
    case EVENT_NAMES.COMMENT_UPDATED:
    case EVENT_NAMES.NOTE_UPDATED:
      return "updated";

    // Archived events
    case EVENT_NAMES.PROJECT_ARCHIVED:
    case EVENT_NAMES.EPIC_ARCHIVED:
    case EVENT_NAMES.TASK_ARCHIVED:
      return "archived";

    // Status changed events
    case EVENT_NAMES.TASK_STATUS_CHANGED:
    case EVENT_NAMES.PROPOSAL_TRANSITIONED:
    case EVENT_NAMES.PROPOSAL_PLANNED:
      return "status_changed";

    // Assigned events. Force-claim (takeover) events also map here — the
    // distinct accountability is the audit_log force_claim action; activity_log
    // stays in its existing vocabulary (no novel "force_claimed" action).
    case EVENT_NAMES.TASK_ASSIGNED:
    case EVENT_NAMES.TASK_CLAIMED:
    case EVENT_NAMES.TASK_RELEASED:
    case EVENT_NAMES.PROPOSAL_CLAIMED:
    case EVENT_NAMES.PROPOSAL_RELEASED:
    case EVENT_NAMES.EPIC_CLAIMED:
    case EVENT_NAMES.EPIC_RELEASED:
    case EVENT_NAMES.TASK_CLAIM_FORCED:
    case EVENT_NAMES.EPIC_CLAIM_FORCED:
    case EVENT_NAMES.PROPOSAL_CLAIM_FORCED:
    case EVENT_NAMES.CLAIM_LEASE_RECLAIMED:
      return "assigned";

    // Takeover-requested notification (Campaign C3 §P5b). No mutation occurred —
    // a live claim is never touched — so this is its own activity verb, NOT
    // "assigned".
    case EVENT_NAMES.CLAIM_TAKEOVER_REQUESTED:
      return "takeover_requested";

    // Note dismiss (Campaign C2 §P2). Bespoke verb — logActivity.action is
    // free-form; onAll auto-enrolls it.
    case EVENT_NAMES.NOTE_DISMISSED:
      return "dismissed";

    // Commented events
    case EVENT_NAMES.PROPOSAL_COMMENTED:
    case EVENT_NAMES.TASK_COMMENTED:
      return "commented";

    // Deleted events
    case EVENT_NAMES.COMMENT_DELETED:
      return "deleted";

    // Merge batch markers (Phase 7.2 — relayed, not persisted as rows; the
    // activity_log INSERT is FK-safe: entityType/entityId have no FK, and
    // projectId+actorId are real entities on the relay path).
    case EVENT_NAMES.MERGE_BATCH_STARTED:
      return "batch_started";
    case EVENT_NAMES.MERGE_BATCH_MEMBER_LANDED:
      return "batch_member_landed";
    case EVENT_NAMES.MERGE_BATCH_MEMBER_INVALIDATED:
      return "batch_member_invalidated";
    case EVENT_NAMES.MERGE_BATCH_COMPLETED:
      return "batch_completed";

    default:
      return "unknown";
  }
}

// ─── Activity log listener ──────────────────────────────────────

/**
 * Register the activity log listener on the event bus.
 * This listener writes to the activity_log table for every domain event.
 */
export function registerActivityLogListener(): void {
  const bus = getEventBus();

  bus.onAll((event: EventName, payload: EventPayload) => {
    const action = eventToAction(event);

    logActivity({
      entityType: payload.entityType,
      entityId: payload.entityId,
      projectId: payload.projectId,
      actorId: payload.actorId,
      action,
      changes: payload.changes ?? null,
    });
  });
}
