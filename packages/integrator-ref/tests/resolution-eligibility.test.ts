/**
 * Campaign 2026-08-15 §S4 — the resolver-eligibility taxonomy.
 *
 * Table-driven on purpose. The point is not that each individual answer is
 * right today; it is that EVERY assembly reason has an answer at all, with a
 * stated why. A reason added without a decision fails to compile in the source
 * and fails this table here.
 */
import { describe, expect, it } from "vitest";
import {
  assemblyResolutionEligibility,
  type GroupAssemblyReason,
} from "../src/resolution-eligibility.js";

// The closed union, spelled out. If `AssembledGroupErr.reason` grows a member,
// this list must grow with it — that is the point.
const ALL_REASONS: GroupAssemblyReason[] = [
  "backpressure",
  "inner_conflict",
  "outer_conflict",
  "gitlink_diverged",
  "gitlink_unreachable",
  "gitlink_mismatch",
];

describe("assembly resolution eligibility", () => {
  it("every reason has a decision and a non-trivial why", () => {
    for (const reason of ALL_REASONS) {
      const verdict = assemblyResolutionEligibility(reason);
      expect(typeof verdict.eligible, reason).toBe("boolean");
      // The `why` is the sentence an operator reads (and, on an ineligible
      // reason, what the author is told to do instead) — so it must actually
      // say something.
      expect(verdict.why.length, reason).toBeGreaterThan(30);
    }
  });

  it("the mechanical failures are the ones a resolver is handed", () => {
    // Conflicts are the resolver's home ground; a stale bump branch is a
    // rebase a two-repo agent can genuinely perform.
    expect(assemblyResolutionEligibility("inner_conflict").eligible).toBe(true);
    expect(assemblyResolutionEligibility("outer_conflict").eligible).toBe(true);
    expect(assemblyResolutionEligibility("gitlink_diverged").eligible).toBe(true);

    for (const reason of ["inner_conflict", "outer_conflict", "gitlink_diverged"] as const) {
      expect(assemblyResolutionEligibility(reason).class, reason).toBe("mechanical");
      // An eligible verdict must name the repo, or the executor cannot act.
      expect(assemblyResolutionEligibility(reason).repo, reason).not.toBeNull();
    }
  });

  it("an unpushed inner commit is NEVER handed to a resolver", () => {
    const v = assemblyResolutionEligibility("gitlink_unreachable");
    // THE assertion of this file. The objects do not exist in any clone the
    // daemon can reach, so no agent can materialize them. Spinning a resolver
    // here turns an immediately actionable answer ("push your branch") into a
    // slow, budget-burning, confusing one.
    expect(v.eligible).toBe(false);
    expect(v.class).toBe("author_only");
    expect(v.why).toMatch(/never pushed|push the inner branch/i);
  });

  it("a train bug stays loud instead of being papered over", () => {
    const v = assemblyResolutionEligibility("gitlink_mismatch");
    expect(v.eligible).toBe(false);
    expect(v.class).toBe("train_bug");
    expect(v.why).toMatch(/defect in the train|evidence/i);
  });

  it("backpressure is not a failure and opens nothing", () => {
    const v = assemblyResolutionEligibility("backpressure");
    expect(v.eligible).toBe(false);
    expect(v.class).toBe("not_a_failure");
    expect(v.repo).toBeNull();
  });

  it("an ineligible verdict never names a repo (nothing to act on)", () => {
    for (const reason of ALL_REASONS) {
      const v = assemblyResolutionEligibility(reason);
      if (!v.eligible) expect(v.repo, reason).toBeNull();
    }
  });
});
