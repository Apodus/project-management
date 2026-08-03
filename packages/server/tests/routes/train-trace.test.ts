import { afterEach, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { createId } from "@pm/shared";
import {
  authRequest,
  createTestApp,
  createTestProject,
  createTestUser,
  type TestApp,
} from "../utils.js";
import { auditLog, mergePhaseTimings, mergeRequests, users } from "../../src/db/index.js";

// ══════════════════════════════════════════════════════════════════
// GET /api/v1/projects/{id}/train/trace — the event-trace surface.
//
// The authz assertion that matters is the 200 for a NON-ADMIN: this is
// observability, not forensics. It sits beside train/metrics, train/in-flight
// and the per-request timeline (all "any authenticated user"), NOT beside the
// admin-only audit log.
// ══════════════════════════════════════════════════════════════════

const MIN = 60_000;

function createMemberToken(testApp: TestApp): string {
  const ts = new Date().toISOString();
  const id = createId();
  const token = `member-token-${id}`;
  testApp.db
    .insert(users)
    .values({
      id,
      username: `member-${id.slice(-6)}`,
      displayName: "Member",
      role: "member",
      type: "human",
      apiTokenHash: bcrypt.hashSync(token, 10),
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  return token;
}

describe("GET /projects/{projectId}/train/trace", () => {
  let testApp: TestApp;
  let projectId: string;
  let actorId: string;
  let now: number;

  const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString();

  beforeEach(() => {
    now = Date.now();
    testApp = createTestApp();
    const project = createTestProject(testApp.db);
    projectId = project.id;
    actorId = createTestUser(testApp.db).id;
  });

  afterEach(() => {
    testApp.cleanup();
  });

  function seedRequest(over: { resource?: string; pickedUpAt?: string } = {}): string {
    const id = createId();
    const ts = iso(-120 * MIN);
    testApp.db
      .insert(mergeRequests)
      .values({
        id,
        projectId,
        resource: over.resource ?? "main",
        submittedBy: actorId,
        branch: "feat/x",
        status: "queued",
        enqueuedAt: ts,
        pickedUpAt: over.pickedUpAt ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return id;
  }

  function seedPhase(over: { resource?: string; startedAt?: string } = {}): void {
    testApp.db
      .insert(mergePhaseTimings)
      .values({
        id: createId(),
        projectId,
        resource: over.resource ?? "main",
        phase: "verify",
        startedAt: over.startedAt ?? iso(-30 * MIN),
        durationMs: 5 * MIN,
        createdAt: iso(-30 * MIN),
      })
      .run();
  }

  it("401s without authentication", async () => {
    const res = await testApp.app.request(`/api/v1/projects/${projectId}/train/trace`);
    expect(res.status).toBe(401);
  });

  it("404s on an unknown project", async () => {
    const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${createId()}/train/trace`);
    expect(res.status).toBe(404);
  });

  it("200s for a NON-ADMIN — this is observability, not the audit log", async () => {
    seedPhase();
    const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${projectId}/train/trace`, {
      token: createMemberToken(testApp),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  it("returns the documented envelope", async () => {
    seedPhase();
    const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${projectId}/train/trace`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<Record<string, unknown>>;
      window: { from: string; to: string };
      limit: number;
      truncated: boolean;
    };
    expect(Object.keys(body).sort()).toEqual(["data", "limit", "truncated", "window"]);
    expect(body.limit).toBe(50);
    expect(body.truncated).toBe(false);
    expect(Date.parse(body.window.from)).toBeLessThan(Date.parse(body.window.to));
    expect(body.data[0]).toMatchObject({
      source: "phase",
      kind: "phase",
      phase: "verify",
      resource: "main",
      overridden: false,
      elapsed: { basis: "phase", ms: 5 * MIN },
      subject: { type: "lane", id: "main", name: "main" },
    });
  });

  it("scopes to the asked lane", async () => {
    seedPhase({ resource: "main" });
    seedPhase({ resource: "release" });
    testApp.db
      .insert(auditLog)
      .values({
        id: createId(),
        projectId,
        actorId,
        action: "pause",
        targetType: "train",
        targetId: "release",
        createdAt: iso(-10 * MIN),
      })
      .run();

    const main = (await (
      await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${projectId}/train/trace?resource=main`,
      )
    ).json()) as { data: Array<{ resource: string }> };
    expect(main.data).toHaveLength(1);
    expect(main.data.every((e) => e.resource === "main")).toBe(true);

    const release = (await (
      await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${projectId}/train/trace?resource=release`,
      )
    ).json()) as { data: Array<{ resource: string; kind: string }> };
    expect(release.data.map((e) => e.kind).sort()).toEqual(["paused", "phase"]);
  });

  it("clamps the limit to 200 rather than rejecting, and defaults to 50", async () => {
    seedPhase();
    const over = (await (
      await authRequest(testApp.app, "GET", `/api/v1/projects/${projectId}/train/trace?limit=5000`)
    ).json()) as { limit: number };
    expect(over.limit).toBe(200);

    const under = (await (
      await authRequest(testApp.app, "GET", `/api/v1/projects/${projectId}/train/trace?limit=0`)
    ).json()) as { limit: number };
    expect(under.limit).toBe(1);

    const dflt = (await (
      await authRequest(testApp.app, "GET", `/api/v1/projects/${projectId}/train/trace`)
    ).json()) as { limit: number };
    expect(dflt.limit).toBe(50);
  });

  it("honours `since` and flags truncation", async () => {
    seedPhase({ startedAt: iso(-90 * MIN) });
    seedPhase({ startedAt: iso(-5 * MIN) });
    seedPhase({ startedAt: iso(-4 * MIN) });

    const windowed = (await (
      await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${projectId}/train/trace?since=${encodeURIComponent(iso(-10 * MIN))}`,
      )
    ).json()) as { data: unknown[]; window: { from: string } };
    expect(windowed.data).toHaveLength(2);
    expect(windowed.window.from).toBe(iso(-10 * MIN));

    const truncated = (await (
      await authRequest(testApp.app, "GET", `/api/v1/projects/${projectId}/train/trace?limit=1`)
    ).json()) as { data: unknown[]; truncated: boolean };
    expect(truncated.data).toHaveLength(1);
    expect(truncated.truncated).toBe(true);
  });

  it("names a request subject by its work, and carries the reason verbatim", async () => {
    const requestId = seedRequest({ pickedUpAt: iso(-40 * MIN) });
    testApp.db
      .insert(auditLog)
      .values({
        id: createId(),
        projectId,
        actorId,
        action: "force_reject",
        targetType: "merge_request",
        targetId: requestId,
        reason: "obsoleted by a newer request; clearing the lane",
        createdAt: iso(-2 * MIN),
      })
      .run();

    const body = (await (
      await authRequest(testApp.app, "GET", `/api/v1/projects/${projectId}/train/trace`)
    ).json()) as {
      data: Array<{
        kind: string;
        overridden: boolean;
        reason: string | null;
        subject: { name: string };
        actor: { name: string } | null;
      }>;
    };
    const forced = body.data.find((e) => e.kind === "force_rejected")!;
    expect(forced.subject.name).toBe("feat/x");
    expect(forced.overridden).toBe(true);
    expect(forced.reason).toBe("obsoleted by a newer request; clearing the lane");
    expect(forced.actor).not.toBeNull();
  });
});
