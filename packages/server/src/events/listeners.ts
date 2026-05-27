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
      return "created";

    // Updated events
    case EVENT_NAMES.PROJECT_UPDATED:
    case EVENT_NAMES.EPIC_UPDATED:
    case EVENT_NAMES.TASK_UPDATED:
    case EVENT_NAMES.COMMENT_UPDATED:
      return "updated";

    // Archived events
    case EVENT_NAMES.PROJECT_ARCHIVED:
    case EVENT_NAMES.EPIC_ARCHIVED:
    case EVENT_NAMES.TASK_ARCHIVED:
      return "archived";

    // Status changed events
    case EVENT_NAMES.TASK_STATUS_CHANGED:
    case EVENT_NAMES.PROPOSAL_TRANSITIONED:
    case EVENT_NAMES.PROPOSAL_IMPLEMENTED:
      return "status_changed";

    // Assigned events
    case EVENT_NAMES.TASK_ASSIGNED:
      return "assigned";

    // Commented events
    case EVENT_NAMES.PROPOSAL_COMMENTED:
    case EVENT_NAMES.TASK_COMMENTED:
      return "commented";

    // Deleted events
    case EVENT_NAMES.COMMENT_DELETED:
      return "deleted";

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
