/**
 * Campaign 2026-08-15 §S4 — the resolver-eligibility taxonomy.
 *
 * Table-driven on purpose. The point is not that each individual answer is
 * right today; it is that EVERY assembly reason has an answer at all, with a
 * stated why. A reason added without a decision fails to compile in the source
 * and fails this table here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  assemblyResolutionEligibility,
  type GroupAssemblyReason,
  type UnclassifiedGroupAssemblyReason,
} from "../src/resolution-eligibility.js";

// A Record, not an array: a new `GroupAssemblyReason` fails to COMPILE here
// rather than being silently skipped by every case below. The hand list this
// replaces left new union members uncovered by the whole file — the same
// "silently inherits an answer" shape the source module exists to forbid.
const REASON_TABLE: Record<GroupAssemblyReason, true> = {
  backpressure: true,
  inner_conflict: true,
  outer_conflict: true,
  gitlink_diverged: true,
  gitlink_unreachable: true,
  gitlink_mismatch: true,
  main_gitlink_dangling: true,
  assembly_error: true,
};
const ALL_REASONS = Object.keys(REASON_TABLE) as GroupAssemblyReason[];

/** The reasons that mean "no check decided" — pinned by the source module. */
const UNCLASSIFIED: Record<UnclassifiedGroupAssemblyReason, true> = { assembly_error: true };

/**
 * The sentence that caused the 2026-08-30 incident, plus its obvious
 * rewordings. This is NOT a general honesty prover — a phrase blacklist cannot
 * be one, and "your patch is fine" would sail straight past it. It is a
 * REGRESSION GUARD: this family of pre-emptive exonerations does not come back
 * into this module.
 *
 * The criterion it enforces is the reporter's, verbatim — game_one, in the note
 * that opened this campaign (`01M18QWM9RAFVQNFX4FE461B23`):
 *
 *   "a message asserting its own innocence trains readers to stop
 *    investigating"
 *
 * Which is why the one licensed exception below is a MEASUREMENT and not a
 * reassurance: `lane_blocked` may say where the fault is not, because it looked.
 */
const EXONERATION =
  /defect in the train|not in (the|your) change|nothing (is )?wrong with (the|your) change|not this change/i;

/**
 * The subset banned OUTRIGHT in this module's TEXT — comments and
 * not-yet-returned `why` literals included. "not this change" is excluded
 * because `lane_blocked` licenses it, and only it: a class that MEASURED where
 * the fault is may say so (campaign 2026-08-30 §S2 requires that sentence).
 * Keeping the licensed phrasing to ONE canonical form is deliberate — it is
 * what makes the runtime license checkable.
 */
const UNLICENSED_ANYWHERE =
  /defect in the train|not in (the|your) change|nothing (is )?wrong with (the|your) change/i;

const MODULE_SRC = readFileSync(
  new URL("../src/resolution-eligibility.ts", import.meta.url),
  "utf8",
);

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
    // It must SAY what was asserted and what failed...
    expect(v.why).toMatch(/post-assembly assertion failed/i);
    // ...and must not pre-emptively rule a cause out (design lock 3). The old
    // string did exactly that, and it was bolted to the reason that was also
    // the catch-all's dumping ground.
    expect(v.why).not.toMatch(EXONERATION);
  });

  // ── Campaign 2026-08-30 §S3 ────────────────────────────────────────────

  it("a dangling gitlink on main is a LANE verdict, measured", () => {
    const v = assemblyResolutionEligibility("main_gitlink_dangling");
    expect(v.eligible).toBe(false);
    expect(v.class).toBe("lane_blocked");
    expect(v.repo).toBeNull();
    // The finding itself...
    expect(v.why).toMatch(/not reachable from inner main/i);
    // ...and the fact that it was OBSERVED, which is what licenses the sentence
    // below to say where the fault is not.
    expect(v.why).toMatch(/measured, not inferred/i);
  });

  it("the catch-all's reason says nothing was decided, and diagnoses nothing", () => {
    const v = assemblyResolutionEligibility("assembly_error");
    expect(v.eligible).toBe(false);
    expect(v.class).toBe("unknown");
    expect(v.repo).toBeNull();
    // It admits what it is...
    expect(v.why).toMatch(/no check decided/i);
    // ...points at the only evidence that exists, FIRST...
    expect(v.why).toMatch(/raw git error/i);
    // ...and names a check to run rather than a cause.
    expect(v.why).toMatch(/ls-tree HEAD/i);
    // It must NOT imply the invariant this campaign is named after: an
    // unclassified throw is not evidence of a dangling gitlink (roadmap finding
    // 2b — the outer slot's populated-but-not-a-repo overlay makes the fetch
    // fail regardless of the invariant, so that would be a NEW false diagnosis
    // replacing the old one).
    expect(v.why).not.toMatch(/dangling/i);
  });

  it("no verdict exonerates itself, except the one class that measured where the fault is", () => {
    // b1 — the runtime sweep.
    let licensed = 0;
    for (const reason of ALL_REASONS) {
      const v = assemblyResolutionEligibility(reason);
      if (v.class === "lane_blocked") {
        licensed++;
        // b2 — the exception is a branch a REAL case takes, and the licensed
        // sentence keeps saying what §S2 requires it to say. Without this, the
        // exception could quietly stop matching and the sweep below would be
        // testing nothing.
        expect(v.why, reason).toMatch(EXONERATION);
      } else {
        expect(v.why, reason).not.toMatch(EXONERATION);
      }
    }
    expect(licensed).toBeGreaterThan(0);
  });

  it("the exoneration does not come back into this module's TEXT", () => {
    // b3 — a source-text guard, scanning comments and every `why` literal in
    // the file including ones no switch arm returns yet, so a future verdict is
    // covered as it is WRITTEN rather than only if someone remembers to add a
    // case here. Scope, stated honestly: this is a regression guard against the
    // sentence that caused the 2026-08-30 incident and its near rewordings. It
    // does not prove design lock 3 — no phrase list can.
    expect(MODULE_SRC).not.toMatch(UNLICENSED_ANYWHERE);
  });

  it("'unknown' holds the unclassified reasons and NOTHING that was decided", () => {
    for (const reason of ALL_REASONS) {
      const v = assemblyResolutionEligibility(reason);
      // The moment `unknown` contains a decided finding it stops meaning
      // unknown, and the next reader learns nothing from it — which is why
      // `main_gitlink_dangling` is `lane_blocked` and not filed here.
      expect(v.class === "unknown", reason).toBe(reason in UNCLASSIFIED);
    }
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
