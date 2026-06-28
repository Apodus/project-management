import { describe, it, expect, vi } from "vitest";
import {
  triagerTick,
  runTriagerLoop,
  createTriagerState,
  seedNotes,
  createStubDecide,
  type TriagerDeps,
  type DecideFn,
} from "../src/loop.js";
import { TriagerClient, type TriagerProjectView } from "../src/api-client.js";
import type { Note, ResolvedNotesTriage } from "@pm/shared";
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

  // Wired (T2·P1) but NEVER called by the P2 stub — present so tests can assert
  // non-destructiveness.
  recordTriageDecision = vi.fn(async (): Promise<never> => {
    throw new Error("recordTriageDecision must NOT be called in P2");
  });
}

function spyDecide(
  impl?: (ctx: { note: Note; projectId: string; resolved: ResolvedNotesTriage }) => Promise<void>,
): DecideFn {
  return vi.fn(async (ctx) => {
    if (impl) await impl(ctx);
    return { kind: "give_up" as const, rationale: "", confidence: 0 };
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

  it("the P2 stub is non-destructive: no triage-decision recorded, no action wrappers exist", async () => {
    const client = new FakeClient();
    client.settingsByProject["p"] = { notesTriage: { enabled: true, mode: "on" } };
    client.notesByProject["p"] = [
      mkNote("n1", { createdAt: "2026-06-01T00:00:00.000Z" }),
      mkNote("n2", { createdAt: "2026-06-02T00:00:00.000Z" }),
    ];
    const decide = createStubDecide({ logger: silentLogger });
    await triagerTick(mkDeps(client, decide, { maxConcurrent: 5 }), createTriagerState());
    // The stub recorded NOTHING.
    expect(client.recordTriageDecision).not.toHaveBeenCalled();
    // No decision-EXECUTION wrappers exist on the client yet (deferred to P4).
    const realClient = new TriagerClient({ baseUrl: "http://h", token: "t" }) as unknown as Record<
      string,
      unknown
    >;
    expect(typeof realClient.recordTriageDecision).toBe("function"); // wired, but unused by the stub
    expect(realClient.promoteToProposal).toBeUndefined();
    expect(realClient.dismiss).toBeUndefined();
    expect(realClient.flagNeedsHuman).toBeUndefined();
    expect(realClient.implementProposal).toBeUndefined();
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
