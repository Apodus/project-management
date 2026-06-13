import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp, createTestProject, createTestUser, type TestApp } from "../utils.js";
import * as escalationService from "../../src/services/escalation.service.js";

// ─── Discord needs-human bridge (Campaign C2 §P5) ─────────────────
// The ONE out-of-band escalation notification: escalation.needs_human →
// exactly one Discord POST through the existing alert machinery (the same
// missing-url no-op + un-awaited-fetch resilience as the train/notes/claims
// alerts). Mirrors notes-alerts.test.ts's webhook-resilience idiom:
// vi.stubGlobal fetch, console.warn spy, createTestApp registers the listener
// via createApp, cleanup → resetEventBus.
//
// Per-event (NOT latched / no on-read eval) — it fires once in escalateToHuman,
// gated by assertTransition so needs_human is never re-entered. Acknowledge /
// answer / reply / resolve do NOT bridge.

const PROJECT_WITH_WEBHOOK = {
  settings: {
    ai_autonomy: {
      can_self_assign: true,
      can_create_subtasks: true,
      can_create_tasks: true,
      can_change_priority: true,
      can_close_epics: true,
      max_concurrent_tasks: 3,
    },
    workflow: { statuses: ["backlog", "done"] },
    git: { branch_prefix: "feat/", auto_link_branches: true },
    webhooks: {
      discord_url: "https://discord.com/api/webhooks/1/abc",
      alerts_enabled: true,
    },
  },
};

/**
 * Raise (open) → acknowledge (open → acknowledged) so the escalation is in a
 * legal source state for escalateToHuman. The human admin actor is legal at
 * every step. Returns the escalation id.
 */
function raiseAndAcknowledge(testApp: TestApp, projectId: string, originWorkerKey: string) {
  const human = createTestUser(testApp.db); // role admin, type human
  const actor = { id: human.id, type: "human" as const };
  const esc = escalationService.create(
    projectId,
    {
      kind: "bug_report",
      title: "merge train wedged on my repo",
      originRepo: "game_one",
      originWorkerKey,
      severity: "high",
    } as Parameters<typeof escalationService.create>[1],
    actor,
  ).escalation;
  escalationService.acknowledge(esc.id, actor);
  return { id: esc.id, actor };
}

describe("Discord needs-human bridge (Campaign C2 §P5)", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    testApp.cleanup();
  });

  // ── 1. needs_human → exactly one POST with title/kind/origin/id ────

  it("escalation.needs_human POSTs exactly one Discord message with title/kind/origin/id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const { id, actor } = raiseAndAcknowledge(testApp, project.id, "worker-needs-human-1");

    const row = escalationService.escalateToHuman(id, { reason: "needs a human call" }, actor);
    expect(row.status).toBe("needs_human");

    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse((opts as { body: string }).body);
    // Specific + actionable (NOT identity-masked): title, kind, origin, id all present.
    expect(body.content).toContain("merge train wedged on my repo");
    expect(body.content).toContain("bug_report");
    expect(body.content).toContain("game_one");
    expect(body.content).toContain("worker-needs-human-1");
    expect(body.content).toContain(id);
  });

  // ── 2. acknowledge / answer / reply / resolve do NOT POST ──────────

  it("only needs_human bridges — acknowledge/answer/reply/resolve do NOT POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const human = createTestUser(testApp.db);
    const actor = { id: human.id, type: "human" as const };

    const esc = escalationService.create(
      project.id,
      {
        kind: "question",
        title: "a question",
        originRepo: "game_one",
        originWorkerKey: "worker-no-bridge",
      } as Parameters<typeof escalationService.create>[1],
      actor,
    ).escalation;
    escalationService.acknowledge(esc.id, actor); // open → acknowledged
    escalationService.answer(esc.id, { body: "diagnosis here" }, actor); // → answered
    escalationService.addMessage(esc.id, { body: "a reply" }, actor); // a reply
    escalationService.resolve(esc.id, { reason: "fixed" }, actor); // → resolved

    await new Promise((r) => setImmediate(r));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── 3. No discord_url → escalateToHuman succeeds, no POST ──────────

  it("with no discord_url configured, escalateToHuman succeeds and does NOT POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    // A project with NO webhooks block (the createTestProject default).
    const project = createTestProject(testApp.db);
    const { id, actor } = raiseAndAcknowledge(testApp, project.id, "worker-no-url");

    const row = escalationService.escalateToHuman(id, { reason: "needs a human" }, actor);
    expect(row.status).toBe("needs_human");

    await new Promise((r) => setImmediate(r));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── 4. fetch rejects → escalateToHuman still returns; warning swallowed ─

  it("escalateToHuman still returns the needs_human row when the Discord POST rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const { id, actor } = raiseAndAcknowledge(testApp, project.id, "worker-fetch-rejects");

    const row = escalationService.escalateToHuman(id, { reason: "needs a human" }, actor);
    expect(row.status).toBe("needs_human");

    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The rejected POST was swallowed (.catch in the handler) — no throw escaped.
  });
});
