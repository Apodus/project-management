import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

import { activityKeys } from "./use-activity";
import { projectKeys } from "./use-projects";
import { proposalKeys } from "./use-proposals";
import { taskKeys } from "./use-tasks";
import { epicKeys } from "./use-epics";
import { trainKeys } from "./use-train";
import { noteKeys } from "./use-notes";
import { escalationKeys } from "./use-escalations";
import { claimKeys } from "./use-claims";
import { useConnectionStore } from "@/stores/connection-store";

// ─── SSE event payload shape ─────────────────────────────────────

interface SSEPayload {
  entity_type: string;
  entity_id: string;
  action: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
  actor: { id: string | null; name: string; type: string };
  timestamp: string;
  entity_title?: string;
}

// ─── Query key invalidation map ──────────────────────────────────

export function getInvalidationKeys(eventType: string): readonly (readonly unknown[])[] {
  const prefix = eventType.split(".")[0];
  switch (prefix) {
    case "project":
      return [projectKeys.all, activityKeys.all];
    // task/epic/proposal lifecycle also refreshes the claims panel (Campaign
    // C3): claim/release/assign/handoff all surface as entity events, and the
    // panel's rows derive from those holders.
    case "proposal":
      return [proposalKeys.all, activityKeys.all, claimKeys.all];
    case "task":
      return [taskKeys.all, activityKeys.all, claimKeys.all];
    case "epic":
      return [epicKeys.all, activityKeys.all, claimKeys.all];
    case "comment":
      // Comments affect both task and proposal detail queries
      return [taskKeys.all, proposalKeys.all, activityKeys.all];
    case "train":
      return [trainKeys.all];
    case "merge":
      // merge.* events move the queue / in-flight composition → refresh train.
      return [trainKeys.all];
    case "audit":
      // audit.recorded → the audit query lives under trainKeys.all → refresh live.
      return [trainKeys.all];
    case "note":
      // note.* (Campaign C3) — noteKeys.all = ["notes"] is the prefix of
      // lists()/detail()/health(): one entry refreshes the inbox list, any open
      // note detail, and notes health together (note.backlog_alert is toast-only,
      // handled in maybeShowToast — the health poll owns its refresh).
      return [noteKeys.all];
    case "escalation":
      // escalation.* (Campaign C4) — escalationKeys.all = ["escalations"] is the
      // prefix of lists()/detail(): one entry refreshes the dashboard list and
      // any open escalation timeline together. (SLA toast is a later phase —
      // P1 is pure invalidation.)
      return [escalationKeys.all];
    default:
      return [];
  }
}

// ─── Toast notifications for key events ──────────────────────────

/**
 * Navigate function shape for the stale-claim toast action — the subset of
 * TanStack's NavigateFn the toast needs (kept loose so the unit test can pass
 * a plain spy).
 */
export type ToastNavigate = (opts: { to: string; params: Record<string, string> }) => void;

// Exported for unit testing (sanctioned by the roadmap amendment).
export function maybeShowToast(
  eventType: string,
  payload: SSEPayload,
  navigate?: ToastNavigate,
): void {
  // ── Merge-train health alerts (§7a in-app alert) ──────────────
  if (eventType === "train.integrator_unhealthy") {
    toast.warning("Integrator unhealthy", {
      description: "The merge train integrator stopped reporting in.",
    });
    return;
  }
  if (eventType === "train.stuck") {
    toast.warning("Merge train stuck", {
      description: "A merge request has been integrating longer than expected.",
    });
    return;
  }
  if (eventType === "train.abandon_rate_high") {
    toast.warning("High abandon rate", {
      description: "Merge requests are being abandoned faster than usual.",
    });
    return;
  }
  if (eventType === "train.integration_stalled") {
    toast.warning("Integration stalled", {
      description: "A merge request is stuck integrating without progress.",
    });
    return;
  }
  // Stale-claim alert (Campaign C3 §P5a). Identity-masked — no holder id.
  // The frame's entity_id IS the projectId (verified — the alert is a
  // per-project aggregate), so the action deep-links to that project's
  // claims panel.
  if (eventType === "claim.stale_alert") {
    toast.warning("Stale claims", {
      description: "Some work items are claimed but inactive past grace. Review or hand off.",
      ...(navigate && payload.entity_id
        ? {
            action: {
              label: "View claims",
              onClick: () =>
                navigate({
                  to: "/projects/$projectId/claims",
                  params: { projectId: payload.entity_id },
                }),
            },
          }
        : {}),
    });
    return;
  }
  // Backlog alert (Campaign C3) — identity-masked, aggregate copy (no ids/counts),
  // exactly mirroring the stale-claim toast. Toast-only: the useNotesHealth poll
  // owns the inbox refresh; this frame just surfaces the warning.
  if (eventType === "note.backlog_alert") {
    toast.warning("Untriaged notes piling up", {
      description: "Some notes have been waiting past the triage window. Review the inbox.",
    });
    return;
  }
  // Unanswered-SLA alert (Campaign C4 §P3) — identity-masked, aggregate copy
  // (no ids/counts), mirroring the note.backlog_alert toast. Toast-only: the
  // useEscalationMetrics poll owns the dashboard refresh; this frame just
  // surfaces the warning.
  if (eventType === "escalation.sla_breached") {
    toast.warning("Escalations going unanswered", {
      description: "Some escalations have been open past the SLA window. Acknowledge or answer.",
    });
    return;
  }

  const titleLabel = payload.entity_title
    ? `'${payload.entity_title}'`
    : `${payload.entity_id?.slice(-6) ?? ""}`;

  if (eventType === "task.status_changed" && payload.changes?.status) {
    const toStatus = (payload.changes.status as { to: string }).to;
    if (toStatus === "done") {
      const actorSuffix =
        payload.actor.name && payload.actor.name !== "system" ? ` by ${payload.actor.name}` : "";
      toast.success(`Task completed`, {
        description: `Task ${titleLabel} completed${actorSuffix}`,
      });
      return;
    }
    if (toStatus === "in_progress") {
      toast.success(`Task started`, {
        description:
          payload.actor.name && payload.actor.name !== "system"
            ? `${payload.actor.name} started ${titleLabel}`
            : `Task ${titleLabel} started`,
      });
      return;
    }
  }

  if (eventType === "proposal.transitioned" && payload.changes?.status) {
    const toStatus = (payload.changes.status as { to: string }).to;
    if (toStatus === "accepted") {
      toast.success(`Proposal accepted`, {
        description: `Proposal ${titleLabel} accepted`,
      });
    } else if (toStatus === "in_progress") {
      toast.success(`Proposal work started`, {
        description: `Proposal ${titleLabel} is now in progress`,
      });
    } else if (toStatus === "completed") {
      toast.success(`Proposal completed`, {
        description: `Proposal ${titleLabel} has been completed`,
      });
    }
  }
}

// ─── Hook ────────────────────────────────────────────────────────

/**
 * Establishes an SSE connection to the server event stream.
 * Automatically invalidates relevant TanStack Query caches,
 * shows toast notifications for key events, and tracks
 * connection state + unread counts in the connection store.
 *
 * EventSource handles auto-reconnect natively.
 */
export function useSSE(projectId?: string | null, currentUserId?: string | null): void {
  const queryClient = useQueryClient();
  const eventSourceRef = useRef<EventSource | null>(null);
  const currentUserIdRef = useRef(currentUserId);
  currentUserIdRef.current = currentUserId;
  // useSSE mounts under RouterProvider (app-layout), so useNavigate is legal
  // here. Held in a ref so the SSE effect never re-subscribes on a navigate
  // identity change.
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const { setStatus, recordEvent, clearUnread } = useConnectionStore.getState();

    // Build URL with optional project filter
    const params = new URLSearchParams();
    if (projectId) {
      params.set("project_id", projectId);
    }

    const url = `/api/v1/events${params.toString() ? `?${params.toString()}` : ""}`;

    setStatus("connecting");

    const es = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = es;

    // ── Connection lifecycle ──────────────────────────────────
    es.onopen = () => {
      const prev = useConnectionStore.getState().status;
      setStatus("connected");
      if (prev === "reconnecting") {
        toast.success("Reconnected", {
          description: "Real-time updates restored",
          duration: 2000,
        });
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; surface the attempt
      setStatus("reconnecting");
    };

    // ── Event handling ────────────────────────────────────────

    const eventTypes = [
      // Project
      "project.created",
      "project.updated",
      "project.archived",
      // Proposal
      "proposal.created",
      "proposal.transitioned",
      "proposal.commented",
      "proposal.planned",
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
      // Merge train — lifecycle (queue / in-flight composition changes)
      "merge.request.landed",
      "merge.request.rejected",
      // A re-queue (integrating → queued: land-time drift / push race / suffix
      // invalidation / crash recovery) moves the in-flight composition back to
      // the queue — refresh the train view so the request doesn't appear stuck.
      "merge.request.requeued",
      "merge.batch.formed",
      "merge.batch.landed",
      "merge.batch.rejected",
      "merge.group.landed",
      "merge.group.rejected",
      // Merge train — observability alerts
      "train.paused",
      "train.resumed",
      "train.integrator_unhealthy",
      "train.stuck",
      "train.abandon_rate_high",
      "train.integration_stalled",
      // Stale-claim alert (Campaign C3 §P5a) — claimed-but-inactive work items.
      "claim.stale_alert",
      // Notes inbox (Campaign C3) — lifecycle invalidates noteKeys.all; the
      // backlog alert is a toast-only banner (handled in maybeShowToast).
      "note.created",
      "note.updated",
      "note.dismissed",
      "note.promoted",
      "note.backlog_alert",
      // Agent escalation channel (Campaign C4) — lifecycle invalidates
      // escalationKeys.all (dashboard list + any open timeline). Pure
      // invalidation in P1 (no toast).
      "escalation.opened",
      "escalation.acknowledged",
      "escalation.replied",
      "escalation.answered",
      "escalation.resolved",
      "escalation.needs_human",
      // The unanswered-SLA alert (Campaign C4 §P3) is a toast-only banner
      // (handled in maybeShowToast); the useEscalationMetrics poll owns refresh.
      "escalation.sla_breached",
      // Break-glass audit — an R1-override was recorded → refresh the audit log.
      "audit.recorded",
    ];

    const handleEvent = (eventType: string) => (e: MessageEvent) => {
      let payload: SSEPayload;
      try {
        payload = JSON.parse(e.data);
      } catch {
        return;
      }

      // Invalidate relevant query caches (always, even for own actions)
      const keys = getInvalidationKeys(eventType);
      for (const key of keys) {
        queryClient.invalidateQueries({ queryKey: key });
      }

      // Skip toasts and unread count for events caused by the current user
      const isSelf = currentUserIdRef.current && payload.actor.id === currentUserIdRef.current;
      if (!isSelf) {
        recordEvent();
        maybeShowToast(eventType, payload, (opts) =>
          navigateRef.current({ to: opts.to, params: opts.params }),
        );
      }
    };

    // Register all event listeners
    const handlers: Array<[string, (e: MessageEvent) => void]> = [];
    for (const eventType of eventTypes) {
      const handler = handleEvent(eventType);
      es.addEventListener(eventType, handler as EventListener);
      handlers.push([eventType, handler]);
    }

    // ── Clear unread when tab regains focus ───────────────────
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        clearUnread();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    // Cleanup on unmount or dependency change
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      for (const [eventType, handler] of handlers) {
        es.removeEventListener(eventType, handler as EventListener);
      }
      es.close();
      eventSourceRef.current = null;
      setStatus("disconnected");
    };
  }, [projectId, queryClient]);
}
