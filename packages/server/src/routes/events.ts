import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppVariables } from "../types.js";
import { getEventBus, type EventName, type EventPayload } from "../events/event-bus.js";
import * as userService from "../services/user.service.js";

// ─── SSE event route ─────────────────────────────────────────────

/**
 * Create SSE event stream routes.
 *
 * GET /api/v1/events — Server-Sent Events stream
 *   - Query: project_id (optional) — scope events to a project
 *   - Auth required (Bearer token or session cookie)
 *   - Sends: connected, heartbeat, and domain events
 */
export function createEventStreamRoutes(): Hono<{ Variables: AppVariables }> {
  const router = new Hono<{ Variables: AppVariables }>();

  router.get("/api/v1/events", (c) => {
    // Auth check — middleware has already run; currentUser is null if unauthenticated
    const currentUser = c.get("currentUser");
    if (!currentUser) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Valid authentication required" } },
        401,
      );
    }

    const projectIdFilter = c.req.query("project_id") ?? null;

    return streamSSE(c, async (stream) => {
      // Set SSE-appropriate headers
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      // Send initial connected event
      await stream.writeSSE({
        event: "connected",
        data: JSON.stringify({ status: "connected" }),
      });

      // Register event bus listener
      const bus = getEventBus();
      const removeListener = bus.onAll((event: EventName, payload: EventPayload) => {
        // Apply project_id filter
        if (projectIdFilter && payload.projectId !== projectIdFilter) {
          return;
        }

        // Look up actor info
        let actor: { id: string | null; name: string; type: string } = {
          id: payload.actorId,
          name: "system",
          type: "system",
        };

        if (payload.actorId) {
          const user = userService.getById(payload.actorId);
          if (user) {
            actor = {
              id: user.id,
              name: user.displayName,
              type: user.type,
            };
          }
        }

        // Determine action from event name
        const action = event.split(".").slice(1).join(".");

        // Extract entity title based on entity type
        let entity_title: string | undefined;
        // Phase 7.2: batch-tag fields, read additively off payload.entity so
        // they ride merge.batch.* markers AND batch-tagged merge.request.* /
        // merge.attempt.* frames. Absent → omitted (like entity_title), so all
        // 7.1 frames stay byte-identical.
        let batchId: string | undefined;
        let speculativePosition: number | undefined;
        // Phase 7.3: group/incident identifying fields (§10.3). Read additively
        // off payload.entity exactly like batch_id/speculative_position so they
        // ride merge.group.* / merge.incident.* frames. Absent → omitted, so all
        // 7.1/7.2 frames stay byte-identical.
        let groupId: string | undefined;
        let incidentId: string | undefined;
        let orphanedSha: string | undefined;
        if (payload.entity && typeof payload.entity === "object") {
          const entity = payload.entity as Record<string, unknown>;
          switch (payload.entityType) {
            case "task":
            case "proposal":
              entity_title = typeof entity.title === "string" ? entity.title : undefined;
              break;
            case "epic":
            case "project":
              entity_title = typeof entity.name === "string" ? entity.name : undefined;
              break;
            // comments have no title — omit
          }
          if (typeof entity.batchId === "string") {
            batchId = entity.batchId;
          }
          if (typeof entity.speculativePosition === "number") {
            speculativePosition = entity.speculativePosition;
          }
          if (typeof entity.groupId === "string") groupId = entity.groupId;
          if (typeof entity.incidentId === "string") incidentId = entity.incidentId;
          if (typeof entity.orphanedSha === "string") orphanedSha = entity.orphanedSha;
        }

        const ssePayload = {
          entity_type: payload.entityType,
          entity_id: payload.entityId,
          action,
          changes: payload.changes ?? undefined,
          actor,
          timestamp: payload.timestamp,
          ...(entity_title ? { entity_title } : {}),
          ...(batchId ? { batch_id: batchId } : {}),
          ...(speculativePosition !== undefined
            ? { speculative_position: speculativePosition }
            : {}),
          ...(groupId ? { group_id: groupId } : {}),
          ...(incidentId ? { incident_id: incidentId } : {}),
          ...(orphanedSha ? { orphaned_sha: orphanedSha } : {}),
        };

        stream.writeSSE({
          event,
          data: JSON.stringify(ssePayload),
        }).catch(() => {
          // Stream already closed — cleanup will happen via onAbort
        });
      });

      // Heartbeat interval — keep the connection alive
      const heartbeatInterval = setInterval(() => {
        stream.writeSSE({
          event: "heartbeat",
          data: "{}",
        }).catch(() => {
          // Stream closed — will be cleaned up
        });
      }, 30_000);

      // Clean up on disconnect
      stream.onAbort(() => {
        clearInterval(heartbeatInterval);
        removeListener();
      });

      // Keep the stream open by awaiting a promise that never resolves
      // (the stream will close when the client disconnects)
      await new Promise<void>(() => {
        // intentionally never resolves — stream stays open until abort
      });
    });
  });

  return router;
}
