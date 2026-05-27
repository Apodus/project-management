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
export { registerAutomationListener, registerProposalAutoTransitionListener } from "./automation-listener.js";

import { registerActivityLogListener } from "./listeners.js";
import { registerAutomationListener, registerProposalAutoTransitionListener } from "./automation-listener.js";

/**
 * Initialize all event listeners.
 * Call this once during app startup (after the database is initialized).
 */
export function initializeEventListeners(): void {
  registerActivityLogListener();
  registerAutomationListener();
  registerProposalAutoTransitionListener();
}
