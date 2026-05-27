export {
  getEventBus,
  resetEventBus,
  TypedEventBus,
  EVENT_NAMES,
  type EventName,
  type EventPayload,
  type EventListener,
} from "./event-bus.js";

export { registerActivityLogListener } from "./listeners.js";

import { registerActivityLogListener } from "./listeners.js";

/**
 * Initialize all event listeners.
 * Call this once during app startup (after the database is initialized).
 */
export function initializeEventListeners(): void {
  registerActivityLogListener();
}
