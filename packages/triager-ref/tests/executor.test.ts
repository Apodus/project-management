import { describe, it, expect, vi } from "vitest";
import { executeDecision, type ExecClient } from "../src/executor.js";
import { PmApiError, type PromoteNoteToProposalResult } from "../src/api-client.js";
import type { Note, NotesTriageMode } from "@pm/shared";
import type { TriageAssessment } from "../src/decision.js";
import type { Logger } from "../src/logger.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

function mkNote(over: Partial<Note> = {}): Note {
  return {
    id: "n1",
    projectId: "p",
    kind: "bug",
    status: "open",
    title: "t",
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

function mkProposalResult(id = "prop-1"): PromoteNoteToProposalResult {
  return {
    note: mkNote({ status: "triaged" }),
    proposal: {
      id,
      projectId: "p",
      title: "t",
      description: null,
      status: "draft",
      proposalKind: "standard",
      createdBy: "u-self",
      sourceNoteId: "n1",
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
  };
}

interface FakeExec extends ExecClient {
  recordTriageDecision: ReturnType<typeof vi.fn>;
  promoteToProposal: ReturnType<typeof vi.fn>;
  dismissNote: ReturnType<typeof vi.fn>;
  flagNeedsHuman: ReturnType<typeof vi.fn>;
  claimProposal: ReturnType<typeof vi.fn>;
  implementProposal: ReturnType<typeof vi.fn>;
}

function mkClient(over: Partial<Record<keyof FakeExec, unknown>> = {}): FakeExec {
  return {
    recordTriageDecision: vi.fn(async () => ({ id: "td-1" })),
    promoteToProposal: vi.fn(async () => mkProposalResult()),
    dismissNote: vi.fn(async () => mkNote({ status: "triaged" })),
    flagNeedsHuman: vi.fn(async () => mkNote({ status: "needs_human" })),
    claimProposal: vi.fn(async () => ({ ok: true, status: "claimed_by_you" })),
    implementProposal: vi.fn(async () => undefined),
    ...over,
  } as unknown as FakeExec;
}

function ctx(note: Note, assessment: TriageAssessment, mode: NotesTriageMode) {
  return { projectId: "p", note, assessment, mode, logger: silentLogger };
}

const assess = (over: Partial<TriageAssessment>): TriageAssessment => ({
  kind: "give_up",
  rationale: "r",
  confidence: 0.5,
  ...over,
});

// ── shadow: record-only, no mutation ────────────────────────────────

describe("executeDecision — shadow", () => {
  it.each([["promote_standard"], ["dismiss"], ["needs_human"], ["give_up"]] as const)(
    "%s: records mode=shadow + correct decision, NO action wrapper",
    async (kind) => {
      const client = mkClient();
      const out = await executeDecision(client, ctx(mkNote(), assess({ kind }), "shadow"));
      expect(out).toEqual({ recorded: true });
      expect(client.recordTriageDecision).toHaveBeenCalledTimes(1);
      expect(client.recordTriageDecision.mock.calls[0][1]).toMatchObject({
        mode: "shadow",
        decision: kind,
        resultingProposalId: null,
        resultingTaskId: null,
      });
      expect(client.promoteToProposal).not.toHaveBeenCalled();
      expect(client.dismissNote).not.toHaveBeenCalled();
      expect(client.flagNeedsHuman).not.toHaveBeenCalled();
    },
  );

  it("fast_track w/ breakdown: shadow records the fast_track kind, no promote", async () => {
    const client = mkClient();
    const out = await executeDecision(
      client,
      ctx(
        mkNote(),
        assess({ kind: "promote_fast_track", breakdown: { tasks: [{ title: "a" }] } }),
        "shadow",
      ),
    );
    expect(out).toEqual({ recorded: true });
    expect(client.recordTriageDecision.mock.calls[0][1]).toMatchObject({
      mode: "shadow",
      decision: "promote_fast_track",
    });
    expect(client.promoteToProposal).not.toHaveBeenCalled();
  });
});

// ── off: nothing ────────────────────────────────────────────────────

describe("executeDecision — off", () => {
  it("records nothing, acts nothing", async () => {
    const client = mkClient();
    const out = await executeDecision(client, ctx(mkNote(), assess({ kind: "dismiss" }), "off"));
    expect(out).toEqual({ recorded: false });
    expect(client.recordTriageDecision).not.toHaveBeenCalled();
    expect(client.dismissNote).not.toHaveBeenCalled();
  });
});

// ── on: promote_standard ────────────────────────────────────────────

describe("executeDecision — on/promote_standard", () => {
  it("promotes (standard) + records on/promote_standard w/ resultingProposalId; no claim/implement", async () => {
    const client = mkClient();
    const out = await executeDecision(
      client,
      ctx(mkNote(), assess({ kind: "promote_standard" }), "on"),
    );
    expect(out).toEqual({ recorded: true, resultingProposalId: "prop-1" });
    expect(client.promoteToProposal).toHaveBeenCalledWith("n1", { proposalKind: "standard" });
    expect(client.claimProposal).not.toHaveBeenCalled();
    expect(client.implementProposal).not.toHaveBeenCalled();
    expect(client.recordTriageDecision.mock.calls[0][1]).toMatchObject({
      mode: "on",
      decision: "promote_standard",
      resultingProposalId: "prop-1",
      resultingTaskId: null,
    });
  });
});

// ── on: promote_fast_track ──────────────────────────────────────────

describe("executeDecision — on/promote_fast_track", () => {
  it("happy: promote(fast_track)→claim→implement(mapped epics+tasks); records resultingProposalId, resultingTaskId null", async () => {
    const client = mkClient();
    const assessment = assess({
      kind: "promote_fast_track",
      breakdown: {
        epics: [{ title: "Epic A", description: "ed" }],
        tasks: [{ title: "T1", description: "d1" }, { title: "T2" }],
      },
    });
    const out = await executeDecision(client, ctx(mkNote(), assessment, "on"));
    expect(out).toEqual({ recorded: true, resultingProposalId: "prop-1" });
    expect(client.promoteToProposal).toHaveBeenCalledWith("n1", { proposalKind: "fast_track" });
    expect(client.claimProposal).toHaveBeenCalledWith("prop-1");
    expect(client.implementProposal).toHaveBeenCalledWith("prop-1", {
      epics: [{ name: "Epic A", description: "ed" }],
      tasks: [
        { title: "T1", description: "d1" },
        { title: "T2", description: undefined },
      ],
    });
    expect(client.recordTriageDecision.mock.calls[0][1]).toMatchObject({
      mode: "on",
      decision: "promote_fast_track",
      resultingProposalId: "prop-1",
      resultingTaskId: null,
    });
  });

  it("claim ok:false: implement NOT called; record STILL written w/ proposalId", async () => {
    const client = mkClient({
      claimProposal: vi.fn(async () => ({ ok: false, status: "claimed_by_other" })),
    });
    const out = await executeDecision(
      client,
      ctx(
        mkNote(),
        assess({ kind: "promote_fast_track", breakdown: { tasks: [{ title: "T1" }] } }),
        "on",
      ),
    );
    expect(out).toEqual({ recorded: true, resultingProposalId: "prop-1" });
    expect(client.implementProposal).not.toHaveBeenCalled();
    expect(client.recordTriageDecision).toHaveBeenCalledTimes(1);
  });

  it("implement throws: caught; record STILL written; recorded:true", async () => {
    const client = mkClient({
      implementProposal: vi.fn(async () => {
        throw new Error("implement boom");
      }),
    });
    const out = await executeDecision(
      client,
      ctx(
        mkNote(),
        assess({ kind: "promote_fast_track", breakdown: { tasks: [{ title: "T1" }] } }),
        "on",
      ),
    );
    expect(out).toEqual({ recorded: true, resultingProposalId: "prop-1" });
    expect(client.recordTriageDecision).toHaveBeenCalledTimes(1);
  });

  it("promote throws transient (503): propagates, no record", async () => {
    const client = mkClient({
      promoteToProposal: vi.fn(async () => {
        throw new PmApiError(503, "X", "down");
      }),
    });
    await expect(
      executeDecision(
        client,
        ctx(
          mkNote(),
          assess({ kind: "promote_fast_track", breakdown: { tasks: [{ title: "T1" }] } }),
          "on",
        ),
      ),
    ).rejects.toBeInstanceOf(PmApiError);
    expect(client.recordTriageDecision).not.toHaveBeenCalled();
    expect(client.flagNeedsHuman).not.toHaveBeenCalled();
  });

  it("promote throws permanent (400): escalate → flagNeedsHuman + record decision=needs_human", async () => {
    const client = mkClient({
      promoteToProposal: vi.fn(async () => {
        throw new PmApiError(400, "X", "bad");
      }),
    });
    const out = await executeDecision(
      client,
      ctx(
        mkNote(),
        assess({ kind: "promote_fast_track", breakdown: { tasks: [{ title: "T1" }] } }),
        "on",
      ),
    );
    expect(out).toEqual({ recorded: true });
    expect(client.flagNeedsHuman).toHaveBeenCalledWith("n1");
    expect(client.recordTriageDecision.mock.calls[0][1]).toMatchObject({
      mode: "on",
      decision: "needs_human",
    });
  });

  it("bias guard: fast_track w/ empty/undefined tasks ⇒ STANDARD promote, no claim/implement, record promote_standard", async () => {
    const client = mkClient();
    const out = await executeDecision(
      client,
      ctx(mkNote(), assess({ kind: "promote_fast_track" }), "on"),
    );
    expect(out).toEqual({ recorded: true, resultingProposalId: "prop-1" });
    expect(client.promoteToProposal).toHaveBeenCalledWith("n1", { proposalKind: "standard" });
    expect(client.claimProposal).not.toHaveBeenCalled();
    expect(client.implementProposal).not.toHaveBeenCalled();
    expect(client.recordTriageDecision.mock.calls[0][1]).toMatchObject({
      decision: "promote_standard",
    });
  });
});

// ── on: dismiss ─────────────────────────────────────────────────────

describe("executeDecision — on/dismiss", () => {
  it("dismisses with rationale + records decision=dismiss", async () => {
    const client = mkClient();
    const out = await executeDecision(
      client,
      ctx(mkNote(), assess({ kind: "dismiss", rationale: "noise" }), "on"),
    );
    expect(out).toEqual({ recorded: true });
    expect(client.dismissNote).toHaveBeenCalledWith("n1", "noise");
    expect(client.recordTriageDecision.mock.calls[0][1]).toMatchObject({
      mode: "on",
      decision: "dismiss",
    });
  });

  it("empty rationale falls back to 'dismissed by triager'", async () => {
    const client = mkClient();
    await executeDecision(client, ctx(mkNote(), assess({ kind: "dismiss", rationale: "" }), "on"));
    expect(client.dismissNote).toHaveBeenCalledWith("n1", "dismissed by triager");
  });

  it("permanent 403 (THE HOT-LOOP FIX): escalate → flagNeedsHuman + record decision=needs_human", async () => {
    const client = mkClient({
      dismissNote: vi.fn(async () => {
        throw new PmApiError(403, "FORBIDDEN", "not allowed");
      }),
    });
    const out = await executeDecision(client, ctx(mkNote(), assess({ kind: "dismiss" }), "on"));
    expect(out).toEqual({ recorded: true });
    expect(client.flagNeedsHuman).toHaveBeenCalledWith("n1");
    expect(client.recordTriageDecision.mock.calls[0][1]).toMatchObject({
      mode: "on",
      decision: "needs_human",
    });
  });

  it("transient 500: propagates, no record", async () => {
    const client = mkClient({
      dismissNote: vi.fn(async () => {
        throw new PmApiError(500, "X", "boom");
      }),
    });
    await expect(
      executeDecision(client, ctx(mkNote(), assess({ kind: "dismiss" }), "on")),
    ).rejects.toBeInstanceOf(PmApiError);
    expect(client.recordTriageDecision).not.toHaveBeenCalled();
    expect(client.flagNeedsHuman).not.toHaveBeenCalled();
  });
});

// ── on: needs_human / give_up ───────────────────────────────────────

describe("executeDecision — on/needs_human + give_up", () => {
  it("needs_human: flagNeedsHuman + record decision=needs_human", async () => {
    const client = mkClient();
    const out = await executeDecision(client, ctx(mkNote(), assess({ kind: "needs_human" }), "on"));
    expect(out).toEqual({ recorded: true });
    expect(client.flagNeedsHuman).toHaveBeenCalledWith("n1");
    expect(client.recordTriageDecision.mock.calls[0][1]).toMatchObject({ decision: "needs_human" });
  });

  it("give_up: flagNeedsHuman (fail-safe to human) but record the ACTUAL decision=give_up", async () => {
    const client = mkClient();
    const out = await executeDecision(client, ctx(mkNote(), assess({ kind: "give_up" }), "on"));
    expect(out).toEqual({ recorded: true });
    expect(client.flagNeedsHuman).toHaveBeenCalledWith("n1");
    expect(client.recordTriageDecision.mock.calls[0][1]).toMatchObject({ decision: "give_up" });
  });
});
