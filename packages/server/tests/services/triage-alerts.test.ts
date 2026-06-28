import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createId, TRIAGE_STALL_THRESHOLD_MS } from "@pm/shared";
import { createTestApp, createTestProject, createTestUser, type TestApp } from "../utils.js";
import { notes, notesAlertState, triageDecisions } from "../../src/db/index.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";
import * as triageMetrics from "../../src/services/triage-metrics.service.js";

// ─── T3·P4: triage.stalled ("triage not draining") alert ──────────
//
// The on-read, edge-triggered alert is a guarded side effect of
// computeTriageMetrics. It fires ONCE per stall episode (latched on
// notes_alert_state.triage_stalled_notified) when ALL hold:
//   a. resolved.enabled && resolved.mode === "on" (env-master ⊗ DB),
//   b. an OPEN note has aged past TRIAGE_STALL_THRESHOLD_MS,
//   c. NO scoped decision was recorded within that window.
// It must NOT fire in shadow / disabled / env-off — the anti-false-alarm cases.

// Fixed reference "now" so ages are deterministic.
const NOW = new Date("2026-06-20T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const NOW_ISO = NOW.toISOString();
const HOUR = 3600_000;
const STALL = TRIAGE_STALL_THRESHOLD_MS;

function ago(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

function seedNote(
  testApp: TestApp,
  args: { projectId: string; authorId: string; createdAt: string; status?: string },
): string {
  const id = createId();
  testApp.db
    .insert(notes)
    .values({
      id,
      projectId: args.projectId,
      kind: "bug",
      status: (args.status ?? "open") as "open",
      title: "a finding",
      authorId: args.authorId,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
    })
    .run();
  return id;
}

function seedDecision(
  testApp: TestApp,
  args: { projectId: string; noteId: string; actorId: string; createdAt: string },
): void {
  testApp.db
    .insert(triageDecisions)
    .values({
      id: createId(),
      projectId: args.projectId,
      noteId: args.noteId,
      mode: "on",
      decision: "dismiss",
      rationale: null,
      confidence: null,
      resultingProposalId: null,
      resultingTaskId: null,
      actorId: args.actorId,
      createdAt: args.createdAt,
    })
    .run();
}

function readLatch(testApp: TestApp, projectId: string) {
  return testApp.db
    .select()
    .from(notesAlertState)
    .where(eq(notesAlertState.projectId, projectId))
    .get();
}

/** On-mode settings with the triage agent designated (so heartbeat is scoped). */
function onSettings(agentId: string, extra?: Record<string, unknown>) {
  return {
    notesTriage: { enabled: true, mode: "on", triageAgentId: agentId },
    ...(extra ?? {}),
  };
}

describe("triage.stalled on-read alert (T3·P4)", () => {
  let testApp: TestApp;
  let envBefore: string | undefined;

  beforeEach(() => {
    testApp = createTestApp();
    envBefore = process.env.PM_NOTES_TRIAGE_ENABLED;
    // Default: master defers to DB (the production default — env unset).
    delete process.env.PM_NOTES_TRIAGE_ENABLED;
  });

  afterEach(() => {
    if (envBefore === undefined) delete process.env.PM_NOTES_TRIAGE_ENABLED;
    else process.env.PM_NOTES_TRIAGE_ENABLED = envBefore;
    testApp.cleanup();
  });

  // ── Fire once, latch, re-fire on re-arm ───────────────────────────

  it("fires ONCE on (on-mode + aging open backlog + no recent decision), latches", () => {
    const agent = createTestUser(testApp.db, { type: "ai_agent" });
    const project = createTestProject(testApp.db, { settings: onSettings(agent.id) });
    // An open note aged past the stall threshold (but well under the 7-day
    // backlog threshold — so ONLY triage.stalled is in play) + NO decisions.
    seedNote(testApp, { projectId: project.id, authorId: agent.id, createdAt: ago(STALL + HOUR) });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRIAGE_STALLED, (p) => calls.push(p.entity));

    triageMetrics.computeTriageMetrics(project.id, { now: NOW_ISO });
    expect(calls).toHaveLength(1);
    expect(readLatch(testApp, project.id)?.triageStalledNotified).toBe(true);

    // Latched — a second read while still stalled does NOT re-fire.
    triageMetrics.computeTriageMetrics(project.id, { now: NOW_ISO });
    expect(calls).toHaveLength(1);
  });

  it("clears + re-arms (a): backlog drains → latch resets → re-introduce re-fires", () => {
    const agent = createTestUser(testApp.db, { type: "ai_agent" });
    const project = createTestProject(testApp.db, { settings: onSettings(agent.id) });
    const noteId = seedNote(testApp, {
      projectId: project.id,
      authorId: agent.id,
      createdAt: ago(STALL + HOUR),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRIAGE_STALLED, (p) => calls.push(p.entity));

    triageMetrics.computeTriageMetrics(project.id, { now: NOW_ISO });
    expect(calls).toHaveLength(1);

    // Drain: triage the note → openCount 0 → no fire → latch resets.
    testApp.db.update(notes).set({ status: "triaged" }).where(eq(notes.id, noteId)).run();
    triageMetrics.computeTriageMetrics(project.id, { now: NOW_ISO });
    expect(calls).toHaveLength(1);
    expect(readLatch(testApp, project.id)?.triageStalledNotified).toBe(false);

    // Re-introduce a fresh aging open note → re-fires (edge re-arm).
    seedNote(testApp, { projectId: project.id, authorId: agent.id, createdAt: ago(STALL + HOUR) });
    triageMetrics.computeTriageMetrics(project.id, { now: NOW_ISO });
    expect(calls).toHaveLength(2);
    expect(readLatch(testApp, project.id)?.triageStalledNotified).toBe(true);
  });

  it("clears + re-arms (b): a fresh in-window decision resets the latch; ageing it out re-fires", () => {
    const agent = createTestUser(testApp.db, { type: "ai_agent" });
    const project = createTestProject(testApp.db, { settings: onSettings(agent.id) });
    const noteId = seedNote(testApp, {
      projectId: project.id,
      authorId: agent.id,
      createdAt: ago(STALL + 10 * HOUR),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRIAGE_STALLED, (p) => calls.push(p.entity));

    // Stalled → fires + latches.
    triageMetrics.computeTriageMetrics(project.id, { now: NOW_ISO });
    expect(calls).toHaveLength(1);

    // A fresh in-window decision (1h ago, by the scoped agent) → heartbeat fresh
    // → no fire → latch resets.
    seedDecision(testApp, {
      projectId: project.id,
      noteId,
      actorId: agent.id,
      createdAt: ago(HOUR),
    });
    triageMetrics.computeTriageMetrics(project.id, { now: NOW_ISO });
    expect(calls).toHaveLength(1);
    expect(readLatch(testApp, project.id)?.triageStalledNotified).toBe(false);

    // Advance "now" so that same decision has aged out of the window → re-fires.
    const later = new Date(NOW_MS + STALL + HOUR).toISOString();
    triageMetrics.computeTriageMetrics(project.id, { now: later });
    expect(calls).toHaveLength(2);
    expect(readLatch(testApp, project.id)?.triageStalledNotified).toBe(true);
  });

  // ── Anti-false-alarm: shadow / disabled / env-off ─────────────────

  it("does NOT fire in mode 'shadow' (even with aging open backlog + stale heartbeat)", () => {
    const agent = createTestUser(testApp.db, { type: "ai_agent" });
    const project = createTestProject(testApp.db, {
      settings: { notesTriage: { enabled: true, mode: "shadow", triageAgentId: agent.id } },
    });
    seedNote(testApp, { projectId: project.id, authorId: agent.id, createdAt: ago(STALL + HOUR) });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRIAGE_STALLED, (p) => calls.push(p.entity));

    triageMetrics.computeTriageMetrics(project.id, { now: NOW_ISO });
    expect(calls).toHaveLength(0);
    expect(readLatch(testApp, project.id)?.triageStalledNotified).toBe(false);
  });

  it("does NOT fire when disabled (enabled=false), even with mode 'on'", () => {
    const agent = createTestUser(testApp.db, { type: "ai_agent" });
    const project = createTestProject(testApp.db, {
      settings: { notesTriage: { enabled: false, mode: "on", triageAgentId: agent.id } },
    });
    seedNote(testApp, { projectId: project.id, authorId: agent.id, createdAt: ago(STALL + HOUR) });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRIAGE_STALLED, (p) => calls.push(p.entity));

    triageMetrics.computeTriageMetrics(project.id, { now: NOW_ISO });
    expect(calls).toHaveLength(0);
  });

  it("R1: does NOT fire when PM_NOTES_TRIAGE_ENABLED=false even with DB enabled+on", () => {
    process.env.PM_NOTES_TRIAGE_ENABLED = "false";
    const agent = createTestUser(testApp.db, { type: "ai_agent" });
    const project = createTestProject(testApp.db, { settings: onSettings(agent.id) });
    seedNote(testApp, { projectId: project.id, authorId: agent.id, createdAt: ago(STALL + HOUR) });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRIAGE_STALLED, (p) => calls.push(p.entity));

    triageMetrics.computeTriageMetrics(project.id, { now: NOW_ISO });
    expect(calls).toHaveLength(0);
    expect(readLatch(testApp, project.id)?.triageStalledNotified).toBe(false);
  });

  // ── Anti-false-alarm: empty / young backlog ───────────────────────

  it("does NOT fire on an empty backlog", () => {
    const agent = createTestUser(testApp.db, { type: "ai_agent" });
    const project = createTestProject(testApp.db, { settings: onSettings(agent.id) });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRIAGE_STALLED, (p) => calls.push(p.entity));

    triageMetrics.computeTriageMetrics(project.id, { now: NOW_ISO });
    expect(calls).toHaveLength(0);
  });

  it("does NOT fire on a YOUNG open backlog (oldest note within the stall window)", () => {
    const agent = createTestUser(testApp.db, { type: "ai_agent" });
    const project = createTestProject(testApp.db, { settings: onSettings(agent.id) });
    seedNote(testApp, { projectId: project.id, authorId: agent.id, createdAt: ago(STALL - HOUR) });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRIAGE_STALLED, (p) => calls.push(p.entity));

    triageMetrics.computeTriageMetrics(project.id, { now: NOW_ISO });
    expect(calls).toHaveLength(0);
  });

  it("does NOT fire when a recent (in-window) scoped decision exists", () => {
    const agent = createTestUser(testApp.db, { type: "ai_agent" });
    const project = createTestProject(testApp.db, { settings: onSettings(agent.id) });
    const noteId = seedNote(testApp, {
      projectId: project.id,
      authorId: agent.id,
      createdAt: ago(STALL + HOUR),
    });
    // A fresh decision by the scoped agent → heartbeat is fresh → not stalled.
    seedDecision(testApp, {
      projectId: project.id,
      noteId,
      actorId: agent.id,
      createdAt: ago(HOUR),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRIAGE_STALLED, (p) => calls.push(p.entity));

    triageMetrics.computeTriageMetrics(project.id, { now: NOW_ISO });
    expect(calls).toHaveLength(0);
  });

  // ── Identity masking ──────────────────────────────────────────────

  it("emits an identity-masked payload (aggregate only, NO note id)", () => {
    const agent = createTestUser(testApp.db, { type: "ai_agent" });
    const project = createTestProject(testApp.db, { settings: onSettings(agent.id) });
    const noteId = seedNote(testApp, {
      projectId: project.id,
      authorId: agent.id,
      createdAt: ago(STALL + HOUR),
    });

    let captured: Record<string, unknown> | null = null;
    getEventBus().on(EVENT_NAMES.TRIAGE_STALLED, (p) => {
      captured = p.entity as Record<string, unknown>;
    });

    triageMetrics.computeTriageMetrics(project.id, { now: NOW_ISO });
    expect(captured).not.toBeNull();
    const payload = captured!;
    expect(payload.projectId).toBe(project.id);
    expect(payload.openCount).toBe(1);
    // No note id leaks (neither as a value nor anywhere in the serialization).
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(noteId);
    expect(Object.values(payload)).not.toContain(noteId);
  });

  // ── Discord delivery (dual SSE + Discord) ─────────────────────────

  it("POSTs a masked Discord alert once when discord_url + alerts_enabled; a rejecting fetch never breaks the read", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const agent = createTestUser(testApp.db, { type: "ai_agent" });
    const project = createTestProject(testApp.db, {
      settings: onSettings(agent.id, {
        webhooks: { discord_url: "https://discord.com/api/webhooks/1/abc", alerts_enabled: true },
      }),
    });
    const noteId = seedNote(testApp, {
      projectId: project.id,
      authorId: agent.id,
      createdAt: ago(STALL + HOUR),
    });

    // The read returns normally despite the rejecting fetch.
    const m = triageMetrics.computeTriageMetrics(project.id, { now: NOW_ISO });
    expect(m.laneCounts.open).toBe(1);

    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.content).toContain("Triage not draining");
    expect(body.content).not.toContain(noteId);

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does NOT POST to Discord when alerts_enabled is false (SSE still emits)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const agent = createTestUser(testApp.db, { type: "ai_agent" });
    const project = createTestProject(testApp.db, {
      settings: onSettings(agent.id, {
        webhooks: { discord_url: "https://discord.com/api/webhooks/1/abc", alerts_enabled: false },
      }),
    });
    seedNote(testApp, { projectId: project.id, authorId: agent.id, createdAt: ago(STALL + HOUR) });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRIAGE_STALLED, (p) => calls.push(p.entity));

    triageMetrics.computeTriageMetrics(project.id, { now: NOW_ISO });
    await new Promise((r) => setImmediate(r));
    // SSE path still saw the event...
    expect(calls).toHaveLength(1);
    // ...but Discord delivery was gated off.
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
