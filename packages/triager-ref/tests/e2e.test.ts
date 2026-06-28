/**
 * Package integration seal (T2·P5). Wires the REAL `decide()` brain
 * (`createTriageDecide`) over a fake injection sniffer + fake assessment runner
 * (per-note scripted verdicts) and drives `triagerTick` against a fake client —
 * NO real `claude` process, NO real PM server. Asserts the full
 * seed → sniff → assess → execute path end-to-end across all decision kinds, the
 * proposal-gate, the spawn budget, no-recursion, and shadow-mode.
 *
 * The fakes are duplicated locally (the loop.test.ts harness is file-local, and
 * duplication is the established pattern in this repo).
 */
import { describe, it, expect, vi } from "vitest";
import { triagerTick, createTriagerState, type TriagerDeps } from "../src/loop.js";
import { createTriageDecide } from "../src/decide.js";
import { createFakeInjectionSniffer, type InjectionSniffResult } from "../src/injection-sniffer.js";
import { createFakeAssessmentRunner, type AssessmentResult } from "../src/assessment-runner.js";
import type { TriagerProjectView } from "../src/api-client.js";
import type { Note, ResolvedNotesTriage, TriageDecision } from "@pm/shared";
import type { Logger } from "../src/logger.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

function mkNote(id: string, over: Partial<Note> = {}): Note {
  return {
    id,
    projectId: "p",
    kind: "bug",
    status: "open",
    title: id,
    body: null,
    anchorType: null,
    anchorId: null,
    codeLocator: null,
    severity: null,
    authorId: "human",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    triagedAt: null,
    triagedBy: null,
    triageOutcome: null,
    triageReason: null,
    promotedProposalId: null,
    promotedTaskId: null,
    ...over,
  };
}

interface RecordedDecision {
  noteId: string;
  mode: string;
  decision: string;
  resultingProposalId: string | null;
}

class FakeClient {
  settings: TriagerProjectView["settings"];
  open: Note[];
  constructor(settings: TriagerProjectView["settings"], open: Note[]) {
    this.settings = settings;
    this.open = open;
  }

  getProject = vi.fn(
    async (projectId: string): Promise<TriagerProjectView> => ({
      id: projectId,
      settings: this.settings,
    }),
  );

  // The server consumes promoted/dismissed/flagged notes out of the open lane;
  // model that by dropping acted notes from `open` so a second tick re-lists only
  // what is still open.
  listOpenNotes = vi.fn(async (): Promise<Note[]> => this.open.slice());

  private consume(noteId: string): void {
    this.open = this.open.filter((n) => n.id !== noteId);
  }

  records: RecordedDecision[] = [];
  recordTriageDecision = vi.fn(
    async (
      _projectId: string,
      body: {
        noteId: string;
        mode: string;
        decision: string;
        resultingProposalId?: string | null;
      },
    ) => {
      this.records.push({
        noteId: body.noteId,
        mode: body.mode,
        decision: body.decision,
        resultingProposalId: body.resultingProposalId ?? null,
      });
      return { id: "td-1" } as unknown as TriageDecision;
    },
  );

  promoteToProposal = vi.fn(
    async (noteId: string, body: { proposalKind: "standard" | "fast_track" }) => {
      this.consume(noteId);
      return {
        note: mkNote(noteId, { status: "triaged" }),
        proposal: {
          id: `prop-${noteId}`,
          projectId: "p",
          title: "t",
          description: null,
          status: "draft",
          proposalKind: body.proposalKind,
          createdBy: "u-self",
          sourceNoteId: noteId,
          createdAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
        },
      };
    },
  );

  dismissNote = vi.fn(async (noteId: string): Promise<Note> => {
    this.consume(noteId);
    return mkNote(noteId, { status: "triaged" });
  });

  flagNeedsHuman = vi.fn(async (noteId: string): Promise<Note> => {
    this.consume(noteId);
    return mkNote(noteId, { status: "needs_human" });
  });

  claimProposal = vi.fn(async () => ({ ok: true, status: "claimed_by_you" }));

  implementProposal = vi.fn(async (): Promise<void> => undefined);
}

function mkDeps(
  client: FakeClient,
  decide: TriagerDeps["decide"],
  over: Partial<TriagerDeps> = {},
) {
  return {
    client,
    logger: silentLogger,
    projectIds: ["p"],
    selfId: "u-self",
    masterEnv: undefined,
    maxConcurrent: 5,
    spawnBudget: { maxSpawns: 100, windowSec: 3600 },
    decide,
    ...over,
  } satisfies TriagerDeps;
}

/** Build the REAL decide seam over scripted sniff + assessment verdicts. */
function realDecide(
  sniffById: Record<string, InjectionSniffResult>,
  assessById: Record<string, AssessmentResult>,
  runnerCalls: string[],
) {
  const sniffer = createFakeInjectionSniffer(
    (input) => sniffById[input.note.id] ?? { kind: "clean" },
  );
  const runner = createFakeAssessmentRunner((input) => {
    runnerCalls.push(input.note.id);
    const verdict = assessById[input.note.id];
    if (!verdict) throw new Error(`no scripted assessment for ${input.note.id}`);
    return verdict;
  });
  return createTriageDecide({
    sniffer,
    runner,
    logsDir: "/tmp/ignored-by-fakes",
    command: "claude -p",
    budget: { timeBudgetSec: 1 },
    logger: silentLogger,
  });
}

describe("triager e2e seal — on-mode across all decision kinds", () => {
  it("drives promote_standard / promote_fast_track / dismiss / suspicious→needs_human / needs_human", async () => {
    const notes = [
      mkNote("n1", { createdAt: "2026-06-01T00:00:00.000Z" }),
      mkNote("n2", { createdAt: "2026-06-02T00:00:00.000Z" }),
      mkNote("n3", { createdAt: "2026-06-03T00:00:00.000Z" }),
      mkNote("n4", { createdAt: "2026-06-04T00:00:00.000Z" }),
      mkNote("n5", { createdAt: "2026-06-05T00:00:00.000Z" }),
    ];
    const client = new FakeClient({ notesTriage: { enabled: true, mode: "on" } }, notes);

    const runnerCalls: string[] = [];
    const decide = realDecide(
      { n4: { kind: "suspicious", reason: "injection" } },
      {
        n1: { kind: "promote_standard", rationale: "real bug", confidence: 0.9 },
        n2: {
          kind: "promote_fast_track",
          rationale: "small + clear",
          confidence: 0.95,
          breakdown: { epics: [{ title: "E1" }], tasks: [{ title: "T1" }, { title: "T2" }] },
        },
        n3: { kind: "dismiss", rationale: "noise", confidence: 0.8 },
        n5: { kind: "needs_human", rationale: "ambiguous", confidence: 0.2 },
      },
      runnerCalls,
    );

    const state = createTriagerState();
    await triagerTick(mkDeps(client, decide), state);

    // n1 → promote_standard
    expect(client.promoteToProposal).toHaveBeenCalledWith("n1", { proposalKind: "standard" });

    // n2 → promote_fast_track → claim → implement (proposal-gate: tasks ONLY here).
    expect(client.promoteToProposal).toHaveBeenCalledWith("n2", { proposalKind: "fast_track" });
    expect(client.claimProposal).toHaveBeenCalledWith("prop-n2");
    expect(client.implementProposal).toHaveBeenCalledWith("prop-n2", {
      epics: [{ name: "E1", description: undefined }],
      tasks: [
        { title: "T1", description: undefined },
        { title: "T2", description: undefined },
      ],
    });
    // The ONLY task-minting path is implementProposal — there is no direct
    // note→task client method.
    expect("createTask" in client).toBe(false);
    expect(client.implementProposal).toHaveBeenCalledTimes(1);

    // n3 → dismiss
    expect(client.dismissNote).toHaveBeenCalledWith("n3", "noise");

    // n4 → suspicious sniff short-circuits to needs_human; runner NEVER invoked.
    expect(runnerCalls).not.toContain("n4");
    expect(client.flagNeedsHuman).toHaveBeenCalledWith("n4");

    // n5 → needs_human
    expect(client.flagNeedsHuman).toHaveBeenCalledWith("n5");

    // Every disposition recorded under mode "on" with the truthful decision kind.
    const byNote = Object.fromEntries(client.records.map((r) => [r.noteId, r]));
    expect(byNote.n1).toMatchObject({
      mode: "on",
      decision: "promote_standard",
      resultingProposalId: "prop-n1",
    });
    expect(byNote.n2).toMatchObject({
      mode: "on",
      decision: "promote_fast_track",
      resultingProposalId: "prop-n2",
    });
    expect(byNote.n3).toMatchObject({ mode: "on", decision: "dismiss" });
    expect(byNote.n4).toMatchObject({ mode: "on", decision: "needs_human" });
    expect(byNote.n5).toMatchObject({ mode: "on", decision: "needs_human" });

    // No-recursion: a second tick re-lists only still-open notes (all consumed) →
    // nothing re-decides; no note-authoring method exists or was called.
    const recordsAfterTick1 = client.records.length;
    await triagerTick(mkDeps(client, decide), state);
    expect(client.records.length).toBe(recordsAfterTick1);
    expect("createNote" in client).toBe(false);
  });

  it("spawn budget composes: maxSpawns=3 acts on only 3 of 5 this tick; the rest re-seed next tick", async () => {
    const notes = [
      mkNote("n1", { createdAt: "2026-06-01T00:00:00.000Z" }),
      mkNote("n2", { createdAt: "2026-06-02T00:00:00.000Z" }),
      mkNote("n3", { createdAt: "2026-06-03T00:00:00.000Z" }),
      mkNote("n4", { createdAt: "2026-06-04T00:00:00.000Z" }),
      mkNote("n5", { createdAt: "2026-06-05T00:00:00.000Z" }),
    ];
    const client = new FakeClient({ notesTriage: { enabled: true, mode: "on" } }, notes);
    const runnerCalls: string[] = [];
    const decide = realDecide(
      {},
      {
        n1: { kind: "dismiss", rationale: "x", confidence: 1 },
        n2: { kind: "dismiss", rationale: "x", confidence: 1 },
        n3: { kind: "dismiss", rationale: "x", confidence: 1 },
        n4: { kind: "dismiss", rationale: "x", confidence: 1 },
        n5: { kind: "dismiss", rationale: "x", confidence: 1 },
      },
      runnerCalls,
    );
    const state = createTriagerState();
    let now = 1_000_000;
    await triagerTick(
      mkDeps(client, decide, { spawnBudget: { maxSpawns: 3, windowSec: 3600 }, now: () => now }),
      state,
    );
    // Oldest-first: n1,n2,n3 acted this tick; n4,n5 deferred (budget spent).
    expect(client.records.map((r) => r.noteId)).toEqual(["n1", "n2", "n3"]);

    // Next tick after the window elapses → the deferred re-seed and act.
    now += 4_000_000;
    await triagerTick(
      mkDeps(client, decide, { spawnBudget: { maxSpawns: 3, windowSec: 3600 }, now: () => now }),
      state,
    );
    expect(client.records.map((r) => r.noteId).sort()).toEqual(["n1", "n2", "n3", "n4", "n5"]);
  });
});

describe("triager e2e seal — shadow-mode is record-only", () => {
  it("records mode=shadow for every kind, mutates nothing, and does not re-decide next tick", async () => {
    const notes = [
      mkNote("s1", { createdAt: "2026-06-01T00:00:00.000Z" }),
      mkNote("s2", { createdAt: "2026-06-02T00:00:00.000Z" }),
      mkNote("s3", { createdAt: "2026-06-03T00:00:00.000Z" }),
    ];
    const client = new FakeClient({ notesTriage: { enabled: true, mode: "shadow" } }, notes);
    const runnerCalls: string[] = [];
    const decide = realDecide(
      {},
      {
        s1: { kind: "promote_standard", rationale: "x", confidence: 1 },
        s2: { kind: "dismiss", rationale: "x", confidence: 1 },
        s3: { kind: "needs_human", rationale: "x", confidence: 1 },
      },
      runnerCalls,
    );
    const state = createTriagerState();
    await triagerTick(mkDeps(client, decide), state);

    // Every decision recorded under shadow; truthful kinds.
    expect(client.records.map((r) => `${r.noteId}:${r.mode}:${r.decision}`).sort()).toEqual([
      "s1:shadow:promote_standard",
      "s2:shadow:dismiss",
      "s3:shadow:needs_human",
    ]);
    // No action wrapper touched — notes stay open.
    expect(client.promoteToProposal).not.toHaveBeenCalled();
    expect(client.dismissNote).not.toHaveBeenCalled();
    expect(client.flagNeedsHuman).not.toHaveBeenCalled();
    expect(client.claimProposal).not.toHaveBeenCalled();
    expect(client.implementProposal).not.toHaveBeenCalled();
    // Tracked as shadowSeen, NOT triaged.
    expect(state.shadowSeen.size).toBe(3);
    expect(state.triaged.size).toBe(0);

    // Second tick: shadow-seen notes are suppressed from re-seed → no re-decide.
    const recordsAfterTick1 = client.records.length;
    await triagerTick(mkDeps(client, decide), state);
    expect(client.records.length).toBe(recordsAfterTick1);
  });
});
