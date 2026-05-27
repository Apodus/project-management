import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { projectKeys } from "./use-projects";
import { proposalKeys } from "./use-proposals";
import { taskKeys } from "./use-tasks";
import { epicKeys } from "./use-epics";

// ─── SSE event payload shape ─────────────────────────────────────

interface SSEPayload {
  entity_type: string;
  entity_id: string;
  action: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
  actor: { id: string | null; name: string; type: string };
  timestamp: string;
}

// ─── Query key invalidation map ──────────────────────────────────

function getInvalidationKeys(eventType: string): readonly (readonly unknown[])[] {
  const prefix = eventType.split(".")[0];
  switch (prefix) {
    case "project":
      return [projectKeys.all];
    case "proposal":
      return [proposalKeys.all];
    case "task":
      return [taskKeys.all];
    case "epic":
      return [epicKeys.all];
    case "comment":
      // Comments affect both task and proposal detail queries
      return [taskKeys.all, proposalKeys.all];
    default:
      return [];
  }
}

// ─── Toast notifications for key events ──────────────────────────

function maybeShowToast(eventType: string, payload: SSEPayload): void {
  if (
    eventType === "task.status_changed" &&
    payload.changes?.status &&
    (payload.changes.status as { to: string }).to === "done"
  ) {
    toast.success(`Task completed`, {
      description: `Task ${payload.entity_id.slice(-6)} marked as done`,
    });
    return;
  }

  if (eventType === "proposal.transitioned" && payload.changes?.status) {
    const toStatus = (payload.changes.status as { to: string }).to;
    if (toStatus === "accepted") {
      toast.success(`Proposal accepted`, {
        description: `Proposal ${payload.entity_id.slice(-6)} has been accepted`,
      });
    } else if (toStatus === "implemented") {
      toast.success(`Proposal implemented`, {
        description: `Proposal ${payload.entity_id.slice(-6)} has been implemented`,
      });
    }
  }
}

// ─── Hook ────────────────────────────────────────────────────────

/**
 * Establishes an SSE connection to the server event stream.
 * Automatically invalidates relevant TanStack Query caches and
 * shows toast notifications for key events.
 *
 * EventSource handles auto-reconnect natively.
 */
export function useSSE(projectId?: string | null): void {
  const queryClient = useQueryClient();
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Build URL with optional project filter
    const params = new URLSearchParams();
    if (projectId) {
      params.set("project_id", projectId);
    }

    const url = `/api/v1/events${params.toString() ? `?${params.toString()}` : ""}`;

    const es = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = es;

    // Generic message handler — EventSource 'message' fires for unnamed events,
    // but we use named events so we listen via onmessage as a fallback only.
    // Instead, we register listeners for known event prefixes.

    // For SSE named events, we need addEventListener per event type.
    // Since we don't know all event types up front, we use the generic
    // 'message' event which doesn't fire for named events in standard SSE.
    // We'll instead use a workaround: listen for all events via onmessage
    // won't work for named events. The proper approach is to listen to
    // specific event types. But the server sends named events dynamically.
    //
    // Solution: The server also includes the event name in the data payload.
    // But actually, EventSource only lets you listen to specific named events.
    // We'll listen for all the known event patterns.

    const eventTypes = [
      // Project
      "project.created",
      "project.updated",
      "project.archived",
      // Proposal
      "proposal.created",
      "proposal.transitioned",
      "proposal.commented",
      "proposal.implemented",
      // Epic
      "epic.created",
      "epic.updated",
      "epic.archived",
      // Task
      "task.created",
      "task.updated",
      "task.status_changed",
      "task.assigned",
      "task.commented",
      "task.archived",
      // Comment
      "comment.created",
      "comment.updated",
      "comment.deleted",
    ];

    const handleEvent = (eventType: string) => (e: MessageEvent) => {
      let payload: SSEPayload;
      try {
        payload = JSON.parse(e.data);
      } catch {
        return;
      }

      // Invalidate relevant query caches
      const keys = getInvalidationKeys(eventType);
      for (const key of keys) {
        queryClient.invalidateQueries({ queryKey: key });
      }

      // Show toast notifications for key events
      maybeShowToast(eventType, payload);
    };

    // Register all event listeners
    const handlers: Array<[string, (e: MessageEvent) => void]> = [];
    for (const eventType of eventTypes) {
      const handler = handleEvent(eventType);
      es.addEventListener(eventType, handler as EventListener);
      handlers.push([eventType, handler]);
    }

    // Cleanup on unmount or dependency change
    return () => {
      for (const [eventType, handler] of handlers) {
        es.removeEventListener(eventType, handler as EventListener);
      }
      es.close();
      eventSourceRef.current = null;
    };
  }, [projectId, queryClient]);
}
