import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createId, type MergePhase, type PhaseTraceEntry } from "@pm/shared";
import { createTestApp, createTestProject, createTestUser, type TestApp } from "../utils.js";
import { mergePhaseTimings, mergeRequestGroups, mergeRequests, tasks } from "../../src/db/index.js";
import { EVENT_NAMES, getEventBus, type EventPayload } from "../../src/events/event-bus.js";
import { postDiscord } from "../../src/events/alerts-listener.js";
import { formatTrainFeedEvent } from "../../src/events/train-feed-listener.js";
import { formatPhaseLine } from "../../src/events/phase-line.js";
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

/** One completed phase row, as the integrator's ingest would have written it. */
function seedPhase(
  testApp: TestApp,
  args: {
    projectId: string;
    phase: MergePhase;
    startedAt: string;
    durationMs: number;
    requestId?: string | null;
    groupId?: string | null;
    label?: string | null;
  },
): void {
  testApp.db
    .insert(mergePhaseTimings)
    .values({
      id: createId(),
      projectId: args.projectId,
      resource: "main",
      requestId: args.requestId ?? null,
      groupId: args.groupId ?? null,
      attemptId: null,
      phase: args.phase,
      label: args.label ?? null,
      startedAt: args.startedAt,
      durationMs: args.durationMs,
      detail: null,
      recordedBy: null,
      createdAt: args.startedAt,
    })
    .run();
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

  // ── 5b. Incidents narrate their DIRECTION ─────────────────────────

  it("narrates an orphaned_inner open in the inner→outer direction", () => {
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const content = formatTrainFeedEvent(EVENT_NAMES.MERGE_INCIDENT_OPENED, {
      ...payload(project.id, "inc-orphan", {
        type: "orphaned_inner",
        innerRepo: "rynx",
        outerRepo: "game",
        orphanedSha: "0rphaned5ha000000000",
      }),
      entityType: "merge_incident",
    });
    expect(content).toContain("orphaned_inner");
    expect(content).toContain("Orphaned inner: rynx@0rphane");
    expect(content).toContain("game's gitlink was not updated to it");
    // The train DOES auto-heal this one — no human-decision clause.
    expect(content).not.toContain("a human must decide");
  });

  it("narrates a dangling_gitlink open outer→inner and says the train will not heal it", () => {
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const content = formatTrainFeedEvent(EVENT_NAMES.MERGE_INCIDENT_OPENED, {
      ...payload(project.id, "inc-dangling", {
        type: "dangling_gitlink",
        innerRepo: "rynx",
        outerRepo: "game",
        orphanedSha: "1ba6a1ffd6000000000",
      }),
      entityType: "merge_incident",
    });
    expect(content).toContain("dangling_gitlink");
    expect(content).toContain("Dangling gitlink: game main's gitlink points at 1ba6a1f");
    expect(content).toContain("not on rynx main");
    expect(content).toContain("a human must decide");
    // NOT the old vague fallback.
    expect(content).not.toContain(" vs ");
  });

  it("falls back to the vague line for a type this build does not know", () => {
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const content = formatTrainFeedEvent(EVENT_NAMES.MERGE_INCIDENT_OPENED, {
      ...payload(project.id, "inc-x", {
        type: "from_the_future",
        innerRepo: "rynx",
        outerRepo: "game",
        orphanedSha: "abcdef0123456789",
      }),
      entityType: "merge_incident",
    });
    expect(content).toContain("from_the_future");
    expect(content).toContain(" vs ");
    // Says nothing directional about a type it cannot describe.
    expect(content).not.toContain("a human must decide");
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

// ─── The stopwatch line (campaign 2026-08-03 §P6) ─────────────────
//
// The second line of a terminal narration: WHERE the wall clock the first line
// reports actually went. Every figure is a UNION of intervals, scoped to THIS
// trip — the two properties that keep it coherent with the "26m since pickup"
// header it sits under.

const STOPWATCH = ":stopwatch:";

describe("Discord train feed — the stopwatch phase line", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    testApp.cleanup();
  });

  /** A landed single-repo request, picked up 26m ago after a 14m queue wait. */
  function landedRequest(projectId: string, submittedBy: string): string {
    return seedRequest(testApp, {
      projectId,
      submittedBy,
      status: "landed",
      branch: "feat/wind",
      enqueuedAt: ago(40 * MIN),
      pickedUpAt: ago(26 * MIN),
    });
  }

  function landEvent(projectId: string, reqId: string, extra: Record<string, unknown> = {}) {
    return formatTrainFeedEvent(
      EVENT_NAMES.MERGE_REQUEST_LANDED,
      payload(projectId, reqId, {
        branch: "feat/wind",
        pickedUpAt: ago(26 * MIN),
        landedSha: "abc1234def5678abc1234def5678abc1234def56",
        ...extra,
      }),
    );
  }

  // ── 1. Nothing observed → nothing said ───────────────────────────

  it("no phase rows → no stopwatch line at all (the narration stays one line)", () => {
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const reqId = landedRequest(project.id, worker.id);

    const content = landEvent(project.id, reqId)!;
    // A derived queue wait alone is not an answer to "where did the time go" —
    // an uninstrumented daemon narrates exactly as it did before P6.
    expect(content).not.toContain(STOPWATCH);
    expect(content.split("\n")).toHaveLength(1);
  });

  // ── 2. Pipeline order, and absence is not zero ───────────────────

  it("a landed request breaks into pipeline-ordered phases; unobserved phases are ABSENT", () => {
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const reqId = landedRequest(project.id, worker.id);
    const phase = (p: MergePhase, startMinAgo: number, durationMin: number): void =>
      seedPhase(testApp, {
        projectId: project.id,
        requestId: reqId,
        phase: p,
        startedAt: ago(startMinAgo * MIN),
        durationMs: durationMin * MIN,
      });

    phase("assemble", 26, 3);
    phase("verify", 23, 22);
    seedPhase(testApp, {
      projectId: project.id,
      requestId: reqId,
      phase: "land",
      startedAt: ago(1 * MIN),
      durationMs: 8_000,
    });

    const content = landEvent(project.id, reqId)!;
    expect(content).toContain(STOPWATCH);
    expect(content).toContain("queue 14m");
    expect(content).toContain("assemble 3m");
    expect(content).toContain("verify 22m");
    expect(content).toContain("land 8s");
    // Never zero-filled: a phase nobody observed is simply not there.
    expect(content).not.toContain("materialize");
    expect(content).not.toContain("rebase");
    // Pipeline order is a property of construction, not of arrival.
    const order = ["queue 14m", "assemble 3m", "verify 22m", "land 8s"].map((s) =>
      content.indexOf(s),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  // ── 3. Trip scope: a requeue must not re-charge a prior attempt ───

  /**
   * Submitted 50m ago, verified 25m (ending 20m ago), re-queued, picked up 8m
   * ago, verified 7m more, landed. The store holds BOTH verifies.
   */
  function requeuedRequest(projectId: string, submittedBy: string): string {
    const reqId = seedRequest(testApp, {
      projectId,
      submittedBy,
      status: "landed",
      branch: "feat/retried",
      enqueuedAt: ago(50 * MIN),
      pickedUpAt: ago(8 * MIN),
    });
    seedPhase(testApp, {
      projectId,
      requestId: reqId,
      phase: "verify",
      startedAt: ago(45 * MIN),
      durationMs: 25 * MIN,
    });
    seedPhase(testApp, {
      projectId,
      requestId: reqId,
      phase: "verify",
      startedAt: ago(8 * MIN),
      durationMs: 7 * MIN,
    });
    return reqId;
  }

  it("a requeued request reports only THIS trip's verify — the prior attempt is excluded", () => {
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const reqId = requeuedRequest(project.id, worker.id);

    const content = landEvent(project.id, reqId, { branch: "feat/retried" })!;
    expect(content).toContain("verify 7m");
    // The two attempts are DISJOINT in time, so a union over both would degrade
    // to their sum (32m) — under a header that says minutes since THIS pickup.
    expect(content).not.toContain("verify 32m");
    expect(content).not.toContain("verify 25m");
  });

  it("a requeued queue wait charges the last segment and still names the total", () => {
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const reqId = requeuedRequest(project.id, worker.id);

    const content = landEvent(project.id, reqId, { branch: "feat/retried" })!;
    expect(content).toContain("queue 12m (42m since submit)");
    expect(content).not.toContain("queue 42m");
  });

  // ── 4. Concurrency: the union, never the sum ─────────────────────

  it("a cross-repo group's concurrent verify unions instead of summing, and collapses roles", () => {
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const groupId = seedGroup(testApp, project.id, worker.id); // created 40m ago
    const inner = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "landed",
      branch: "fix/inner",
      groupId,
      enqueuedAt: ago(40 * MIN),
      pickedUpAt: ago(30 * MIN),
    });
    const outer = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "landed",
      branch: "fix/outer",
      groupId,
      enqueuedAt: ago(40 * MIN),
      pickedUpAt: ago(30 * MIN),
    });
    const verify = (requestId: string, label: string, startMinAgo: number, min: number): void =>
      seedPhase(testApp, {
        projectId: project.id,
        requestId,
        phase: "verify",
        label,
        startedAt: ago(startMinAgo * MIN),
        durationMs: min * MIN,
      });
    verify(inner, "inner:build", 30, 18);
    verify(outer, "outer:build", 30, 20);
    verify(inner, "inner:test", 12, 8);
    verify(outer, "outer:test", 10, 6);

    const content = formatTrainFeedEvent(EVENT_NAMES.MERGE_GROUP_LANDED, {
      ...payload(project.id, groupId, {
        innerLandedSha: "aaaa1111bbbb2222",
        outerLandedSha: "cccc3333dddd4444",
      }),
      entityType: "merge_group",
    })!;

    // 52m of measured verify across two repos is 26m of wall clock.
    expect(content).toContain("verify 26m");
    expect(content).not.toContain("verify 52m");
    expect(content).toContain("concurrent");
    // Roles collapse: `inner:build` + `outer:build` is one `build` part.
    expect(content).toContain("build 20m");
    expect(content).toContain("test 8m");
    expect(content).not.toContain("inner:build");
    // A group waits to FORM; it never sat in the per-request queue.
    expect(content).toContain("forming 10m");
    expect(content).not.toContain("queue");
  });

  it("two overlapping single-repo verifies in one wave are not double-charged", () => {
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const reqId = landedRequest(project.id, worker.id);
    seedPhase(testApp, {
      projectId: project.id,
      requestId: reqId,
      phase: "verify",
      startedAt: ago(26 * MIN),
      durationMs: 20 * MIN,
    });
    seedPhase(testApp, {
      projectId: project.id,
      requestId: reqId,
      phase: "verify",
      startedAt: ago(11 * MIN),
      durationMs: 15 * MIN,
    });

    const content = landEvent(project.id, reqId)!;
    // 0→20m and 15→30m is 30m of wall clock: not 35m (sum), not 20m (max).
    expect(content).toContain("verify 30m");
    expect(content).not.toContain("verify 35m");
  });

  // ── 5. A grouped member is narrated ONCE ─────────────────────────

  it("a grouped member's own reject carries NO stopwatch line — the group's does", () => {
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const groupId = seedGroup(testApp, project.id, worker.id);
    const outer = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "rejected",
      branch: "fix/outer",
      groupId,
      enqueuedAt: ago(40 * MIN),
      pickedUpAt: ago(30 * MIN),
    });
    seedPhase(testApp, {
      projectId: project.id,
      requestId: outer,
      phase: "land",
      startedAt: ago(4 * MIN),
      durationMs: 90_000,
    });

    // The partially-landed path rejects the outer member INDIVIDUALLY, seconds
    // before the group event — two stopwatch lines, the group's a strict
    // superset of the member's, is the double-accounting the union forbids.
    const member = formatTrainFeedEvent(
      EVENT_NAMES.MERGE_REQUEST_REJECTED,
      payload(project.id, outer, {
        branch: "fix/outer",
        groupId,
        pickedUpAt: ago(30 * MIN),
        category: "other",
        reason: "outer push failed after inner landed",
      }),
    )!;
    expect(member).toContain("Rejected");
    expect(member).not.toContain(STOPWATCH);

    const group = formatTrainFeedEvent(EVENT_NAMES.MERGE_GROUP_REJECTED, {
      ...payload(project.id, groupId, {
        outcome: "partially_landed",
        reason: "outer push failed after inner landed",
      }),
      entityType: "merge_group",
    })!;
    expect(group).toContain("PARTIALLY landed");
    expect(group).toContain(STOPWATCH);
    expect(group).toContain("land 2m");
  });

  // ── 6. A reject keeps its reason AND gains the breakdown ─────────

  it("a reject carries the category, the real reason, and the sub-step breakdown", () => {
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const reqId = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "rejected",
      branch: "feat/broken",
      enqueuedAt: ago(40 * MIN),
      pickedUpAt: ago(26 * MIN),
    });
    seedPhase(testApp, {
      projectId: project.id,
      requestId: reqId,
      phase: "verify",
      label: "build",
      startedAt: ago(26 * MIN),
      durationMs: 18 * MIN,
    });
    seedPhase(testApp, {
      projectId: project.id,
      requestId: reqId,
      phase: "verify",
      label: "test",
      startedAt: ago(8 * MIN),
      durationMs: 8 * MIN,
    });

    const content = formatTrainFeedEvent(
      EVENT_NAMES.MERGE_REQUEST_REJECTED,
      payload(project.id, reqId, {
        branch: "feat/broken",
        pickedUpAt: ago(26 * MIN),
        category: "verify_failed",
        reason: "outer verify exit 1: shader reflection drift",
      }),
    )!;
    expect(content).toContain("[verify_failed]");
    expect(content).toContain("outer verify exit 1: shader reflection drift");
    // Back-to-back parts DO partition the phase, so they are joined with "/"
    // and no `concurrent` marker is claimed.
    expect(content).toContain("verify 26m (build 18m / test 8m)");
    expect(content).not.toContain("concurrent");
  });

  // ── 7. The character budget ──────────────────────────────────────

  it("the line stays within 240 chars: every phase survives, the poorest breakdown is dropped", () => {
    const T0 = Date.parse("2026-08-02T00:00:00.000Z");
    const at = (min: number): string => new Date(T0 + min * MIN).toISOString();
    const derived = (
      phase: "forming" | "queue_wait",
      groupId: string | null,
      requestId: string | null,
    ): PhaseTraceEntry => ({
      derived: true,
      phase,
      projectId: "p",
      resource: "main",
      requestId,
      groupId,
      startedAt: at(0),
      durationMs: 10 * MIN,
      originAt: at(-30),
      originDurationMs: 40 * MIN,
      basis: "requeued",
    });
    const stored = (
      phase: Exclude<MergePhase, "forming" | "queue_wait">,
      label: string | null,
      startMin: number,
      durationMin: number,
    ): PhaseTraceEntry => ({
      derived: false,
      id: createId(),
      projectId: "p",
      resource: "main",
      requestId: "r",
      groupId: null,
      attemptId: null,
      phase,
      label,
      startedAt: at(startMin),
      durationMs: durationMin * MIN,
      detail: null,
      recordedBy: null,
      createdAt: at(startMin),
    });

    const line = formatPhaseLine([
      derived("forming", "g", null),
      derived("queue_wait", null, "r"),
      stored("assemble", "worktree-reset-and-repair", 10, 2),
      stored("assemble", "binding-resolve-and-fetch", 12, 3),
      stored("materialize", "lfs-objects", 15, 4),
      stored("materialize", "submodule-worktree", 19, 3),
      stored("rebase", "inner-rebase", 22, 2),
      stored("rebase", "outer-rebase", 24, 2),
      stored("verify", "build", 26, 20),
      stored("verify", "test", 46, 10),
      stored("land", "fetch-live-main-ref", 56, 1),
      stored("land", "push-fast-forward", 57, 2),
    ])!;

    expect(line.length).toBeLessThanOrEqual(240);
    // Pass 1 is never sacrificed: every phase, and both re-anchored totals.
    for (const name of [
      "forming",
      "queue",
      "assemble",
      "materialize",
      "rebase",
      "verify",
      "land",
    ]) {
      expect(line).toContain(name);
    }
    expect(line).toContain("(40m since created)");
    expect(line).toContain("(40m since submit)");
    // Pass 2 spends what is left richest-phase-first...
    expect(line).toContain("build 20m / test 10m");
    // ...so the cheapest phases lose their breakdown rather than the line
    // losing a phase.
    expect(line).not.toContain("binding-resolve");
  });

  // ── 8. Failure modes never cost the narration ────────────────────

  it("an unreadable trace still posts the base line and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    // An id with no merge_requests row: listForRequest 404s.
    const ghost = createId();

    const content = landEvent(project.id, ghost)!;
    expect(content).toContain("Landed");
    expect(content).not.toContain(STOPWATCH);
    expect(warn).toHaveBeenCalled();
  });

  it("a corrupt detail blob costs the stopwatch line and nothing else — the land still narrates", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const integrator = createTestUser(testApp.db, { type: "ai_agent" });
    const reqId = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "integrating",
      branch: "feat/corrupt",
      enqueuedAt: ago(40 * MIN),
      pickedUpAt: ago(26 * MIN),
    });
    // Raw SQL: drizzle's JSON hydration throws a SyntaxError on read — a
    // different failure shape from the AppError the guard was written for.
    testApp.db.run(sql`
      INSERT INTO merge_phase_timings
        (id, project_id, resource, request_id, phase, started_at, duration_ms, detail, created_at)
      VALUES (${createId()}, ${project.id}, 'main', ${reqId}, 'verify',
              ${ago(20 * MIN)}, ${5 * MIN}, '{not json', ${ago(20 * MIN)})
    `);

    const view = mergeRequestService.land(
      reqId,
      { landedSha: "abc1234def5678abc1234def5678abc1234def56" },
      { id: integrator.id, type: "ai_agent", role: "admin" },
    );
    expect(view.status).toBe("landed");

    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.content).toContain("Landed");
    expect(body.content).not.toContain(STOPWATCH);
    expect(warn).toHaveBeenCalled();
  });

  // ── 9. One message, one POST, one gate ───────────────────────────

  it("a real land POSTs ONE message whose content carries both lines", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const project = createTestProject(testApp.db, PROJECT_WITH_WEBHOOK);
    const worker = createTestUser(testApp.db);
    const integrator = createTestUser(testApp.db, { type: "ai_agent" });
    const reqId = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "integrating",
      branch: "feat/wind",
      enqueuedAt: ago(40 * MIN),
      pickedUpAt: ago(26 * MIN),
    });
    seedPhase(testApp, {
      projectId: project.id,
      requestId: reqId,
      phase: "verify",
      startedAt: ago(26 * MIN),
      durationMs: 22 * MIN,
    });

    mergeRequestService.land(
      reqId,
      { landedSha: "abc1234def5678abc1234def5678abc1234def56" },
      { id: integrator.id, type: "ai_agent", role: "admin" },
    );

    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.content).toContain("Landed");
    expect(body.content).toContain(STOPWATCH);
    expect(body.content).toContain("verify 22m");
    expect(body.content.split("\n")).toHaveLength(2);
  });

  it("train_events_enabled=false silences the stopwatch line with the rest of the feed", async () => {
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
    const worker = createTestUser(testApp.db);
    const integrator = createTestUser(testApp.db, { type: "ai_agent" });
    const reqId = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: worker.id,
      status: "integrating",
      branch: "feat/quiet",
      enqueuedAt: ago(40 * MIN),
      pickedUpAt: ago(26 * MIN),
    });
    seedPhase(testApp, {
      projectId: project.id,
      requestId: reqId,
      phase: "verify",
      startedAt: ago(26 * MIN),
      durationMs: 22 * MIN,
    });

    mergeRequestService.land(
      reqId,
      { landedSha: "abc1234def5678abc1234def5678abc1234def56" },
      { id: integrator.id, type: "ai_agent", role: "admin" },
    );

    await new Promise((r) => setImmediate(r));
    // No new setting: the phase text rides the SAME postDiscord(…, "train_feed").
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
