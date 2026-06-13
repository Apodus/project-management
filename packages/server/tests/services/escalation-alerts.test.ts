import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createId, ESCALATION_SLA_BREACH_THRESHOLD_MS } from "@pm/shared";
import { createTestApp, createTestProject, createTestUser, type TestApp } from "../utils.js";
import { escalations, escalationMessages, escalationAlertState } from "../../src/db/index.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";
import * as escalationMetrics from "../../src/services/escalation-metrics.service.js";

// ─── Escalation unanswered-SLA alert (Campaign C4 §P3) ────────────
//
// Mirrors notes-alerts.test.ts. The on-read computeEscalationMetrics fires the
// edge-triggered escalation.sla_breached once per breach episode (latched on
// escalation_alert_state.sla_notified, re-arms on clear). A breach = a
// NON-RESOLVED escalation with NO directed reply aged past the threshold —
// including an acknowledged-but-unanswered one (the FIX #2 case).

// Fixed reference "now" so ages are deterministic.
const NOW = "2026-06-13T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const MIN = 60_000;
const THRESHOLD = ESCALATION_SLA_BREACH_THRESHOLD_MS;

function ago(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

/**
 * Seed an escalation with a controllable createdAt + status. Returns its id.
 * Required NOT NULL columns: kind / title / originRepo / originWorkerKey /
 * authorId (status defaults to "open").
 */
function seedEscalation(
  testApp: TestApp,
  args: {
    projectId: string;
    authorId: string;
    createdAt: string;
    status?: string;
    resolvedAt?: string | null;
  },
): string {
  const id = createId();
  testApp.db
    .insert(escalations)
    .values({
      id,
      projectId: args.projectId,
      kind: "bug_report",
      status: (args.status ?? "open") as "open",
      title: "something is wrong",
      originRepo: "game_one",
      originWorkerKey: "worker-1",
      authorId: args.authorId,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
      resolvedAt: args.resolvedAt ?? null,
    })
    .run();
  return id;
}

/**
 * Append a directed reply (authorId != escalation author) to an escalation, so
 * the escalation is "answered" for SLA purposes (firstResponseSeen).
 */
function seedReply(
  testApp: TestApp,
  args: { escalationId: string; authorId: string; createdAt: string; seq?: number },
): void {
  testApp.db
    .insert(escalationMessages)
    .values({
      id: createId(),
      escalationId: args.escalationId,
      seq: args.seq ?? 1,
      authorId: args.authorId,
      body: "looking into it",
      createdAt: args.createdAt,
    })
    .run();
}

function readLatch(testApp: TestApp, projectId: string) {
  return testApp.db
    .select()
    .from(escalationAlertState)
    .where(eq(escalationAlertState.projectId, projectId))
    .get();
}

describe("escalation on-read unanswered-SLA alert (Campaign C4 §P3)", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── Fire once, latch, reset on clear (resolve), re-fire ────────────

  it("escalation.sla_breached fires ONCE, latches, resets on resolve, and re-fires", () => {
    const project = createTestProject(testApp.db);
    const author = createTestUser(testApp.db);

    const escId = seedEscalation(testApp, {
      projectId: project.id,
      authorId: author.id,
      createdAt: ago(THRESHOLD + 2 * MIN),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.ESCALATION_SLA_BREACHED, (p) => calls.push(p.entity));

    // First read → fires once + latches.
    escalationMetrics.computeEscalationMetrics(project.id, NOW);
    expect(calls).toHaveLength(1);
    expect(readLatch(testApp, project.id)?.slaNotified).toBe(true);

    // Second read while still breaching → latched, does NOT re-fire.
    escalationMetrics.computeEscalationMetrics(project.id, NOW);
    expect(calls).toHaveLength(1);

    // Resolve the escalation → no breach, latch resets, no fire.
    testApp.db
      .update(escalations)
      .set({ status: "resolved", resolvedAt: NOW })
      .where(eq(escalations.id, escId))
      .run();
    escalationMetrics.computeEscalationMetrics(project.id, NOW);
    expect(calls).toHaveLength(1);
    expect(readLatch(testApp, project.id)?.slaNotified).toBe(false);

    // Re-introduce a NEW breaching escalation → re-fires (edge re-arm).
    seedEscalation(testApp, {
      projectId: project.id,
      authorId: author.id,
      createdAt: ago(THRESHOLD + 2 * MIN),
    });
    escalationMetrics.computeEscalationMetrics(project.id, NOW);
    expect(calls).toHaveLength(2);
    expect(readLatch(testApp, project.id)?.slaNotified).toBe(true);
  });

  // ── Latch resets when the condition clears via a directed reply ────

  it("resets the latch when a breaching escalation gets a directed reply", () => {
    const project = createTestProject(testApp.db);
    const author = createTestUser(testApp.db);
    const responder = createTestUser(testApp.db);

    const escId = seedEscalation(testApp, {
      projectId: project.id,
      authorId: author.id,
      createdAt: ago(THRESHOLD + 2 * MIN),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.ESCALATION_SLA_BREACHED, (p) => calls.push(p.entity));

    escalationMetrics.computeEscalationMetrics(project.id, NOW);
    expect(calls).toHaveLength(1);
    expect(readLatch(testApp, project.id)?.slaNotified).toBe(true);

    // A directed reply lands → no longer unanswered → latch resets.
    seedReply(testApp, {
      escalationId: escId,
      authorId: responder.id,
      createdAt: ago(MIN),
    });
    escalationMetrics.computeEscalationMetrics(project.id, NOW);
    expect(calls).toHaveLength(1);
    expect(readLatch(testApp, project.id)?.slaNotified).toBe(false);
  });

  // ── No breaching escalation → no fire ──────────────────────────────

  it("does NOT fire when there are no escalations", () => {
    const project = createTestProject(testApp.db);

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.ESCALATION_SLA_BREACHED, (p) => calls.push(p.entity));

    escalationMetrics.computeEscalationMetrics(project.id, NOW);
    expect(calls).toHaveLength(0);
    expect(readLatch(testApp, project.id)?.slaNotified).toBe(false);
  });

  // ── Younger than threshold → no fire ───────────────────────────────

  it("does NOT fire for an escalation younger than the SLA threshold", () => {
    const project = createTestProject(testApp.db);
    const author = createTestUser(testApp.db);

    seedEscalation(testApp, {
      projectId: project.id,
      authorId: author.id,
      createdAt: ago(THRESHOLD - 2 * MIN),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.ESCALATION_SLA_BREACHED, (p) => calls.push(p.entity));

    escalationMetrics.computeEscalationMetrics(project.id, NOW);
    expect(calls).toHaveLength(0);
    expect(readLatch(testApp, project.id)?.slaNotified).toBe(false);
  });

  // ── Answered (old but has a directed reply) → no fire ──────────────

  it("does NOT fire for an old escalation that HAS a directed reply", () => {
    const project = createTestProject(testApp.db);
    const author = createTestUser(testApp.db);
    const responder = createTestUser(testApp.db);

    const escId = seedEscalation(testApp, {
      projectId: project.id,
      authorId: author.id,
      createdAt: ago(THRESHOLD + 10 * MIN),
    });
    // A directed reply exists → answered for SLA purposes.
    seedReply(testApp, {
      escalationId: escId,
      authorId: responder.id,
      createdAt: ago(THRESHOLD + 5 * MIN),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.ESCALATION_SLA_BREACHED, (p) => calls.push(p.entity));

    escalationMetrics.computeEscalationMetrics(project.id, NOW);
    expect(calls).toHaveLength(0);
    expect(readLatch(testApp, project.id)?.slaNotified).toBe(false);
  });

  // ── FIX #2: acknowledged-but-unanswered past threshold DOES breach ──

  it("DOES fire for an acknowledged-but-unanswered escalation past the threshold (FIX #2)", () => {
    const project = createTestProject(testApp.db);
    const author = createTestUser(testApp.db);

    // status "acknowledged" — never an "open" backlog row, but still unanswered.
    seedEscalation(testApp, {
      projectId: project.id,
      authorId: author.id,
      createdAt: ago(THRESHOLD + 5 * MIN),
      status: "acknowledged",
    });

    const calls: { breachCount?: unknown }[] = [];
    getEventBus().on(EVENT_NAMES.ESCALATION_SLA_BREACHED, (p) =>
      calls.push(p.entity as { breachCount?: unknown }),
    );

    escalationMetrics.computeEscalationMetrics(project.id, NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0].breachCount).toBe(1);
    expect(readLatch(testApp, project.id)?.slaNotified).toBe(true);
  });

  // ── Latch UPDATE touches ONLY the latch column ─────────────────────

  it("the latch UPDATE touches only sla_notified + updated_at", () => {
    const project = createTestProject(testApp.db);
    const author = createTestUser(testApp.db);
    seedEscalation(testApp, {
      projectId: project.id,
      authorId: author.id,
      createdAt: ago(THRESHOLD + 2 * MIN),
    });

    escalationMetrics.computeEscalationMetrics(project.id, NOW);
    const after = readLatch(testApp, project.id);
    expect(after).toBeDefined();
    expect(after!.slaNotified).toBe(true);
    // id + projectId + createdAt preserved (not clobbered) by the latch UPDATE.
    expect(after!.projectId).toBe(project.id);
    expect(after!.id).toBeTruthy();
    expect(after!.createdAt).toBeTruthy();
  });

  // ── Identity masking: payload carries NO escalation id ─────────────

  it("the emitted payload carries NO escalation id (identity-masked)", () => {
    const project = createTestProject(testApp.db);
    const author = createTestUser(testApp.db);
    const escId = seedEscalation(testApp, {
      projectId: project.id,
      authorId: author.id,
      createdAt: ago(THRESHOLD + 2 * MIN),
    });

    let captured: Record<string, unknown> | null = null;
    getEventBus().on(EVENT_NAMES.ESCALATION_SLA_BREACHED, (p) => {
      captured = p.entity as Record<string, unknown>;
    });

    escalationMetrics.computeEscalationMetrics(project.id, NOW);
    expect(captured).not.toBeNull();
    const payload = captured!;
    expect(payload.breachCount).toBe(1);
    expect(payload.projectId).toBe(project.id);
    // No escalation id leaks.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(escId);
    expect(Object.values(payload)).not.toContain(escId);
  });

  // ── Webhook-failure resilience (mirror the notes test) ─────────────

  it("computeEscalationMetrics returns normally even when the Discord POST rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const project = createTestProject(testApp.db, {
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
    });
    const author = createTestUser(testApp.db);
    const escId = seedEscalation(testApp, {
      projectId: project.id,
      authorId: author.id,
      createdAt: ago(THRESHOLD + 2 * MIN),
    });

    const metrics = escalationMetrics.computeEscalationMetrics(project.id, NOW);
    expect(metrics.total).toBe(1);
    await new Promise((r) => setImmediate(r));
    // The SLA alert tried to POST a masked message to Discord.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.content).toContain("Escalation SLA breach");
    // The masked message must NOT contain the escalation id.
    expect(body.content).not.toContain(escId);

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});
