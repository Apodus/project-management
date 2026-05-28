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
