import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp, createTestProject, createTestUser, type TestApp } from "../utils.js";
import { getDb } from "../../src/db/index.js";
import * as svc from "../../src/services/audit.service.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";

/**
 * Thin helper: record() must run inside a db.transaction (it takes the tx
 * handle). This mirrors how the real callers (land/reject/overrides) wire it.
 * Returns the new audit id.
 */
function recordInTx(args: Parameters<typeof svc.record>[1]): string {
  let id = "";
  getDb().transaction((tx) => {
    id = svc.record(tx, args);
  });
  return id;
}

function baseArgs(
  projectId: string,
  actorId: string,
  overrides: Partial<Parameters<typeof svc.record>[1]> = {},
): Parameters<typeof svc.record>[1] {
  return {
    projectId,
    actorId,
    action: overrides.action ?? "land",
    targetType: overrides.targetType ?? "merge_request",
    targetId: overrides.targetId ?? "req-1",
    reason: overrides.reason,
    before: overrides.before,
    after: overrides.after,
    now: overrides.now ?? new Date().toISOString(),
  };
}

describe("audit service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ─── record + list ────────────────────────────────────────────────
  describe("record + list", () => {
    it("records a row and lists it back (newest first)", () => {
      const project = createTestProject(testApp.db);
      const actor = createTestUser(testApp.db);

      const id1 = recordInTx(
        baseArgs(project.id, actor.id, {
          action: "land",
          targetId: "req-1",
          now: "2026-05-30T10:00:00.000Z",
          before: { status: "integrating" },
          after: { status: "landed", landedSha: "ff00" },
        }),
      );
      const id2 = recordInTx(
        baseArgs(project.id, actor.id, {
          action: "reject",
          targetId: "req-2",
          now: "2026-05-30T11:00:00.000Z",
        }),
      );

      const out = svc.list({ projectId: project.id });
      // Newest (id2 at 11:00) first.
      expect(out.data.map((r) => r.id)).toEqual([id2, id1]);
      expect(out.pagination.total).toBe(2);

      const landed = out.data.find((r) => r.id === id1)!;
      expect(landed.action).toBe("land");
      expect(landed.targetType).toBe("merge_request");
      expect(landed.targetId).toBe("req-1");
      expect(landed.actorId).toBe(actor.id);
      expect(landed.reason).toBeNull();
      expect(landed.metadataBefore).toEqual({ status: "integrating" });
      expect(landed.metadataAfter).toEqual({
        status: "landed",
        landedSha: "ff00",
      });
    });

    it("record returns the new id", () => {
      const project = createTestProject(testApp.db);
      const actor = createTestUser(testApp.db);
      const id = recordInTx(baseArgs(project.id, actor.id));
      expect(id).toBeTruthy();
      const out = svc.list({ projectId: project.id });
      expect(out.data[0].id).toBe(id);
    });
  });

  // ─── list filters ─────────────────────────────────────────────────
  describe("list filters", () => {
    it("filters by userId (actorId)", () => {
      const project = createTestProject(testApp.db);
      const a1 = createTestUser(testApp.db);
      const a2 = createTestUser(testApp.db);
      const id1 = recordInTx(baseArgs(project.id, a1.id));
      recordInTx(baseArgs(project.id, a2.id));

      const out = svc.list({ projectId: project.id, userId: a1.id });
      expect(out.data.map((r) => r.id)).toEqual([id1]);
      expect(out.pagination.total).toBe(1);
    });

    it("filters by action", () => {
      const project = createTestProject(testApp.db);
      const actor = createTestUser(testApp.db);
      const landId = recordInTx(baseArgs(project.id, actor.id, { action: "land" }));
      recordInTx(baseArgs(project.id, actor.id, { action: "reject" }));

      const out = svc.list({ projectId: project.id, action: "land" });
      expect(out.data.map((r) => r.id)).toEqual([landId]);
    });

    it("filters by targetType + targetId", () => {
      const project = createTestProject(testApp.db);
      const actor = createTestUser(testApp.db);
      const trainId = recordInTx(
        baseArgs(project.id, actor.id, {
          action: "pause",
          targetType: "train",
          targetId: "main",
        }),
      );
      recordInTx(
        baseArgs(project.id, actor.id, {
          action: "land",
          targetType: "merge_request",
          targetId: "req-9",
        }),
      );

      const out = svc.list({
        projectId: project.id,
        targetType: "train",
        targetId: "main",
      });
      expect(out.data.map((r) => r.id)).toEqual([trainId]);
    });

    it("filters by from/to window with controlled now values", () => {
      const project = createTestProject(testApp.db);
      const actor = createTestUser(testApp.db);
      const early = recordInTx(
        baseArgs(project.id, actor.id, {
          now: "2026-05-30T08:00:00.000Z",
          targetId: "early",
        }),
      );
      const mid = recordInTx(
        baseArgs(project.id, actor.id, {
          now: "2026-05-30T12:00:00.000Z",
          targetId: "mid",
        }),
      );
      const late = recordInTx(
        baseArgs(project.id, actor.id, {
          now: "2026-05-30T16:00:00.000Z",
          targetId: "late",
        }),
      );

      // Inclusive lower + upper bound: only mid is inside (10:00–14:00).
      const windowed = svc.list({
        projectId: project.id,
        from: "2026-05-30T10:00:00.000Z",
        to: "2026-05-30T14:00:00.000Z",
      });
      expect(windowed.data.map((r) => r.id)).toEqual([mid]);

      // from only — mid + late, newest first.
      const fromOnly = svc.list({
        projectId: project.id,
        from: "2026-05-30T10:00:00.000Z",
      });
      expect(fromOnly.data.map((r) => r.id)).toEqual([late, mid]);

      // to only — early + mid, newest first.
      const toOnly = svc.list({
        projectId: project.id,
        to: "2026-05-30T14:00:00.000Z",
      });
      expect(toOnly.data.map((r) => r.id)).toEqual([mid, early]);
    });
  });

  // ─── pagination ───────────────────────────────────────────────────
  describe("pagination", () => {
    it("defaults to page 1 / perPage 50", () => {
      const project = createTestProject(testApp.db);
      const actor = createTestUser(testApp.db);
      for (let i = 0; i < 3; i++) {
        recordInTx(baseArgs(project.id, actor.id, { targetId: `t-${i}` }));
      }
      const out = svc.list({ projectId: project.id });
      expect(out.pagination.page).toBe(1);
      expect(out.pagination.perPage).toBe(50);
      expect(out.pagination.total).toBe(3);
      expect(out.data).toHaveLength(3);
    });

    it("caps perPage at 200", () => {
      const project = createTestProject(testApp.db);
      const actor = createTestUser(testApp.db);
      recordInTx(baseArgs(project.id, actor.id));
      const out = svc.list({ projectId: project.id, perPage: 9999 });
      expect(out.pagination.perPage).toBe(200);
    });

    it("paginates with page/perPage", () => {
      const project = createTestProject(testApp.db);
      const actor = createTestUser(testApp.db);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(
          recordInTx(
            baseArgs(project.id, actor.id, {
              now: `2026-05-30T1${i}:00:00.000Z`,
              targetId: `t-${i}`,
            }),
          ),
        );
      }
      // Newest first: ids reversed.
      const newestFirst = [...ids].reverse();
      const p1 = svc.list({ projectId: project.id, page: 1, perPage: 2 });
      const p2 = svc.list({ projectId: project.id, page: 2, perPage: 2 });
      expect(p1.data.map((r) => r.id)).toEqual(newestFirst.slice(0, 2));
      expect(p2.data.map((r) => r.id)).toEqual(newestFirst.slice(2, 4));
      expect(p1.pagination.total).toBe(5);
    });

    it("404 for a missing project", () => {
      expect(() => svc.list({ projectId: "01PROJECTMISSING000000000000" })).toThrowError(
        expect.objectContaining({ statusCode: 404 }),
      );
    });
  });

  // ─── immutability (record-only) ───────────────────────────────────
  describe("immutability by construction", () => {
    it("exports record + list + emitAuditRecorded and NO update/delete", () => {
      const keys = Object.keys(svc);
      expect(keys).toContain("record");
      expect(keys).toContain("list");
      expect(keys).toContain("emitAuditRecorded");
      // No mutator surface — append-only by omission.
      const mutators = keys.filter((k) => /update|delete|remove|mutate|edit/i.test(k));
      expect(mutators).toEqual([]);
    });
  });

  // ─── audit.recorded event ─────────────────────────────────────────
  describe("emitAuditRecorded", () => {
    it("emits audit.recorded after commit; listener reads the persisted row", () => {
      const project = createTestProject(testApp.db);
      const actor = createTestUser(testApp.db);
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.AUDIT_RECORDED, listener);

      let observedAction: string | undefined;
      getEventBus().on(EVENT_NAMES.AUDIT_RECORDED, (p) => {
        // The persisted row is queryable when the event fires (after commit).
        const found = svc
          .list({ projectId: project.id })
          .data.find((r) => r.id === (p.entity as { id: string }).id);
        observedAction = found?.action;
      });

      // Drive a record + emit the way a real caller does.
      const now = new Date().toISOString();
      let view: svc.AuditLogView | null = null;
      let auditId = "";
      getDb().transaction((tx) => {
        auditId = svc.record(tx, {
          projectId: project.id,
          actorId: actor.id,
          action: "force_land",
          targetType: "merge_request",
          targetId: "req-x",
          reason: "prod hotfix",
          before: { status: "integrating" },
          after: { status: "landed", overridden: true },
          now,
        });
        view = {
          id: auditId,
          projectId: project.id,
          actorId: actor.id,
          action: "force_land",
          targetType: "merge_request",
          targetId: "req-x",
          reason: "prod hotfix",
          metadataBefore: { status: "integrating" },
          metadataAfter: { status: "landed", overridden: true },
          createdAt: now,
        };
      });
      svc.emitAuditRecorded(auditId, project.id, actor.id, view!);

      expect(listener).toHaveBeenCalledTimes(1);
      const payload = listener.mock.calls[0][0];
      expect(payload.entityType).toBe("audit_log");
      expect(payload.entityId).toBe(auditId);
      expect((payload.entity as svc.AuditLogView).reason).toBe("prod hotfix");
      expect(observedAction).toBe("force_land");
    });
  });
});
