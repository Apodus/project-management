import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createId, NOTES_BACKLOG_THRESHOLD_MS } from "@pm/shared";
import { createTestApp, createTestProject, createTestUser, type TestApp } from "../utils.js";
import { notes, triageDecisions } from "../../src/db/index.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";
import * as metrics from "../../src/services/triage-metrics.service.js";

// A fixed reference "now" so freshness / windowing is deterministic.
const NOW = "2026-06-20T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function ago(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

const HOUR = 3600_000;
const MIN = 60_000;

// ── Seed helpers ─────────────────────────────────────────────────

function seedNote(
  testApp: TestApp,
  args: { projectId: string; authorId: string; status?: string; createdAt?: string },
): string {
  const id = createId();
  const created = args.createdAt ?? ago(HOUR);
  testApp.db
    .insert(notes)
    .values({
      id,
      projectId: args.projectId,
      kind: "bug",
      status: args.status ?? "open",
      title: "n",
      body: null,
      anchorType: null,
      anchorId: null,
      codeLocator: null,
      severity: null,
      authorId: args.authorId,
      createdAt: created,
      updatedAt: created,
    })
    .run();
  return id;
}

function seedDecision(
  testApp: TestApp,
  args: {
    projectId: string;
    noteId: string;
    actorId: string;
    mode?: string;
    decision?: string;
    createdAt?: string;
  },
): string {
  const id = createId();
  const created = args.createdAt ?? ago(30 * MIN);
  testApp.db
    .insert(triageDecisions)
    .values({
      id,
      projectId: args.projectId,
      noteId: args.noteId,
      mode: args.mode ?? "shadow",
      decision: args.decision ?? "dismiss",
      rationale: null,
      confidence: null,
      resultingProposalId: null,
      resultingTaskId: null,
      actorId: args.actorId,
      createdAt: created,
    })
    .run();
  return id;
}

describe("triage-metrics.service", () => {
  let testApp: TestApp;
  let projectId: string;
  let agentId: string; // the designated triage agent
  let otherId: string; // a rogue/other actor

  beforeEach(() => {
    testApp = createTestApp();
    const project = createTestProject(testApp.db);
    projectId = project.id;
    agentId = createTestUser(testApp.db, { type: "ai_agent" }).id;
    otherId = createTestUser(testApp.db, { type: "human" }).id;
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it("404s on an unknown project", () => {
    expect(() => metrics.computeTriageMetrics("nope", { now: NOW })).toThrow(/not found/i);
  });

  it("empty project → zero matrix, null latency/heartbeat, lanes still computed", () => {
    const m = metrics.computeTriageMetrics(projectId, { now: NOW });
    expect(m.total).toBe(0);
    expect(m.decisionMix.shadow).toEqual({
      promote_standard: 0,
      promote_fast_track: 0,
      dismiss: 0,
      needs_human: 0,
      give_up: 0,
    });
    expect(m.decisionMix.on).toEqual({
      promote_standard: 0,
      promote_fast_track: 0,
      dismiss: 0,
      needs_human: 0,
      give_up: 0,
    });
    expect(m.decisionMix.total).toBe(0);
    expect(m.latency).toEqual({ p50Ms: null, p95Ms: null, sampleSize: 0 });
    expect(m.laneCounts).toEqual({ open: 0, needsHuman: 0, triaged: 0 });
    expect(m.heartbeat).toEqual({ lastDecisionAt: null, ageMs: null });
    expect(m.scope.filtered).toBe(false);
    expect(m.computedAt).toBe(NOW);
  });

  it("decision-mix counts by kind × mode over a zero-filled matrix + per-mode totals", () => {
    const note = seedNote(testApp, { projectId, authorId: agentId });
    seedDecision(testApp, {
      projectId,
      noteId: note,
      actorId: agentId,
      mode: "shadow",
      decision: "dismiss",
    });
    seedDecision(testApp, {
      projectId,
      noteId: note,
      actorId: agentId,
      mode: "shadow",
      decision: "dismiss",
    });
    seedDecision(testApp, {
      projectId,
      noteId: note,
      actorId: agentId,
      mode: "shadow",
      decision: "promote_standard",
    });
    seedDecision(testApp, {
      projectId,
      noteId: note,
      actorId: agentId,
      mode: "on",
      decision: "needs_human",
    });
    seedDecision(testApp, {
      projectId,
      noteId: note,
      actorId: agentId,
      mode: "on",
      decision: "give_up",
    });

    const m = metrics.computeTriageMetrics(projectId, { now: NOW });
    expect(m.decisionMix.shadow.dismiss).toBe(2);
    expect(m.decisionMix.shadow.promote_standard).toBe(1);
    expect(m.decisionMix.shadow.needs_human).toBe(0);
    expect(m.decisionMix.on.needs_human).toBe(1);
    expect(m.decisionMix.on.give_up).toBe(1);
    expect(m.decisionMix.shadowTotal).toBe(3);
    expect(m.decisionMix.onTotal).toBe(2);
    expect(m.decisionMix.total).toBe(5);
    expect(m.total).toBe(5);
  });

  // ── SCOPE (critical) ───────────────────────────────────────────

  it("triageAgentId set ⇒ other-actor rows excluded (works while enabled=false)", () => {
    const proj = createTestProject(testApp.db, {
      // enabled:false on purpose — scope must NOT depend on enabled.
      settings: { notesTriage: { enabled: false, mode: "shadow", triageAgentId: agentId } },
    });
    const note = seedNote(testApp, { projectId: proj.id, authorId: agentId });
    seedDecision(testApp, {
      projectId: proj.id,
      noteId: note,
      actorId: agentId,
      decision: "dismiss",
    });
    seedDecision(testApp, {
      projectId: proj.id,
      noteId: note,
      actorId: agentId,
      decision: "dismiss",
    });
    // A rogue/other actor row that must be EXCLUDED.
    seedDecision(testApp, {
      projectId: proj.id,
      noteId: note,
      actorId: otherId,
      decision: "promote_standard",
    });

    const m = metrics.computeTriageMetrics(proj.id, { now: NOW });
    expect(m.scope.triageAgentId).toBe(agentId);
    expect(m.scope.filtered).toBe(true);
    expect(m.scope.byActor).toEqual([]); // not surfaced when filtered
    expect(m.total).toBe(2); // only the agent's rows
    expect(m.decisionMix.shadow.dismiss).toBe(2);
    expect(m.decisionMix.shadow.promote_standard).toBe(0);
  });

  it("triageAgentId unset ⇒ all actors included + scope.byActor lists both", () => {
    const note = seedNote(testApp, { projectId, authorId: agentId });
    seedDecision(testApp, { projectId, noteId: note, actorId: agentId, decision: "dismiss" });
    seedDecision(testApp, { projectId, noteId: note, actorId: agentId, decision: "dismiss" });
    seedDecision(testApp, {
      projectId,
      noteId: note,
      actorId: otherId,
      decision: "promote_standard",
    });

    const m = metrics.computeTriageMetrics(projectId, { now: NOW });
    expect(m.scope.triageAgentId).toBeNull();
    expect(m.scope.filtered).toBe(false);
    expect(m.total).toBe(3);
    const byActor = Object.fromEntries(m.scope.byActor.map((a) => [a.actorId, a.count]));
    expect(byActor[agentId]).toBe(2);
    expect(byActor[otherId]).toBe(1);
    // byActor is sorted desc by count.
    expect(m.scope.byActor[0].actorId).toBe(agentId);
  });

  // ── latency ─────────────────────────────────────────────────────

  it("latency p50/p95 from note.createdAt → decision.createdAt (missing-note excluded)", () => {
    // Note A created 2h ago; decision 1h later → latency 1h.
    const a = seedNote(testApp, { projectId, authorId: agentId, createdAt: ago(2 * HOUR) });
    seedDecision(testApp, { projectId, noteId: a, actorId: agentId, createdAt: ago(HOUR) });
    // Note B created 3h ago; decision 30m later → latency 2.5h.
    const b = seedNote(testApp, { projectId, authorId: agentId, createdAt: ago(3 * HOUR) });
    seedDecision(testApp, { projectId, noteId: b, actorId: agentId, createdAt: ago(30 * MIN) });
    // Only the 2 resolvable notes contribute to the latency sample (the
    // missing-note guard is defensive — the FK makes an unresolvable noteId
    // impossible to seed normally).

    const m = metrics.computeTriageMetrics(projectId, { now: NOW });
    expect(m.latency.sampleSize).toBe(2);
    // sorted [1h, 2.5h]: p50 idx 0 → 1h; p95 idx 1 → 2.5h.
    expect(m.latency.p50Ms).toBe(HOUR);
    expect(m.latency.p95Ms).toBe(2.5 * HOUR);
  });

  // ── lane counts ─────────────────────────────────────────────────

  it("lane counts {open, needsHuman, triaged} project-wide (NOT agent-scoped)", () => {
    seedNote(testApp, { projectId, authorId: agentId, status: "open" });
    seedNote(testApp, { projectId, authorId: agentId, status: "open" });
    seedNote(testApp, { projectId, authorId: otherId, status: "needs_human" });
    seedNote(testApp, { projectId, authorId: otherId, status: "triaged" });
    seedNote(testApp, { projectId, authorId: otherId, status: "triaged" });
    seedNote(testApp, { projectId, authorId: otherId, status: "triaged" });

    const m = metrics.computeTriageMetrics(projectId, { now: NOW });
    expect(m.laneCounts).toEqual({ open: 2, needsHuman: 1, triaged: 3 });
  });

  // ── heartbeat ───────────────────────────────────────────────────

  it("heartbeat lastDecisionAt = newest scoped decision (null when none)", () => {
    const note = seedNote(testApp, { projectId, authorId: agentId });
    seedDecision(testApp, { projectId, noteId: note, actorId: agentId, createdAt: ago(2 * HOUR) });
    const newest = ago(15 * MIN);
    seedDecision(testApp, { projectId, noteId: note, actorId: agentId, createdAt: newest });

    const m = metrics.computeTriageMetrics(projectId, { now: NOW });
    expect(m.heartbeat.lastDecisionAt).toBe(newest);
    expect(m.heartbeat.ageMs).toBe(15 * MIN);
  });

  // ── windowing ───────────────────────────────────────────────────

  it("since excludes older rows from mix/latency/heartbeat but lane counts stay current", () => {
    const note = seedNote(testApp, { projectId, authorId: agentId, createdAt: ago(10 * HOUR) });
    // An OLD decision (5h ago) — excluded by the window.
    seedDecision(testApp, {
      projectId,
      noteId: note,
      actorId: agentId,
      createdAt: ago(5 * HOUR),
      decision: "dismiss",
    });
    // A RECENT decision (30m ago) — included.
    seedDecision(testApp, {
      projectId,
      noteId: note,
      actorId: agentId,
      createdAt: ago(30 * MIN),
      decision: "promote_standard",
    });
    // Lane counts: 1 open note regardless of the window.

    const since = ago(HOUR); // 1h window
    const m = metrics.computeTriageMetrics(projectId, { now: NOW, since });
    expect(m.windowSince).toBe(since);
    expect(m.total).toBe(1);
    expect(m.decisionMix.shadow.dismiss).toBe(0); // old one excluded
    expect(m.decisionMix.shadow.promote_standard).toBe(1);
    // heartbeat is the newest WITHIN the window.
    expect(m.heartbeat.lastDecisionAt).toBe(ago(30 * MIN));
    // lane counts are NOT windowed — the open note is still counted.
    expect(m.laneCounts.open).toBe(1);
  });

  // ── R3: the alert side effect can never 500 the metrics read ──────

  it("a throw in the backlog side-effect does NOT 500 the metrics read (R3 guard)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // An open note past the 7-day backlog threshold makes computeNotesHealth EMIT
    // NOTE_BACKLOG_ALERT (which it emits UNGUARDED) — a throwing listener thus
    // throws inside computeNotesHealth. The triage-metrics alert block must
    // swallow it (R3) and still return the metrics bundle.
    seedNote(testApp, {
      projectId,
      authorId: agentId,
      status: "open",
      createdAt: ago(NOTES_BACKLOG_THRESHOLD_MS + HOUR),
    });
    getEventBus().on(EVENT_NAMES.NOTE_BACKLOG_ALERT, () => {
      throw new Error("boom");
    });

    const m = metrics.computeTriageMetrics(projectId, { now: NOW });
    // The read still returns a well-formed bundle despite the side-effect throw.
    expect(m.laneCounts.open).toBe(1);
    expect(m.computedAt).toBe(NOW);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
