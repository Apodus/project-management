import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createId } from "@pm/shared";
import {
  createTestApp,
  createTestProject,
  createTestUser,
  type TestApp,
} from "../utils.js";
import { escalations, escalationMessages } from "../../src/db/index.js";
import * as metrics from "../../src/services/escalation-metrics.service.js";

// A fixed reference "now" so oldest-age / durations are deterministic.
const NOW = "2026-06-13T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function ago(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

const HOUR = 3600_000;
const MIN = 60_000;

// ── Seed helpers ─────────────────────────────────────────────────

function seedEscalation(
  testApp: TestApp,
  args: {
    projectId: string;
    authorId: string;
    kind?: string;
    status?: string;
    createdAt?: string;
    resolvedAt?: string | null;
  },
): string {
  const id = createId();
  const created = args.createdAt ?? ago(HOUR);
  testApp.db
    .insert(escalations)
    .values({
      id,
      projectId: args.projectId,
      kind: args.kind ?? "bug_report",
      status: args.status ?? "open",
      severity: null,
      title: "T",
      body: null,
      codeLocator: null,
      anchorType: null,
      anchorId: null,
      originRepo: "game_one",
      originWorkerKey: "worker-1",
      holderId: null,
      authorId: args.authorId,
      createdAt: created,
      updatedAt: created,
      resolvedAt: args.resolvedAt ?? null,
      resolvedBy: null,
      originLastSeenSeq: 0,
    })
    .run();
  return id;
}

let seqCounters = new Map<string, number>();

function seedMessage(
  testApp: TestApp,
  args: {
    escalationId: string;
    authorId: string;
    messageType?: string | null;
    createdAt: string;
  },
): void {
  const seq = (seqCounters.get(args.escalationId) ?? 0) + 1;
  seqCounters.set(args.escalationId, seq);
  testApp.db
    .insert(escalationMessages)
    .values({
      id: createId(),
      escalationId: args.escalationId,
      seq,
      authorId: args.authorId,
      body: "msg",
      messageType: args.messageType ?? null,
      metadata: null,
      createdAt: args.createdAt,
    })
    .run();
}

describe("escalation-metrics.service", () => {
  let testApp: TestApp;
  let projectId: string;
  let authorId: string; // the origin author
  let holderId: string; // a directed-reply author

  beforeEach(() => {
    testApp = createTestApp();
    seqCounters = new Map();
    const project = createTestProject(testApp.db);
    projectId = project.id;
    authorId = createTestUser(testApp.db, { type: "ai_agent" }).id;
    holderId = createTestUser(testApp.db, { type: "human" }).id;
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it("empty project → nulls/zeros, total 0", () => {
    const m = metrics.computeEscalationMetrics(projectId, NOW);
    expect(m.total).toBe(0);
    expect(m.timeToFirstResponse).toEqual({ p50Ms: null, p95Ms: null, sampleSize: 0 });
    expect(m.timeToResolve).toEqual({ p50Ms: null, p95Ms: null, sampleSize: 0 });
    expect(m.autoResolveRate).toEqual({ rate: null, answered: 0, total: 0 });
    expect(m.humanEscalationRate).toEqual({ rate: null, escalated: 0, total: 0 });
    expect(m.openBacklog).toEqual({ count: 0, oldestAgeMs: null });
    expect(m.byStatus).toEqual({
      open: 0,
      acknowledged: 0,
      answered: 0,
      resolved: 0,
      needsHuman: 0,
    });
    expect(m.byKind).toEqual({ bugReport: 0, question: 0, request: 0, blocked: 0 });
    expect(m.computedAt).toBe(NOW);
  });

  it("404s on unknown project", () => {
    expect(() => metrics.computeEscalationMetrics("nope", NOW)).toThrow(/not found/i);
  });

  it("time_to_first_response p50/p95 over the first directed reply; no-response excluded but in backlog", () => {
    // E1: created 1h ago, first directed reply 10m after creation → ttfr 10m.
    const e1 = seedEscalation(testApp, { projectId, authorId, createdAt: ago(HOUR) });
    // An origin-author message first (NOT a directed reply — must be skipped).
    seedMessage(testApp, { escalationId: e1, authorId, createdAt: ago(HOUR - 1 * MIN) });
    seedMessage(testApp, { escalationId: e1, authorId: holderId, createdAt: ago(HOUR - 10 * MIN) });
    // A later directed reply must NOT override the first.
    seedMessage(testApp, { escalationId: e1, authorId: holderId, createdAt: ago(HOUR - 30 * MIN) });

    // E2: first directed reply 30m after creation → ttfr 30m.
    const e2 = seedEscalation(testApp, { projectId, authorId, createdAt: ago(2 * HOUR) });
    seedMessage(testApp, {
      escalationId: e2,
      authorId: holderId,
      createdAt: ago(2 * HOUR - 30 * MIN),
    });

    // E3: NO directed reply (only an origin-author message) → excluded from
    // the ttfr sample, still counted in total/backlog.
    const e3 = seedEscalation(testApp, { projectId, authorId, status: "open" });
    seedMessage(testApp, { escalationId: e3, authorId, createdAt: ago(5 * MIN) });

    const m = metrics.computeEscalationMetrics(projectId, NOW);
    expect(m.timeToFirstResponse.sampleSize).toBe(2);
    // sorted [10m, 30m]: p50 → idx ceil(.5*2)-1=0 → 10m; p95 → idx 1 → 30m.
    expect(m.timeToFirstResponse.p50Ms).toBe(10 * MIN);
    expect(m.timeToFirstResponse.p95Ms).toBe(30 * MIN);
    expect(m.total).toBe(3);
    // E1, E2, E3 are all open → backlog count 3.
    expect(m.openBacklog.count).toBe(3);
  });

  it("time_to_resolve p50/p95 over resolved with resolvedAt", () => {
    seedEscalation(testApp, {
      projectId,
      authorId,
      status: "resolved",
      createdAt: ago(2 * HOUR),
      resolvedAt: ago(HOUR), // 1h to resolve
    });
    seedEscalation(testApp, {
      projectId,
      authorId,
      status: "resolved",
      createdAt: ago(3 * HOUR),
      resolvedAt: ago(HOUR), // 2h to resolve
    });
    // A non-resolved one is excluded from the resolve sample.
    seedEscalation(testApp, { projectId, authorId, status: "open" });

    const m = metrics.computeEscalationMetrics(projectId, NOW);
    expect(m.timeToResolve.sampleSize).toBe(2);
    expect(m.timeToResolve.p50Ms).toBe(HOUR);
    expect(m.timeToResolve.p95Ms).toBe(2 * HOUR);
  });

  it("auto_resolve_rate counts escalations with ≥1 diagnosis message", () => {
    const e1 = seedEscalation(testApp, { projectId, authorId });
    seedMessage(testApp, {
      escalationId: e1,
      authorId: holderId,
      messageType: "diagnosis",
      createdAt: ago(MIN),
    });
    // A reply-typed message does NOT count as answered.
    const e2 = seedEscalation(testApp, { projectId, authorId });
    seedMessage(testApp, {
      escalationId: e2,
      authorId: holderId,
      messageType: "reply",
      createdAt: ago(MIN),
    });
    // No message at all.
    seedEscalation(testApp, { projectId, authorId });

    const m = metrics.computeEscalationMetrics(projectId, NOW);
    expect(m.autoResolveRate.answered).toBe(1);
    expect(m.autoResolveRate.total).toBe(3);
    expect(m.autoResolveRate.rate).toBeCloseTo(1 / 3);
  });

  it("human_escalation_rate is the CURRENT needs_human share", () => {
    seedEscalation(testApp, { projectId, authorId, status: "needs_human" });
    seedEscalation(testApp, { projectId, authorId, status: "open" });
    seedEscalation(testApp, { projectId, authorId, status: "resolved", resolvedAt: ago(MIN) });

    const m = metrics.computeEscalationMetrics(projectId, NOW);
    expect(m.humanEscalationRate.escalated).toBe(1);
    expect(m.humanEscalationRate.total).toBe(3);
    expect(m.humanEscalationRate.rate).toBeCloseTo(1 / 3);
  });

  it("open_backlog count + oldest_age_ms (min createdAt of open)", () => {
    seedEscalation(testApp, { projectId, authorId, status: "open", createdAt: ago(3 * HOUR) });
    seedEscalation(testApp, { projectId, authorId, status: "open", createdAt: ago(HOUR) });
    // A resolved one does NOT contribute to the backlog age.
    seedEscalation(testApp, {
      projectId,
      authorId,
      status: "resolved",
      createdAt: ago(10 * HOUR),
      resolvedAt: ago(HOUR),
    });

    const m = metrics.computeEscalationMetrics(projectId, NOW);
    expect(m.openBacklog.count).toBe(2);
    expect(m.openBacklog.oldestAgeMs).toBe(3 * HOUR);
  });

  it("by_status / by_kind tallies", () => {
    seedEscalation(testApp, { projectId, authorId, status: "open", kind: "bug_report" });
    seedEscalation(testApp, { projectId, authorId, status: "acknowledged", kind: "question" });
    seedEscalation(testApp, { projectId, authorId, status: "answered", kind: "request" });
    seedEscalation(testApp, {
      projectId,
      authorId,
      status: "resolved",
      kind: "blocked",
      resolvedAt: ago(MIN),
    });
    seedEscalation(testApp, { projectId, authorId, status: "needs_human", kind: "bug_report" });

    const m = metrics.computeEscalationMetrics(projectId, NOW);
    expect(m.byStatus).toEqual({
      open: 1,
      acknowledged: 1,
      answered: 1,
      resolved: 1,
      needsHuman: 1,
    });
    expect(m.byKind).toEqual({ bugReport: 2, question: 1, request: 1, blocked: 1 });
    expect(m.total).toBe(5);
  });
});
