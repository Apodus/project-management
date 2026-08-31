/**
 * Campaign 2026-08-30 §S6 — the anti-exoneration guard, widened to the other
 * two modules that author author-facing reject text.
 *
 * `resolution-eligibility.test.ts` already scans ONE module's source. But the
 * reject an author reads is COMPOSED from three:
 *
 *   - `resolution-eligibility.ts` — the `why` (guarded there)
 *   - `group-integration.ts`      — `mainGitlinkCureText` + the composition
 *   - `git-ops.ts`                — `describeDanglingMainGitlink` (the detail)
 *
 * The latter two were covered only by assertions on ONE composed string in ONE
 * scenario, so a new sentence added to either tomorrow was unguarded. This
 * closes the class rather than today's instances of it.
 *
 * SCOPE IS DELIBERATE — exactly these two files. Widening the sweep to all of
 * `src/` goes red on `group-land.ts`, whose `requeued` doc comment says
 * "nothing is wrong with the change" about an INTERNAL re-queue kind that no
 * author ever reads (campaign 2026-08-15 §R1). A guard that fires on a true
 * sentence in a non-author-facing comment would be deleted within a week; the
 * blast radius is the price of it surviving.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { describeDanglingMainGitlink, type MainGitlinkVerdict } from "../src/git-ops.js";
import { assemblyResolutionEligibility } from "../src/resolution-eligibility.js";

/**
 * Re-DECLARED, not imported from `resolution-eligibility.test.ts`. Two
 * independent statements of the same regression are cheaper than a shared
 * helper here, and that file's pattern carries a scoping comment about the ONE
 * licensed phrase in its own module which must not be diluted by re-use.
 *
 * This is the UNLICENSED subset: `"not this change"` is absent on purpose,
 * because `lane_blocked` licenses that one phrase and `main_gitlink_dangling`
 * — asserted below — is the reason that carries it.
 *
 * Same honest ceiling as the other guard: a phrase blacklist is a REGRESSION
 * GUARD, not an honesty prover. "your patch is fine" sails straight past it.
 */
const UNLICENSED_ANYWHERE =
  /defect in the train|not in (the|your) change|nothing (is )?wrong with (the|your) change/i;

/** The one licensed exoneration, in the single canonical wording §S2 requires. */
const LICENSED = "not this change";

const AUTHOR_FACING_MODULES = ["group-integration.ts", "git-ops.ts"] as const;

const DANGLING: Extract<MainGitlinkVerdict, { kind: "dangling" }> = {
  kind: "dangling",
  presence: "present",
  gitlinkPath: "vendor/rynx",
  target: "2f448c0a2f448c0a2f448c0a2f448c0a2f448c0a",
  outerMainSha: "1ba6a1ff1ba6a1ff1ba6a1ff1ba6a1ff1ba6a1ff",
  innerMainSha: "0d82eba40d82eba40d82eba40d82eba40d82eba4",
  landingInnerSha: "9c3311ee9c3311ee9c3311ee9c3311ee9c3311ee",
};

describe("no author-facing reject string pre-emptively exonerates", () => {
  for (const file of AUTHOR_FACING_MODULES) {
    it(`${file} contains no unlicensed exoneration, anywhere in its text`, () => {
      // Source text, not just returned strings: a phrase reaches an author the
      // moment someone wires up a literal that is already sitting in a comment.
      const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(src).not.toMatch(UNLICENSED_ANYWHERE);
    });
  }

  it("the composed dangling reject measures, and says so exactly once", () => {
    // Composed the way `group-integration.ts` composes it: the assembly detail,
    // then the eligibility `why` verbatim. (`mainGitlinkCureText` is
    // module-private and is covered by the source sweep above plus the
    // end-to-end assertion in `group-main-gitlink-gate.test.ts`.)
    const detail = describeDanglingMainGitlink(DANGLING);
    const why = assemblyResolutionEligibility("main_gitlink_dangling").why;
    const composed = `group assembly failed (main_gitlink_dangling): ${detail} — ${why}`;

    // Non-vacuous: it really does name what it judged.
    expect(composed).toContain(DANGLING.target);
    expect(composed).toContain(DANGLING.outerMainSha);
    expect(composed).toContain(DANGLING.innerMainSha);
    expect(composed).toContain(DANGLING.landingInnerSha);

    // The licensed phrase is a MEASUREMENT, and one canonical form of it is
    // what makes the license checkable — so: present, and present once.
    expect(composed.split(LICENSED).length - 1).toBe(1);
    expect(composed).not.toMatch(UNLICENSED_ANYWHERE);
  });
});
