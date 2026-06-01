import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestTask,
  createTestUser,
  type TestApp,
} from "../utils.js";
import * as requestSvc from "../../src/services/merge-request.service.js";
import * as attemptSvc from "../../src/services/merge-attempt.service.js";
import * as trainSvc from "../../src/services/train.service.js";
import * as incidentSvc from "../../src/services/merge-incident.service.js";
import * as resolutionSvc from "../../src/services/merge-resolution.service.js";

describe("merge-request timeline (design §5.7)", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  function agentActor() {
    const agent = createTestAiAgent(testApp.db);
    return { id: agent.user.id, role: agent.user.role, type: agent.user.type };
  }

  /** Assert events are sorted ascending by `at`. */
  function assertAscending(events: { at: string }[]): void {
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].at <= events[i].at).toBe(true);
    }
  }

  it("multi-attempt → land: composes queued, integrating, both attempts, land audit, landed milestone (ascending)", () => {
    const project = createTestProject(testApp.db);
    const submitter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id });
    const actor = agentActor();

    // submit → pickup
    const r = requestSvc.submit({
      projectId: project.id,
      submittedBy: submitter.id,
      taskId: task.id,
      branch: "feat/x",
    });
    requestSvc.transitionToIntegrating(r.id, actor);

    // attempt 1: start + fail
    const a1 = attemptSvc.startAttempt(r.id, { baseSha: "base1" }, actor);
    attemptSvc.completeAttempt(
      a1.id,
      {
        status: "failed",
        failureCategory: "verify",
        failureReason: "tests failed",
        logExcerpt: "boom",
        logUrl: "https://logs/1",
      },
      actor,
    );

    // attempt 2: start + pass
    const a2 = attemptSvc.startAttempt(r.id, { baseSha: "base2" }, actor);
    attemptSvc.completeAttempt(
      a2.id,
      { status: "passed", treeSha: "tree2" },
      actor,
    );

    // land
    requestSvc.land(r.id, { landedSha: "landedsha2" }, actor);

    const timeline = requestSvc.getTimeline(r.id);
    expect(timeline.request.id).toBe(r.id);
    assertAscending(timeline.events);

    const kinds = timeline.events.map((e) => e.kind);
    expect(kinds).toContain("queued");
    expect(kinds).toContain("integrating");
    expect(kinds.filter((k) => k === "attempt")).toHaveLength(2);
    expect(kinds).toContain("audit");
    expect(kinds).toContain("landed");

    // both attempts present with log pointers + failureCategory on the failed one
    const attempts = timeline.events.filter((e) => e.kind === "attempt");
    const failed = attempts.find((e) => e.status === "failed");
    expect(failed).toBeDefined();
    expect(failed!.failureCategory).toBe("verify");
    expect(failed!.logExcerpt).toBe("boom");
    expect(failed!.logUrl).toBe("https://logs/1");
    const passed = attempts.find((e) => e.status === "passed");
    expect(passed).toBeDefined();
    expect(passed!.treeSha).toBe("tree2");

    // the land audit row carries actor + before/after
    const landAudit = timeline.events.find(
      (e) => e.kind === "audit" && e.action === "land",
    );
    expect(landAudit).toBeDefined();
    expect(landAudit!.actorId).toBe(actor.id);
    expect(landAudit!.metadataBefore).toMatchObject({ status: "integrating" });
    expect(landAudit!.metadataAfter).toMatchObject({
      status: "landed",
      landedSha: "landedsha2",
    });

    // terminal landed milestone carries landedSha
    const landed = timeline.events.find((e) => e.kind === "landed");
    expect(landed).toBeDefined();
    expect(landed!.landedSha).toBe("landedsha2");

    // queued precedes integrating precedes landed
    const qi = kinds.indexOf("queued");
    const ii = kinds.indexOf("integrating");
    const li = kinds.indexOf("landed");
    expect(qi).toBeLessThan(ii);
    expect(ii).toBeLessThan(li);
  });

  it("Phase 7.5: per-step results surface under the attempt event", () => {
    const project = createTestProject(testApp.db);
    const submitter = createTestUser(testApp.db);
    const actor = agentActor();

    const r = requestSvc.submit({
      projectId: project.id,
      submittedBy: submitter.id,
      branch: "feat/steps",
    });
    requestSvc.transitionToIntegrating(r.id, actor);

    // attempt WITH steps
    const a1 = attemptSvc.startAttempt(r.id, { baseSha: "base1" }, actor);
    const steps = [
      {
        stepId: "lint",
        outcome: "pass" as const,
        cached: true,
        durationMs: 0,
        treeSha: "treeA",
        stepConfigSha: "cfg-lint",
      },
      {
        stepId: "unit",
        outcome: "pass" as const,
        cached: false,
        durationMs: 9000,
        treeSha: "treeA",
        stepConfigSha: "cfg-unit",
      },
    ];
    attemptSvc.completeAttempt(
      a1.id,
      { status: "passed", treeSha: "treeA", steps },
      actor,
    );

    // a second attempt WITHOUT steps stays degraded-to-7.4 (steps null)
    const a2 = attemptSvc.startAttempt(r.id, { baseSha: "base2" }, actor);
    attemptSvc.completeAttempt(a2.id, { status: "cancelled" }, actor);

    const timeline = requestSvc.getTimeline(r.id);
    const attempts = timeline.events.filter((e) => e.kind === "attempt");
    const withSteps = attempts.find((e) => e.status === "passed");
    expect(withSteps).toBeDefined();
    expect(withSteps!.steps).toEqual(steps);
    const cancelled = attempts.find((e) => e.status === "cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled!.steps ?? null).toBeNull();
  });

  it("force-land: timeline contains the force_land audit entry (admin actor + reason) + the overridden attempt", () => {
    const project = createTestProject(testApp.db);
    const submitter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id });
    const agent = agentActor();

    const r = requestSvc.submit({
      projectId: project.id,
      submittedBy: submitter.id,
      taskId: task.id,
      branch: "feat/y",
    });
    requestSvc.transitionToIntegrating(r.id, agent);

    // an admin human force-lands
    const admin = createTestUser(testApp.db, { role: "admin", type: "human" });
    trainSvc.forceLand(
      r.id,
      { landedSha: "ff00ba5", reason: "hotfix override" },
      { id: admin.id, role: admin.role, type: admin.type },
    );

    const timeline = requestSvc.getTimeline(r.id);
    assertAscending(timeline.events);

    const forceLandAudit = timeline.events.find(
      (e) => e.kind === "audit" && e.action === "force_land",
    );
    expect(forceLandAudit).toBeDefined();
    expect(forceLandAudit!.actorId).toBe(admin.id);
    expect(forceLandAudit!.reason).toBe("hotfix override");

    // the synthetic/overridden attempt shows in the timeline
    const attempts = timeline.events.filter((e) => e.kind === "attempt");
    expect(attempts.length).toBeGreaterThanOrEqual(1);

    // terminal landed milestone
    const landed = timeline.events.find((e) => e.kind === "landed");
    expect(landed).toBeDefined();
    expect(landed!.landedSha).toBe("ff00ba5");
  });

  it("orphaned: an incident with innerRequestId=request appears in the timeline with orphanedSha/state", () => {
    const project = createTestProject(testApp.db);
    const submitter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id });
    const agent = agentActor();

    const r = requestSvc.submit({
      projectId: project.id,
      submittedBy: submitter.id,
      taskId: task.id,
      branch: "feat/z",
    });

    incidentSvc.openIncident(
      {
        projectId: project.id,
        type: "orphaned_inner",
        innerRepo: "rynx-inner",
        orphanedSha: "orphan123",
        outerRepo: "game_one",
        innerRequestId: r.id,
        taskId: task.id,
      },
      agent,
    );

    const timeline = requestSvc.getTimeline(r.id);
    assertAscending(timeline.events);

    const incident = timeline.events.find((e) => e.kind === "incident");
    expect(incident).toBeDefined();
    expect(incident!.orphanedSha).toBe("orphan123");
    expect(incident!.state).toBe("open");
    expect(incident!.type).toBe("orphaned_inner");
  });

  it("does NOT include incidents whose innerRequestId is a different request", () => {
    const project = createTestProject(testApp.db);
    const submitter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id });
    const agent = agentActor();

    const r1 = requestSvc.submit({
      projectId: project.id,
      submittedBy: submitter.id,
      taskId: task.id,
    });
    const r2 = requestSvc.submit({
      projectId: project.id,
      submittedBy: submitter.id,
      taskId: task.id,
    });

    incidentSvc.openIncident(
      {
        projectId: project.id,
        type: "orphaned_inner",
        innerRepo: "rynx-inner",
        orphanedSha: "orphanOther",
        outerRepo: "game_one",
        innerRequestId: r2.id,
        taskId: task.id,
      },
      agent,
    );

    const timeline = requestSvc.getTimeline(r1.id);
    expect(timeline.events.some((e) => e.kind === "incident")).toBe(false);
  });

  it("Phase 7.6 origin chain: origin timeline carries a resolution event (state resolved + resolvedRequestId), ordered after the rejected milestone", () => {
    const project = createTestProject(testApp.db);
    const submitter = createTestUser(testApp.db);
    const actor = agentActor();

    // origin: submit → integrate → reject with a textual conflict
    const origin = requestSvc.submit({
      projectId: project.id,
      submittedBy: submitter.id,
      branch: "feat/origin",
    });
    requestSvc.transitionToIntegrating(origin.id, actor);
    requestSvc.reject(
      origin.id,
      {
        category: "conflict",
        reason: "rebase conflict",
        failedFiles: ["src/a.ts"],
      },
      actor,
    );

    // resolver opens + starts a resolution for the origin
    const res = resolutionSvc.open(
      {
        projectId: project.id,
        originRequestId: origin.id,
        conflictingFiles: ["src/a.ts"],
      },
      actor,
    );
    resolutionSvc.start(res.id, actor);

    // resolver resubmits the resolved tree as a NEW request (resolvedFrom → origin)
    const resolved = requestSvc.submit({
      projectId: project.id,
      submittedBy: submitter.id,
      branch: "feat/resolved",
      resolvedFrom: origin.id,
    });
    resolutionSvc.resolved(
      res.id,
      { resolvedRequestId: resolved.id, detail: { budgetConsumedSec: 42 } },
      actor,
    );

    const timeline = requestSvc.getTimeline(origin.id);
    assertAscending(timeline.events);

    const resolution = timeline.events.find((e) => e.kind === "resolution");
    expect(resolution).toBeDefined();
    expect(resolution!.resolutionState).toBe("resolved");
    expect(resolution!.resolutionId).toBe(res.id);
    expect(resolution!.originRequestId).toBe(origin.id);
    expect(resolution!.resolvedRequestId).toBe(resolved.id);
    expect(resolution!.conflictingFiles).toEqual(["src/a.ts"]);

    // ordered after the rejected milestone (the resolution attempt started
    // after the conflict reject).
    const kinds = timeline.events.map((e) => e.kind);
    expect(kinds.indexOf("rejected")).toBeLessThan(kinds.indexOf("resolution"));
  });

  it("Phase 7.6 resolved back-link: the resolved request timeline carries a resolution_origin event pointing at its origin", () => {
    const project = createTestProject(testApp.db);
    const submitter = createTestUser(testApp.db);

    const origin = requestSvc.submit({
      projectId: project.id,
      submittedBy: submitter.id,
      branch: "feat/origin2",
    });
    const resolved = requestSvc.submit({
      projectId: project.id,
      submittedBy: submitter.id,
      branch: "feat/resolved2",
      resolvedFrom: origin.id,
    });

    const timeline = requestSvc.getTimeline(resolved.id);
    assertAscending(timeline.events);

    const back = timeline.events.find((e) => e.kind === "resolution_origin");
    expect(back).toBeDefined();
    expect(back!.originRequestId).toBe(origin.id);
  });

  it("404 for an unknown request id", () => {
    expect(() => requestSvc.getTimeline("01UNKNOWNREQUEST000000000000")).toThrowError(
      expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }),
    );
  });
});
