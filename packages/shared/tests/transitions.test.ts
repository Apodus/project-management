import { describe, it, expect } from "vitest";
import {
  PROPOSAL_TRANSITIONS,
  PROPOSAL_TRANSITION_MAP,
  isValidProposalTransition,
  getValidProposalTargets,
  TASK_TRANSITIONS,
  TASK_TRANSITION_MAP,
  isValidTaskTransition,
  getValidTaskTargets,
} from "../src/index.js";
import type { ProposalStatus, TaskStatus } from "../src/index.js";

// ============================================================
// Proposal transitions
// ============================================================

describe("PROPOSAL_TRANSITIONS", () => {
  it("has exactly 5 transition rules", () => {
    expect(PROPOSAL_TRANSITIONS).toHaveLength(5);
  });

  it("open -> discussing is allowed by both human and ai_agent", () => {
    const rule = PROPOSAL_TRANSITION_MAP.get("open->discussing");
    expect(rule).toBeDefined();
    expect(rule!.allowedBy).toContain("human");
    expect(rule!.allowedBy).toContain("ai_agent");
  });

  it("discussing -> accepted is allowed by human ONLY", () => {
    const rule = PROPOSAL_TRANSITION_MAP.get("discussing->accepted");
    expect(rule).toBeDefined();
    expect(rule!.allowedBy).toEqual(["human"]);
  });

  it("discussing -> rejected is allowed by human ONLY", () => {
    const rule = PROPOSAL_TRANSITION_MAP.get("discussing->rejected");
    expect(rule).toBeDefined();
    expect(rule!.allowedBy).toEqual(["human"]);
  });

  it("open -> rejected is allowed by human ONLY", () => {
    const rule = PROPOSAL_TRANSITION_MAP.get("open->rejected");
    expect(rule).toBeDefined();
    expect(rule!.allowedBy).toEqual(["human"]);
  });

  it("accepted -> planned is allowed by ai_agent ONLY", () => {
    const rule = PROPOSAL_TRANSITION_MAP.get("accepted->planned");
    expect(rule).toBeDefined();
    expect(rule!.allowedBy).toEqual(["ai_agent"]);
  });
});

describe("isValidProposalTransition", () => {
  it("returns true for all 5 valid transitions without actor check", () => {
    expect(isValidProposalTransition("open", "discussing")).toBe(true);
    expect(isValidProposalTransition("discussing", "accepted")).toBe(true);
    expect(isValidProposalTransition("discussing", "rejected")).toBe(true);
    expect(isValidProposalTransition("open", "rejected")).toBe(true);
    expect(isValidProposalTransition("accepted", "planned")).toBe(true);
  });

  // Invalid transitions
  it("returns false for open -> accepted (must go through discussing)", () => {
    expect(isValidProposalTransition("open", "accepted")).toBe(false);
  });

  it("returns false for open -> planned", () => {
    expect(isValidProposalTransition("open", "planned")).toBe(false);
  });

  it("returns false for rejected -> open (no undoing rejection)", () => {
    expect(isValidProposalTransition("rejected", "open")).toBe(false);
  });

  it("returns false for rejected -> discussing", () => {
    expect(isValidProposalTransition("rejected", "discussing")).toBe(false);
  });

  it("returns false for planned -> accepted", () => {
    expect(isValidProposalTransition("planned", "accepted")).toBe(false);
  });

  it("returns false for discussing -> open", () => {
    expect(isValidProposalTransition("discussing", "open")).toBe(false);
  });

  it("returns false for discussing -> planned", () => {
    expect(isValidProposalTransition("discussing", "planned")).toBe(false);
  });

  it("returns false for accepted -> rejected", () => {
    expect(isValidProposalTransition("accepted", "rejected")).toBe(false);
  });

  it("returns false for same-status transitions", () => {
    const statuses: ProposalStatus[] = [
      "open",
      "discussing",
      "accepted",
      "planned",
      "rejected",
    ];
    for (const s of statuses) {
      expect(isValidProposalTransition(s, s)).toBe(false);
    }
  });

  // Role-based checks
  it("allows open -> discussing by ai_agent", () => {
    expect(isValidProposalTransition("open", "discussing", "ai_agent")).toBe(true);
  });

  it("allows open -> discussing by human", () => {
    expect(isValidProposalTransition("open", "discussing", "human")).toBe(true);
  });

  it("denies discussing -> accepted by ai_agent", () => {
    expect(isValidProposalTransition("discussing", "accepted", "ai_agent")).toBe(false);
  });

  it("allows discussing -> accepted by human", () => {
    expect(isValidProposalTransition("discussing", "accepted", "human")).toBe(true);
  });

  it("denies discussing -> rejected by ai_agent", () => {
    expect(isValidProposalTransition("discussing", "rejected", "ai_agent")).toBe(false);
  });

  it("denies open -> rejected by ai_agent", () => {
    expect(isValidProposalTransition("open", "rejected", "ai_agent")).toBe(false);
  });

  it("denies accepted -> planned by human", () => {
    expect(isValidProposalTransition("accepted", "planned", "human")).toBe(false);
  });

  it("allows accepted -> planned by ai_agent", () => {
    expect(isValidProposalTransition("accepted", "planned", "ai_agent")).toBe(true);
  });
});

describe("getValidProposalTargets", () => {
  it("returns [discussing, rejected] for open (no actor filter)", () => {
    const targets = getValidProposalTargets("open");
    expect(targets).toContain("discussing");
    expect(targets).toContain("rejected");
    expect(targets).toHaveLength(2);
  });

  it("returns [discussing] for open when actor is ai_agent", () => {
    const targets = getValidProposalTargets("open", "ai_agent");
    expect(targets).toEqual(["discussing"]);
  });

  it("returns [accepted, rejected] for discussing (no actor filter)", () => {
    const targets = getValidProposalTargets("discussing");
    expect(targets).toContain("accepted");
    expect(targets).toContain("rejected");
    expect(targets).toHaveLength(2);
  });

  it("returns [] for discussing when actor is ai_agent", () => {
    expect(getValidProposalTargets("discussing", "ai_agent")).toEqual([]);
  });

  it("returns [planned] for accepted", () => {
    expect(getValidProposalTargets("accepted")).toEqual(["planned"]);
  });

  it("returns [] for planned (terminal)", () => {
    expect(getValidProposalTargets("planned")).toEqual([]);
  });

  it("returns [] for rejected (terminal)", () => {
    expect(getValidProposalTargets("rejected")).toEqual([]);
  });
});

// ============================================================
// Task transitions
// ============================================================

describe("TASK_TRANSITIONS", () => {
  it("has exactly 10 transition rules", () => {
    expect(TASK_TRANSITIONS).toHaveLength(10);
  });

  it("contains all expected transitions", () => {
    const expected = [
      "backlog->ready",
      "ready->in_progress",
      "in_progress->in_review",
      "in_progress->done",
      "in_review->done",
      "in_review->in_progress",
      "backlog->cancelled",
      "ready->cancelled",
      "in_progress->cancelled",
      "ready->backlog",
    ];
    for (const key of expected) {
      expect(TASK_TRANSITION_MAP.has(key)).toBe(true);
    }
  });
});

describe("isValidTaskTransition", () => {
  // Valid transitions
  it("backlog -> ready is valid", () => {
    expect(isValidTaskTransition("backlog", "ready")).toBe(true);
  });

  it("ready -> in_progress is valid", () => {
    expect(isValidTaskTransition("ready", "in_progress")).toBe(true);
  });

  it("in_progress -> in_review is valid", () => {
    expect(isValidTaskTransition("in_progress", "in_review")).toBe(true);
  });

  it("in_progress -> done is valid (skip review)", () => {
    expect(isValidTaskTransition("in_progress", "done")).toBe(true);
  });

  it("in_review -> done is valid", () => {
    expect(isValidTaskTransition("in_review", "done")).toBe(true);
  });

  it("in_review -> in_progress is valid (review feedback)", () => {
    expect(isValidTaskTransition("in_review", "in_progress")).toBe(true);
  });

  it("backlog -> cancelled is valid", () => {
    expect(isValidTaskTransition("backlog", "cancelled")).toBe(true);
  });

  it("ready -> cancelled is valid", () => {
    expect(isValidTaskTransition("ready", "cancelled")).toBe(true);
  });

  it("in_progress -> cancelled is valid", () => {
    expect(isValidTaskTransition("in_progress", "cancelled")).toBe(true);
  });

  it("ready -> backlog is valid (demote)", () => {
    expect(isValidTaskTransition("ready", "backlog")).toBe(true);
  });

  // Invalid transitions
  it("done -> backlog is invalid", () => {
    expect(isValidTaskTransition("done", "backlog")).toBe(false);
  });

  it("done -> in_progress is invalid", () => {
    expect(isValidTaskTransition("done", "in_progress")).toBe(false);
  });

  it("cancelled -> backlog is invalid", () => {
    expect(isValidTaskTransition("cancelled", "backlog")).toBe(false);
  });

  it("cancelled -> ready is invalid", () => {
    expect(isValidTaskTransition("cancelled", "ready")).toBe(false);
  });

  it("cancelled -> in_progress is invalid", () => {
    expect(isValidTaskTransition("cancelled", "in_progress")).toBe(false);
  });

  it("backlog -> in_progress is invalid (must go through ready)", () => {
    expect(isValidTaskTransition("backlog", "in_progress")).toBe(false);
  });

  it("backlog -> done is invalid", () => {
    expect(isValidTaskTransition("backlog", "done")).toBe(false);
  });

  it("ready -> done is invalid (must go through in_progress)", () => {
    expect(isValidTaskTransition("ready", "done")).toBe(false);
  });

  it("ready -> in_review is invalid", () => {
    expect(isValidTaskTransition("ready", "in_review")).toBe(false);
  });

  it("in_review -> cancelled is not defined (must cancel from in_progress or earlier)", () => {
    expect(isValidTaskTransition("in_review", "cancelled")).toBe(false);
  });

  it("same-status transitions are invalid", () => {
    const statuses: TaskStatus[] = [
      "backlog",
      "ready",
      "in_progress",
      "in_review",
      "done",
      "cancelled",
    ];
    for (const s of statuses) {
      expect(isValidTaskTransition(s, s)).toBe(false);
    }
  });
});

describe("getValidTaskTargets", () => {
  it("returns [ready, cancelled] for backlog", () => {
    const targets = getValidTaskTargets("backlog");
    expect(targets).toContain("ready");
    expect(targets).toContain("cancelled");
    expect(targets).toHaveLength(2);
  });

  it("returns [in_progress, cancelled, backlog] for ready", () => {
    const targets = getValidTaskTargets("ready");
    expect(targets).toContain("in_progress");
    expect(targets).toContain("cancelled");
    expect(targets).toContain("backlog");
    expect(targets).toHaveLength(3);
  });

  it("returns [in_review, done, cancelled] for in_progress", () => {
    const targets = getValidTaskTargets("in_progress");
    expect(targets).toContain("in_review");
    expect(targets).toContain("done");
    expect(targets).toContain("cancelled");
    expect(targets).toHaveLength(3);
  });

  it("returns [done, in_progress] for in_review", () => {
    const targets = getValidTaskTargets("in_review");
    expect(targets).toContain("done");
    expect(targets).toContain("in_progress");
    expect(targets).toHaveLength(2);
  });

  it("returns [] for done (terminal)", () => {
    expect(getValidTaskTargets("done")).toEqual([]);
  });

  it("returns [] for cancelled (terminal)", () => {
    expect(getValidTaskTargets("cancelled")).toEqual([]);
  });
});
