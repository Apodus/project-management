import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createId } from "@pm/shared";
import { createTestApp, createTestProject, createTestUser, type TestApp } from "../utils.js";
import { mergeRequestGroups, mergeRequests, tasks } from "../../src/db/index.js";
import { EVENT_NAMES, getEventBus, type EventPayload } from "../../src/events/event-bus.js";
import { postDiscord } from "../../src/events/alerts-listener.js";
import { formatTrainFeedEvent } from "../../src/events/train-feed-listener.js";
import * as mergeRequestService from "../../src/services/merge-request.service.js";

// ─── Discord merge-train EVENT FEED ───────────────────────────────
//
// The narration channel beside the threshold alerts: pickup / land / reject /
// incident / pause are POSTed to the SAME project webhook so an operator can
// read the train's event stream in Discord. Queue submissions are deliberately
// NOT narrated. Mirrors the escalation-needs-human-alert.test.ts idiom
// (vi.stubGlobal fetch, createTestApp registers the listeners via createApp).

const PROJECT_WITH_WEBHOOK = {
  settings: {
    webhooks: {
      discord_url: "https://discord.com/api/webhooks/1/abc",
      alerts_enabled: true,
    },
  },
};

const NOW = "2026-08-02T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const MIN = 60_000;

function ago(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

function seedTask(testApp: TestApp, projectId: string, reporterId: string, title: string): string {
  const id = createId();
  const ts = ago(60 * MIN);
  testApp.db
    .insert(tasks)
    .values({ id, projectId, title, reporterId, createdAt: ts, updatedAt: ts })
    .run();
  return id;
}

function seedRequest(
  testApp: TestApp,
  args: {
    projectId: string;
    submittedBy: string;
    status: string;
    taskId?: string | null;
    branch?: string | null;
    groupId?: string | null;
    synthetic?: boolean;
    enqueuedAt?: string;
    pickedUpAt?: string | null;
    landedSha?: string | null;
  },
): string {
  const id = createId();
  const enqueuedAt = args.enqueuedAt ?? ago(30 * MIN);
  testApp.db
    .insert(mergeRequests)
    .values({
      id,
      projectId: args.projectId,
      resource: "main",
      submittedBy: args.submittedBy,
      taskId: args.taskId ?? null,
      branch: args.branch ?? null,
      commitSha: args.branch ? "deadbeefdeadbeefdeadbeef" : null,
      groupId: args.groupId ?? null,
      synthetic: args.synthetic ?? false,
      status: args.status,
      enqueuedAt,
      pickedUpAt: args.pickedUpAt ?? null,
      landedSha: args.landedSha ?? null,
      createdAt: enqueuedAt,
      updatedAt: enqueuedAt,
    })
    .run();
  return id;
}

function seedGroup(testApp: TestApp, projectId: string, submittedBy: string): string {
  const id = createId();
  const ts = ago(40 * MIN);
  testApp.db
    .insert(mergeRequestGroups)
    .values({
      id,
      projectId,
      resource: "main",
      state: "integrating",
      submittedBy,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  return id;
}

/** Build the payload shape the services emit: row + extras spread onto entity. */
function payload(
  projectId: string,
  entityId: string,
  entity: Record<string, unknown>,
  actorId: string | null = null,
): EventPayload {
  return {
    entity: { id: entityId, resource: "main", ...entity },
    entityType: "merge_request",
    entityId,
    projectId,
    actorId,
    timestamp: NOW,
  };
}

describe("Discord merge-train event feed", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    testApp.cleanup();
  });

  // ── 1. Pickup: the "started working on X, queue depth n" line ──────

  it("pickup POSTs one message naming the work, the wait, and the remaining queue depth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const integrator = createTestUser(testApp.db, { type: "ai_agent" });
    const taskId = seedTask(testApp, project.id, worker.id, "Fix grass placement drift");
    const reqId = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "queued",
      taskId,
      branch: "fix/grass",
    });
    // Two more still waiting → the announced depth is 2, not 3.
    seedRequest(testApp, { projectId: project.id, submittedBy: worker.id, status: "queued" });
    seedRequest(testApp, { projectId: project.id, submittedBy: worker.id, status: "queued" });

    mergeRequestService.transitionToIntegrating(reqId, {
      id: integrator.id,
      type: "ai_agent",
      role: "admin",
    });

    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.content).toContain("Integrating");
    expect(body.content).toContain("Fix grass placement drift");
    expect(body.content).toContain("fix/grass");
    expect(body.content).toContain("queue depth now 2");
    expect(body.content).toContain(reqId);
  });

  // ── 2. Submits are NOT narrated ───────────────────────────────────

  it("a queued (submitted) request is NOT narrated", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const reqId = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "queued",
      branch: "feat/x",
    });

    getEventBus().emit(
      EVENT_NAMES.MERGE_REQUEST_QUEUED,
      payload(project.id, reqId, { branch: "feat/x", status: "queued" }),
    );

    await new Promise((r) => setImmediate(r));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── 3. A grouped member's own pickup is silent (the group line covers it) ─

  it("formats nothing for a grouped member's pickup — the group announcement owns it", () => {
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const groupId = seedGroup(testApp, project.id, worker.id);
    const reqId = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "integrating",
      branch: "fix/inner",
      groupId,
    });

    const content = formatTrainFeedEvent(
      EVENT_NAMES.MERGE_REQUEST_INTEGRATING,
      payload(project.id, reqId, { branch: "fix/inner", groupId }),
    );
    expect(content).toBeNull();
  });

  // ── 4. Group start: named by its real member, synthetic member ignored ──

  it("group start names the group by its REAL member's task and reports member count + depth", () => {
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const groupId = seedGroup(testApp, project.id, worker.id);
    const taskId = seedTask(testApp, project.id, worker.id, "Grass shader UBO fix");
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "integrating",
      taskId,
      branch: "fix/grass-inner",
      groupId,
    });
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "integrating",
      groupId,
      synthetic: true,
    });
    seedRequest(testApp, { projectId: project.id, submittedBy: worker.id, status: "queued" });

    const content = formatTrainFeedEvent(EVENT_NAMES.MERGE_GROUP_STARTED, {
      ...payload(project.id, groupId, { memberCount: 2 }),
      entityType: "merge_group",
    });
    expect(content).toContain("Integrating group");
    expect(content).toContain("Grass shader UBO fix");
    expect(content).toContain("fix/grass-inner");
    expect(content).toContain("2 members");
    expect(content).toContain("queue depth now 1");
    expect(content).toContain(groupId);
  });

  // ── 5. Outcomes: land / reject carry sha, category, reason, elapsed ──

  it("land narrates the landed sha and the elapsed time since pickup", () => {
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const taskId = seedTask(testApp, project.id, worker.id, "Add wind sway");
    const reqId = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "landed",
      taskId,
      branch: "feat/wind",
      pickedUpAt: ago(26 * MIN),
    });

    const content = formatTrainFeedEvent(
      EVENT_NAMES.MERGE_REQUEST_LANDED,
      payload(project.id, reqId, {
        taskId,
        branch: "feat/wind",
        pickedUpAt: ago(26 * MIN),
        landedSha: "abc1234def5678abc1234def5678abc1234def56",
      }),
    );
    expect(content).toContain("Landed");
    expect(content).toContain("Add wind sway");
    expect(content).toContain("abc1234d");
    expect(content).toContain("26m since pickup");
  });

  it("reject narrates the category and the real reason", () => {
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const reqId = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "rejected",
      branch: "feat/broken",
      pickedUpAt: ago(5 * MIN),
    });

    const content = formatTrainFeedEvent(
      EVENT_NAMES.MERGE_REQUEST_REJECTED,
      payload(project.id, reqId, {
        branch: "feat/broken",
        pickedUpAt: ago(5 * MIN),
        category: "verify_failed",
        reason: "outer verify exit 1: shader reflection drift",
      }),
    );
    expect(content).toContain("Rejected");
    expect(content).toContain("feat/broken");
    expect(content).toContain("[verify_failed]");
    expect(content).toContain("outer verify exit 1: shader reflection drift");
    expect(content).toContain(reqId);
  });

  it("group reject and partial-land are distinguishable", () => {
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const groupId = seedGroup(testApp, project.id, worker.id);
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "rejected",
      branch: "fix/inner",
      groupId,
    });

    const rejected = formatTrainFeedEvent(EVENT_NAMES.MERGE_GROUP_REJECTED, {
      ...payload(project.id, groupId, { outcome: "rejected", reason: "gitlink_diverged" }),
      entityType: "merge_group",
    });
    expect(rejected).toContain("Group rejected");
    expect(rejected).toContain("gitlink_diverged");

    const partial = formatTrainFeedEvent(EVENT_NAMES.MERGE_GROUP_REJECTED, {
      ...payload(project.id, groupId, {
        outcome: "partially_landed",
        reason: "outer push failed after inner landed",
      }),
      entityType: "merge_group",
    });
    expect(partial).toContain("PARTIALLY landed");
    expect(partial).toContain("outer push failed after inner landed");
  });

  // ── 6. The feed gate is independent of the alert gate ──────────────

  it("train_events_enabled=false silences the feed but NOT the alerts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const project = createTestProject(testApp.db, {
      settings: {
        webhooks: {
          discord_url: "https://discord.com/api/webhooks/1/abc",
          alerts_enabled: true,
          train_events_enabled: false,
        },
      },
    });

    await postDiscord(project.id, "feed line", "train_feed");
    expect(fetchMock).not.toHaveBeenCalled();

    await postDiscord(project.id, "alert line", "alert");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("alerts_enabled=false is the master mute — it silences the feed too", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const project = createTestProject(testApp.db, {
      settings: {
        webhooks: {
          discord_url: "https://discord.com/api/webhooks/1/abc",
          alerts_enabled: false,
        },
      },
    });

    await postDiscord(project.id, "feed line", "train_feed");
    await postDiscord(project.id, "alert line", "alert");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no discord_url configured → pickup succeeds and nothing is POSTed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const project = createTestProject(testApp.db); // no webhooks block
    const worker = createTestUser(testApp.db);
    const integrator = createTestUser(testApp.db, { type: "ai_agent" });
    const reqId = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "queued",
      branch: "feat/y",
    });

    const view = mergeRequestService.transitionToIntegrating(reqId, {
      id: integrator.id,
      type: "ai_agent",
      role: "admin",
    });
    expect(view.status).toBe("integrating");

    await new Promise((r) => setImmediate(r));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── 7. Resilience: a Discord outage never breaks the train ─────────

  it("pickup still succeeds when the Discord POST rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const integrator = createTestUser(testApp.db, { type: "ai_agent" });
    const reqId = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "queued",
      branch: "feat/z",
    });

    const view = mergeRequestService.transitionToIntegrating(reqId, {
      id: integrator.id,
      type: "ai_agent",
      role: "admin",
    });
    expect(view.status).toBe("integrating");

    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
