import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createTestApp,
  createTestAiAgent,
  createTestProject,
  createTestEpic,
  createTestTask,
  createTestProposal,
  authRequest,
  type TestApp,
} from "../utils.js";
import { createId, LEASE_GRACE_MS_DEFAULT, LEASE_TTL_MS_DEFAULT } from "@pm/shared";
import { eq } from "drizzle-orm";
import { epics, proposals } from "../../src/db/index.js";

// ──────────────────────────────────────────────────────────────────
// Campaign C3 (claims surface) — GET /api/v1/projects/:projectId/claims
// The claims-panel aggregate: every ACTIVE claim with its identity-masked
// claim_state, resolved holder {id, name, type}, and nullable lease-layer
// claimedAt. Pure read — no alert latch side effect.
// ──────────────────────────────────────────────────────────────────

const STALE_ADVANCE_MS = LEASE_TTL_MS_DEFAULT + LEASE_GRACE_MS_DEFAULT + 60_000;

describe("GET /api/v1/projects/:projectId/claims", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    vi.useRealTimers();
    testApp.cleanup();
  });

  async function claimAs(entity: "tasks" | "epics" | "proposals", id: string, token: string) {
    const res = await authRequest(testApp.app, "POST", `/api/v1/${entity}/${id}/claim`, {
      token,
    });
    expect(res.status).toBe(200);
  }

  async function getClaims(projectId: string, token?: string) {
    const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${projectId}/claims`, {
      token,
    });
    expect(res.status).toBe(200);
    return (await res.json()).data as {
      items: Array<{
        entityType: string;
        id: string;
        title: string;
        status: string;
        claimState: string;
        holder: { id: string; name: string; type: string };
        claimedAt: string | null;
        updatedAt: string;
      }>;
      total: number;
    };
  }

  it("unknown project → 404", async () => {
    const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${createId()}/claims`);
    expect(res.status).toBe(404);
  });

  it("empty project → empty items + total 0", async () => {
    const project = createTestProject(testApp.db);
    const data = await getClaims(project.id);
    expect(data.items).toEqual([]);
    expect(data.total).toBe(0);
  });

  it("claimed task/epic/proposal all appear with resolved holder name + claimedAt", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id, status: "ready" });
    const epic = createTestEpic(testApp.db, { projectId: project.id });
    const proposal = createTestProposal(testApp.db, { projectId: project.id, status: "open" });
    await claimAs("tasks", task.id, agent.token);
    await claimAs("epics", epic.id, agent.token);
    await claimAs("proposals", proposal.id, agent.token);

    const data = await getClaims(project.id);
    expect(data.total).toBe(3);
    expect(data.items.map((i) => i.entityType).sort()).toEqual(["epic", "proposal", "task"]);

    for (const item of data.items) {
      expect(item.holder.id).toBe(agent.user.id);
      expect(item.holder.name).toBe(agent.user.displayName);
      expect(item.holder.type).toBe("ai_agent");
      // The claim flows acquire a lease — claimedAt is present (non-null).
      expect(item.claimedAt).toEqual(expect.any(String));
      expect(item.updatedAt).toEqual(expect.any(String));
    }
    const taskItem = data.items.find((i) => i.entityType === "task")!;
    expect(taskItem.id).toBe(task.id);
    expect(taskItem.title).toBe(task.title);
    const epicItem = data.items.find((i) => i.entityType === "epic")!;
    expect(epicItem.title).toBe(epic.name);
  });

  it("claim_state is caller-relative: live to a stranger, yours to the holder", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id, status: "ready" });
    await claimAs("tasks", task.id, agent.token);

    // Default token = the admin (not the holder) → live.
    const asAdmin = await getClaims(project.id);
    expect(asAdmin.items[0]!.claimState).toBe("live");

    // The holder itself → yours.
    const asHolder = await getClaims(project.id, agent.token);
    expect(asHolder.items[0]!.claimState).toBe("yours");
  });

  it("a lapsed lease reads stale to others but YOURS to the self-held holder", async () => {
    const t0 = new Date("2026-06-10T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(t0);

    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id, status: "ready" });
    await claimAs("tasks", task.id, agent.token);

    vi.setSystemTime(new Date(t0.getTime() + STALE_ADVANCE_MS));

    const asAdmin = await getClaims(project.id);
    expect(asAdmin.items[0]!.claimState).toBe("stale");
    expect(asAdmin.items[0]!.claimedAt).toBe(t0.toISOString());

    // Self-stale → never surfaced as stale to the holder itself.
    const asHolder = await getClaims(project.id, agent.token);
    expect(asHolder.items[0]!.claimState).toBe("yours");
  });

  it("a claimed entity with NO lease row (legacy pre-engine) reads stale, claimedAt null", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    // Direct factory assignment — no claim flow, so no lease row exists.
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      status: "in_progress",
      assigneeId: agent.user.id,
    });

    const data = await getClaims(project.id);
    expect(data.total).toBe(1);
    expect(data.items[0]!.id).toBe(task.id);
    // No lease row ⇒ stale by definition (migration 0034 backfills these; the
    // human Release action handles any that slip through).
    expect(data.items[0]!.claimState).toBe("stale");
    expect(data.items[0]!.claimedAt).toBeNull();
  });

  it("unclaimed entities are excluded", async () => {
    const project = createTestProject(testApp.db);
    createTestTask(testApp.db, { projectId: project.id, status: "ready" });
    createTestEpic(testApp.db, { projectId: project.id });
    createTestProposal(testApp.db, { projectId: project.id, status: "open" });

    const data = await getClaims(project.id);
    expect(data.total).toBe(0);
  });

  it("terminal entities are excluded (task done/cancelled, epic completed, proposal rejected)", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    createTestTask(testApp.db, {
      projectId: project.id,
      status: "done",
      assigneeId: agent.user.id,
    });
    createTestTask(testApp.db, {
      projectId: project.id,
      status: "cancelled",
      assigneeId: agent.user.id,
    });
    const epic = createTestEpic(testApp.db, { projectId: project.id, status: "completed" });
    testApp.db.update(epics).set({ assigneeId: agent.user.id }).where(eq(epics.id, epic.id)).run();
    const proposal = createTestProposal(testApp.db, {
      projectId: project.id,
      status: "rejected",
    });
    testApp.db
      .update(proposals)
      .set({ claimedBy: agent.user.id })
      .where(eq(proposals.id, proposal.id))
      .run();

    const data = await getClaims(project.id);
    expect(data.total).toBe(0);
  });

  it("claims from another project are excluded", async () => {
    const projectA = createTestProject(testApp.db);
    const projectB = createTestProject(testApp.db, { slug: "other-project" });
    const agent = createTestAiAgent(testApp.db);
    const taskB = createTestTask(testApp.db, { projectId: projectB.id, status: "ready" });
    await claimAs("tasks", taskB.id, agent.token);

    const dataA = await getClaims(projectA.id);
    expect(dataA.total).toBe(0);
    const dataB = await getClaims(projectB.id);
    expect(dataB.total).toBe(1);
  });

  it("MASKING: the response carries no lease holderId field anywhere", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id, status: "ready" });
    await claimAs("tasks", task.id, agent.token);

    const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}/claims`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("holderId");
    expect(raw).not.toContain("holder_id");
    // The lease's internal timestamps never leak either.
    expect(raw).not.toContain("heartbeatAt");
    expect(raw).not.toContain("expiresAt");
  });
});
