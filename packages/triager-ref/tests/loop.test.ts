import { describe, it, expect, vi } from "vitest";
import {
  triagerTick,
  runTriagerLoop,
  createTriagerState,
  seedNotes,
  canSpawn,
  recordSpawn,
  type TriagerDeps,
  type DecideFn,
} from "../src/loop.js";
import { PmApiError, type TriagerProjectView } from "../src/api-client.js";
import type { Note, ResolvedNotesTriage, TriageDecision } from "@pm/shared";
import type { TriageAssessment } from "../src/decision.js";
import type { Logger } from "../src/logger.js";

// ── Fakes ──────────────────────────────────────────────────────────

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const SELF = "u-self";

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

class FakeClient {
  settingsByProject: Record<string, TriagerProjectView["settings"]> = {};
  getProjectError: ((projectId: string) => unknown) | undefined;
  getProject = vi.fn(async (projectId: string): Promise<TriagerProjectView> => {
    const err = this.getProjectError?.(projectId);
    if (err) throw err;
    return { id: projectId, settings: this.settingsByProject[projectId] ?? null };
  });

  notesByProject: Record<string, Note[]> = {};
  listError: ((projectId: string) => unknown) | undefined;
  listOpenNotes = vi.fn(async (projectId: string): Promise<Note[]> => {
    const err = this.listError?.(projectId);
    if (err) throw err;
    return this.notesByProject[projectId] ?? [];
  });

  // ── P4 action surface. recordTriageDecision is now a recording spy (the
  // executor calls it under shadow + on). Each action wrapper is configurable to
  // throw via the `*Error` hooks so the loop integration tests can exercise the
  // transient-retry path. ──
  recordTriageDecision = vi.fn(async () => ({ id: "td-1" }) as unknown as TriageDecision);

  promoteToProposal = vi.fn(async (noteId: string) => ({
    note: mkNote(noteId, { status: "triaged" }),
    proposal: {
      id: "prop-1",
      projectId: "p",
      title: "t",
      description: null,
      status: "draft",
      proposalKind: "standard" as const,
      createdBy: "u-self",
      sourceNoteId: noteId,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
  }));

  dismissError: (() => unknown) | undefined;
  dismissNote = vi.fn(async (noteId: string): Promise<Note> => {
    const err = this.dismissError?.();
    if (err) throw err;
    return mkNote(noteId, { status: "triaged" });
  });

  flagError: (() => unknown) | undefined;
  flagNeedsHuman = vi.fn(async (noteId: string): Promise<Note> => {
    const err = this.flagError?.();
    if (err) throw err;
    return mkNote(noteId, { status: "needs_human" });
  });

  claimProposal = vi.fn(async () => ({ ok: true, status: "claimed_by_you" }));

  implementProposal = vi.fn(async (): Promise<void> => undefined);
}

function spyDecide(
  impl?: (ctx: { note: Note; projectId: string; resolved: ResolvedNotesTriage }) => Promise<void>,
  assessment: TriageAssessment = { kind: "give_up", rationale: "", confidence: 0 },
): DecideFn {
  return vi.fn(async (ctx) => {
    if (impl) await impl(ctx);
    return assessment;
  });
}

function mkDeps(
  client: FakeClient,
  decide: DecideFn,
  over: Partial<TriagerDeps> = {},
): TriagerDeps {
  return {
    client,
    logger: silentLogger,
    projectIds: ["p"],
    selfId: SELF,
    masterEnv: undefined,
    maxConcurrent: 1,
    spawnBudget: { maxSpawns: 10, windowSec: 3600 },
    decide,
    ...over,
  };
}

// ── seedNotes (pure) ────────────────────────────────────────────────

describe("seedNotes", () => {
  it("excludes self-authored / triage-agent-authored / non-open / inFlight / triaged, oldest-first", () => {
    const resolved: ResolvedNotesTriage = { enabled: true, mode: "on", triageAgentId: "agent-x" };
    const state = createTriagerState();
    state.inFlight.add("inflight");
    state.triaged.add("done");
    const notes = [
      mkNote("newest", { createdAt: "2026-06-25T00:00:00.000Z" }),
      mkNote("oldest", { createdAt: "2026-06-01T00:00:00.000Z" }),
      mkNote("mid", { createdAt: "2026-06-10T00:00:00.000Z" }),
      mkNote("self", { authorId: SELF }),
      mkNote("byagent", { authorId: "agent-x" }),
      mkNote("needshuman", { status: "needs_human" }),
      mkNote("inflight"),
      mkNote("done"),
    ];
    const out = seedNotes(notes, SELF, resolved, state);
    expect(out.map((n) => n.id)).toEqual(["oldest", "mid", "newest"]);
  });

  it("a null triageAgentId admits notes regardless of author (except self)", () => {
    const resolved: ResolvedNotesTriage = { enabled: true, mode: "shadow" };
    const out = seedNotes(
      [mkNote("a", { authorId: "someone" }), mkNote("b", { authorId: SELF })],
      SELF,
      resolved,
      createTriagerState(),
    );
    expect(out.map((n) => n.id)).toEqual(["a"]);
  });
});

// ── triagerTick ─────────────────────────────────────────────────────

describe("triagerTick", () => {
  it("a disabled project does no work (decide not called)", async () => {
    const client = new FakeClient();
    client.settingsByProject["p"] = { notesTriage: { enabled: false } };
    client.notesByProject["p"] = [mkNote("n1")];
    const decide = spyDecide();
    await triagerTick(mkDeps(client, decide), createTriagerState());
    expect(decide).not.toHaveBeenCalled();
  });

  it("an absent settings block resolves OFF (decide not called)", async () => {
    const client = new FakeClient();
    client.notesByProject["p"] = [mkNote("n1")];
    const decide = spyDecide();
    await triagerTick(mkDeps(client, decide), createTriagerState());
    expect(decide).not.toHaveBeenCalled();
  });

  it.each(["on", "shadow"] as const)(
    "%s-mode: decide is called once per seeded note with the resolved mode threaded",
    async (mode) => {
      const client = new FakeClient();
      client.settingsByProject["p"] = { notesTriage: { enabled: true, mode } };
      client.notesByProject["p"] = [
        mkNote("n1", { createdAt: "2026-06-01T00:00:00.000Z" }),
        mkNote("n2", { createdAt: "2026-06-02T00:00:00.000Z" }),
      ];
      const seenModes: string[] = [];
      const seenIds: string[] = [];
      const decide = spyDecide(async ({ note, resolved }) => {
        seenModes.push(resolved.mode);
        seenIds.push(note.id);
      });
      await triagerTick(mkDeps(client, decide, { maxConcurrent: 5 }), createTriagerState());
      expect(decide).toHaveBeenCalledTimes(2);
      expect(seenIds).toEqual(["n1", "n2"]); // oldest-first
      expect(seenModes).toEqual([mode, mode]);
    },
  );

  it("master force-off (PM_NOTES_TRIAGE_ENABLED=false) overrides a DB-enabled project", async () => {
    const client = new FakeClient();
    client.settingsByProject["p"] = { notesTriage: { enabled: true, mode: "on" } };
    client.notesByProject["p"] = [mkNote("n1")];
    const decide = spyDecide();
    await triagerTick(mkDeps(client, decide, { masterEnv: "false" }), createTriagerState());
    expect(decide).not.toHaveBeenCalled();
  });

  it("getProject throw fail-safes the project OFF; other projects still processed", async () => {
    const client = new FakeClient();
    client.getProjectError = (id) => (id === "p1" ? new Error("boom") : undefined);
    client.settingsByProject["p2"] = { notesTriage: { enabled: true, mode: "on" } };
    client.notesByProject["p1"] = [mkNote("a")];
    client.notesByProject["p2"] = [mkNote("b")];
    const seen: string[] = [];
    const decide = spyDecide(async ({ note }) => {
      seen.push(note.id);
    });
    await triagerTick(
      mkDeps(client, decide, { projectIds: ["p1", "p2"], maxConcurrent: 5 }),
      createTriagerState(),
    );
    expect(seen).toEqual(["b"]);
  });

  it("respects maxConcurrent=1: at most one decide in flight, only one admitted per tick", async () => {
    const client = new FakeClient();
    client.settingsByProject["p"] = { notesTriage: { enabled: true, mode: "on" } };
    client.notesByProject["p"] = [
      mkNote("n1", { createdAt: "2026-06-01T00:00:00.000Z" }),
      mkNote("n2", { createdAt: "2026-06-02T00:00:00.000Z" }),
      mkNote("n3", { createdAt: "2026-06-03T00:00:00.000Z" }),
    ];
    let inFlight = 0;
    let maxObserved = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const decide = spyDecide(async () => {
      inFlight += 1;
      maxObserved = Math.max(maxObserved, inFlight);
      await gate;
      inFlight -= 1;
    });
    const tick = triagerTick(mkDeps(client, decide, { maxConcurrent: 1 }), createTriagerState());
    // Let the admitted job start before releasing the gate.
    await Promise.resolve();
    await Promise.resolve();
    release();
    await tick;
    expect(maxObserved).toBe(1);
    expect(decide).toHaveBeenCalledTimes(1); // semaphore admits only one this tick
  });

  it("shadow tick: records mode=shadow, mutates NOTHING, marks shadowSeen (not triaged); a second tick does not re-decide", async () => {
    const client = new FakeClient();
    client.settingsByProject["p"] = { notesTriage: { enabled: true, mode: "shadow" } };
    client.notesByProject["p"] = [mkNote("n1")];
    const decide = spyDecide(async () => {});
    const state = createTriagerState();
    await triagerTick(mkDeps(client, decide, { maxConcurrent: 5 }), state);
    // Recorded under shadow.
    expect(client.recordTriageDecision).toHaveBeenCalledTimes(1);
    expect(client.recordTriageDecision.mock.calls[0][1]).toMatchObject({ mode: "shadow" });
    // No action wrapper touched (note stays open).
    expect(client.dismissNote).not.toHaveBeenCalled();
    expect(client.promoteToProposal).not.toHaveBeenCalled();
    expect(client.flagNeedsHuman).not.toHaveBeenCalled();
    // Tracked as shadowSeen, NOT triaged.
    expect(state.shadowSeen.has("n1")).toBe(true);
    expect(state.triaged.has("n1")).toBe(false);
    // A second tick: the shadow-seen note is suppressed from re-seed.
    await triagerTick(mkDeps(client, decide, { maxConcurrent: 5 }), state);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(client.recordTriageDecision).toHaveBeenCalledTimes(1);
  });

  it("on tick: performs the action + records mode=on + marks triaged", async () => {
    const client = new FakeClient();
    client.settingsByProject["p"] = { notesTriage: { enabled: true, mode: "on" } };
    client.notesByProject["p"] = [mkNote("n1")];
    const decide = spyDecide(async () => {}, {
      kind: "dismiss",
      rationale: "noise",
      confidence: 1,
    });
    const state = createTriagerState();
    await triagerTick(mkDeps(client, decide, { maxConcurrent: 5 }), state);
    expect(client.dismissNote).toHaveBeenCalledWith("n1", "noise");
    expect(client.recordTriageDecision.mock.calls[0][1]).toMatchObject({
      mode: "on",
      decision: "dismiss",
    });
    expect(state.triaged.has("n1")).toBe(true);
    expect(state.shadowSeen.has("n1")).toBe(false);
  });

  it("on tick transient throw: note NOT marked (re-seedable), inFlight cleared", async () => {
    const client = new FakeClient();
    client.settingsByProject["p"] = { notesTriage: { enabled: true, mode: "on" } };
    client.notesByProject["p"] = [mkNote("n1")];
    client.dismissError = () => new PmApiError(500, "X", "boom"); // transient
    const decide = spyDecide(async () => {}, {
      kind: "dismiss",
      rationale: "noise",
      confidence: 1,
    });
    const state = createTriagerState();
    await expect(
      triagerTick(mkDeps(client, decide, { maxConcurrent: 5 }), state),
    ).resolves.toBeUndefined();
    expect(client.recordTriageDecision).not.toHaveBeenCalled();
    expect(state.triaged.size).toBe(0);
    expect(state.shadowSeen.size).toBe(0);
    expect(state.inFlight.size).toBe(0);
  });

  it("on-mode identity mismatch warns once per project", async () => {
    const client = new FakeClient();
    client.settingsByProject["p"] = {
      notesTriage: { enabled: true, mode: "on", triageAgentId: "other-agent" },
    };
    client.notesByProject["p"] = [mkNote("n1")];
    const warn = vi.fn();
    const logger = { ...silentLogger, warn } as unknown as Logger;
    const decide = spyDecide(async () => {}, { kind: "give_up", rationale: "", confidence: 0 });
    const state = createTriagerState();
    await triagerTick(mkDeps(client, decide, { maxConcurrent: 5, logger }), state);
    await triagerTick(mkDeps(client, decide, { maxConcurrent: 5, logger }), state);
    const mismatchWarns = warn.mock.calls.filter((c) =>
      String(c[1] ?? "").includes("is not project"),
    );
    expect(mismatchWarns).toHaveLength(1);
  });

  it("survives a per-project listOpenNotes throw (no throw; other projects processed)", async () => {
    const client = new FakeClient();
    client.settingsByProject["p1"] = { notesTriage: { enabled: true, mode: "on" } };
    client.settingsByProject["p2"] = { notesTriage: { enabled: true, mode: "on" } };
    client.listError = (id) => (id === "p1" ? new Error("list boom") : undefined);
    client.notesByProject["p2"] = [mkNote("b")];
    const seen: string[] = [];
    const decide = spyDecide(async ({ note }) => {
      seen.push(note.id);
    });
    await expect(
      triagerTick(
        mkDeps(client, decide, { projectIds: ["p1", "p2"], maxConcurrent: 5 }),
        createTriagerState(),
      ),
    ).resolves.toBeUndefined();
    expect(seen).toEqual(["b"]);
  });

  it("a decide rejection is swallowed (note re-seedable; tick resolves)", async () => {
    const client = new FakeClient();
    client.settingsByProject["p"] = { notesTriage: { enabled: true, mode: "on" } };
    client.notesByProject["p"] = [mkNote("n1")];
    const decide = vi.fn(async () => {
      throw new Error("decide boom");
    }) as unknown as DecideFn;
    const state = createTriagerState();
    await expect(
      triagerTick(mkDeps(client, decide, { maxConcurrent: 5 }), state),
    ).resolves.toBeUndefined();
    // inFlight cleared in finally — the note is re-seedable next tick.
    expect(state.inFlight.size).toBe(0);
    expect(state.triaged.size).toBe(0);
  });
});

// ── canSpawn / recordSpawn (pure, T2·P5 Seal 3) ─────────────────────

describe("canSpawn / recordSpawn (pure)", () => {
  it("prunes timestamps outside (now-windowSec*1000, now] in place and gates strict-< maxSpawns", () => {
    const state = createTriagerState();
    const budget = { maxSpawns: 3, windowSec: 100 };
    const now = 1_000_000;
    state.spawnTimestamps.push(now - 200_000, now - 50_000, now - 10_000); // 1 stale, 2 in-window
    expect(canSpawn(state, budget, now)).toBe(true); // 2 in-window < 3
    expect(state.spawnTimestamps).toEqual([now - 50_000, now - 10_000]); // stale dropped IN PLACE
  });

  it("returns false at the cap, true again after a stale entry ages out", () => {
    const state = createTriagerState();
    const budget = { maxSpawns: 2, windowSec: 100 };
    const now = 1_000_000;
    state.spawnTimestamps.push(now - 90_000, now - 5_000);
    expect(canSpawn(state, budget, now)).toBe(false); // 2 in-window, not < 2
    const later = now + 15_000; // (now-90000) now ages past the 100s window
    expect(canSpawn(state, budget, later)).toBe(true);
    expect(state.spawnTimestamps).toEqual([now - 5_000]);
  });

  it("recordSpawn pushes now", () => {
    const state = createTriagerState();
    recordSpawn(state, 42);
    expect(state.spawnTimestamps).toEqual([42]);
  });
});

// ── spawn-rate budget — triagerTick (T2·P5 Seal 3) ──────────────────

describe("spawn-rate budget — triagerTick", () => {
  function mkBudgetClient(n: number): FakeClient {
    const client = new FakeClient();
    client.settingsByProject["p"] = { notesTriage: { enabled: true, mode: "on" } };
    client.notesByProject["p"] = Array.from({ length: n }, (_, i) =>
      mkNote(`n${i + 1}`, { createdAt: `2026-06-0${i + 1}T00:00:00.000Z` }),
    );
    return client;
  }

  it("caps real spawns at maxSpawns this tick; deferred notes are NOT marked (re-seedable)", async () => {
    const client = mkBudgetClient(4);
    const decide = spyDecide(async () => {});
    const state = createTriagerState();
    await triagerTick(
      mkDeps(client, decide, {
        maxConcurrent: 10,
        spawnBudget: { maxSpawns: 2, windowSec: 3600 },
        now: () => 1_000_000,
      }),
      state,
    );
    expect(decide).toHaveBeenCalledTimes(2);
    expect(state.spawnTimestamps.length).toBe(2);
    expect(state.triaged.size).toBe(2); // the 2 acted notes
    expect(state.shadowSeen.size).toBe(0);
  });

  it("a same-now second tick defers again; advancing past the window admits the deferred", async () => {
    const client = mkBudgetClient(3);
    const decide = spyDecide(async () => {});
    const state = createTriagerState();
    let now = 1_000_000;
    const deps = (): TriagerDeps =>
      mkDeps(client, decide, {
        maxConcurrent: 10,
        spawnBudget: { maxSpawns: 1, windowSec: 100 },
        now: () => now,
      });

    await triagerTick(deps(), state); // n1 spawns; n2/n3 deferred (budget spent)
    expect(decide).toHaveBeenCalledTimes(1);
    expect(state.spawnTimestamps.length).toBe(1);

    await triagerTick(deps(), state); // same now, budget spent → no new spawn
    expect(decide).toHaveBeenCalledTimes(1);

    now += 50_000; // still inside the 100s window
    await triagerTick(deps(), state);
    expect(decide).toHaveBeenCalledTimes(1);

    now += 100_000; // window elapsed → a deferred note admits
    await triagerTick(deps(), state);
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it("a window pre-filled to the cap defers everything this tick (decide not called)", async () => {
    const client = mkBudgetClient(2);
    const decide = spyDecide(async () => {});
    const state = createTriagerState();
    const now = 1_000_000;
    state.spawnTimestamps.push(now - 1_000, now - 2_000); // 2 in-window = cap
    await triagerTick(
      mkDeps(client, decide, {
        maxConcurrent: 10,
        spawnBudget: { maxSpawns: 2, windowSec: 100 },
        now: () => now,
      }),
      state,
    );
    expect(decide).not.toHaveBeenCalled();
  });
});

// ── no-recursion (T2·P5 Seal 1) ─────────────────────────────────────

describe("no-recursion (T2·P5 seal)", () => {
  it("seedNotes excludes self- and triage-agent-authored notes (nothing the daemon could re-pick)", () => {
    const resolved: ResolvedNotesTriage = { enabled: true, mode: "on", triageAgentId: "agent-x" };
    const out = seedNotes(
      [
        mkNote("self", { authorId: SELF }),
        mkNote("agent", { authorId: "agent-x" }),
        mkNote("ok", { authorId: "human" }),
      ],
      SELF,
      resolved,
      createTriagerState(),
    );
    expect(out.map((n) => n.id)).toEqual(["ok"]);
  });

  it("on-mode promote: the minted proposal id never re-enters the seed set; no note-authoring path exists", async () => {
    const client = new FakeClient();
    client.settingsByProject["p"] = { notesTriage: { enabled: true, mode: "on" } };
    let listed = [mkNote("n1")];
    client.listOpenNotes = vi.fn(async () => listed);
    client.promoteToProposal = vi.fn(async (noteId: string) => {
      listed = []; // server consumes the note out of the open lane on promote
      return {
        note: mkNote(noteId, { status: "triaged" }),
        proposal: {
          id: "prop-xyz",
          projectId: "p",
          title: "t",
          description: null,
          status: "draft",
          proposalKind: "standard" as const,
          createdBy: "u-self",
          sourceNoteId: noteId,
          createdAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
        },
      };
    });
    const seededIds: string[] = [];
    const decide = spyDecide(
      async ({ note }) => {
        seededIds.push(note.id);
      },
      { kind: "promote_standard", rationale: "ok", confidence: 1 },
    );
    const state = createTriagerState();
    await triagerTick(mkDeps(client, decide, { maxConcurrent: 5 }), state);
    await triagerTick(mkDeps(client, decide, { maxConcurrent: 5 }), state);
    expect(decide).toHaveBeenCalledTimes(1); // n1, exactly once across both ticks
    expect(seededIds).toEqual(["n1"]);
    expect(seededIds).not.toContain("prop-xyz"); // the minted proposal NEVER seeds
    // The triager surface exposes NO note-authoring method (structural seal).
    expect("createNote" in client).toBe(false);
    expect("postNote" in client).toBe(false);
  });
});

// ── restart-safety / dedupe (reclaim N/A — T2·P5 Seal 2) ────────────

describe("restart-safety / dedupe (reclaim N/A)", () => {
  it("a triaged note is excluded by the status filter (no double action)", () => {
    const out = seedNotes(
      [mkNote("done", { status: "triaged" }), mkNote("open1")],
      SELF,
      { enabled: true, mode: "on" },
      createTriagerState(),
    );
    expect(out.map((n) => n.id)).toEqual(["open1"]);
  });

  it("a simulated restart (still-open note + fresh state) re-seeds idempotently", async () => {
    const client = new FakeClient();
    client.settingsByProject["p"] = { notesTriage: { enabled: true, mode: "on" } };
    client.notesByProject["p"] = [mkNote("n1")]; // server still returns it open (crash pre-consume)
    const decide = spyDecide(async () => {}, { kind: "needs_human", rationale: "", confidence: 0 });

    const s1 = createTriagerState();
    await triagerTick(mkDeps(client, decide, { maxConcurrent: 5 }), s1);
    expect(decide).toHaveBeenCalledTimes(1);

    // Restart: fresh in-memory state, the note still open ⇒ re-seed (restart IS
    // the recovery; the note's status is the dedupe once it leaves the open lane).
    const s2 = createTriagerState();
    await triagerTick(mkDeps(client, decide, { maxConcurrent: 5 }), s2);
    expect(decide).toHaveBeenCalledTimes(2);
  });
});

// ── runTriagerLoop ──────────────────────────────────────────────────

describe("runTriagerLoop", () => {
  it("runs ticks until shouldContinue flips false, then returns", async () => {
    const client = new FakeClient();
    client.settingsByProject["p"] = { notesTriage: { enabled: true, mode: "on" } };
    client.notesByProject["p"] = [mkNote("n1")];
    let ticks = 0;
    const decide = spyDecide(async () => {
      ticks += 1;
    });
    let keep = true;
    await runTriagerLoop(
      {
        ...mkDeps(client, decide, { maxConcurrent: 5 }),
        shouldContinue: () => keep,
        waitForWork: async () => {
          keep = false; // stop after the first tick's wait
        },
      },
      { pollIntervalMs: 1 },
    );
    expect(ticks).toBe(1);
  });
});
