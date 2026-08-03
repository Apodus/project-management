import { describe, expect, it } from "vitest";
import {
  categorize,
  failureExcerpt,
  lastMeaningfulErrorLine,
  tailExcerpt,
  type CategorizeInput,
} from "../src/categorize.js";

function input(overrides: Partial<CategorizeInput>): CategorizeInput {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

describe("categorize", () => {
  it("verify_timeout — timedOut flag", () => {
    const r = categorize(input({ timedOut: true, exitCode: 1 }));
    expect(r.category).toBe("verify_timeout");
  });

  it("verify_timeout — exit code 124", () => {
    expect(categorize(input({ exitCode: 124 })).category).toBe("verify_timeout");
  });

  it("verify_timeout — SIGTERM signal", () => {
    expect(categorize(input({ exitCode: 1, signal: "SIGTERM" })).category).toBe("verify_timeout");
  });

  it("verify_timeout — SIGKILL signal", () => {
    expect(categorize(input({ exitCode: 1, signal: "SIGKILL" })).category).toBe("verify_timeout");
  });

  it("build_failed — rustc error[E....] + extracts files", () => {
    const stderr = [
      "error[E0599]: no method named `bind_skin` found",
      "  --> crates/renderer/src/skinned.rs:142:18",
      "error[E0308]: mismatched types",
      "  --> crates/renderer/src/lib.rs:10:5",
    ].join("\n");
    const r = categorize(input({ exitCode: 101, stderr }));
    expect(r.category).toBe("build_failed");
    expect(r.failedFiles).toEqual(["crates/renderer/src/skinned.rs", "crates/renderer/src/lib.rs"]);
    expect(r.reason).toContain("error[E0599]");
  });

  it("build_failed — error: could not compile", () => {
    const stderr = "error: aborting due to previous error\nerror: could not compile `renderer`";
    const r = categorize(input({ exitCode: 101, stderr }));
    expect(r.category).toBe("build_failed");
  });

  it("build_failed — MSVC linker LNK1236 amid a flood of warnings (real game_one regression)", () => {
    // The exact shape that bit us: /WX- so warnings are non-fatal, 1045 of them,
    // and ONE fatal linker error. Must be build_failed (NOT lint_failed) and the
    // reason must be the real error, not a random warning line.
    const stdout = [
      "warning: -fdelayed-template-parsing is deprecated after C++20 [-Wdelayed-template-parsing-in-cxx20]",
      "shaderc_combinedd.lib(shaderc.obj) : warning LNK4099: PDB 'shadercd.pdb' was not found; linking object as if no debug info",
      "tech.lib(components_reflection.generated.obj) : fatal error LNK1236: corrupt or invalid COFF sections [D:\\pm-integrator\\rynx-integrator-0\\rynx\\generate\\build\\projects\\testrender_vs2022.vcxproj]",
      "",
      "    1045 Warning(s)",
      "    1 Error(s)",
    ].join("\n");
    const r = categorize(input({ exitCode: 1, stdout }));
    expect(r.category).toBe("build_failed");
    expect(r.category).not.toBe("lint_failed");
    expect(r.reason).toContain("LNK1236");
    expect(r.reason).not.toMatch(/^warning:/);
    expect(r.failedFiles).toContain(
      "D:\\pm-integrator\\rynx-integrator-0\\rynx\\generate\\build\\projects\\testrender_vs2022.vcxproj",
    );
  });

  it("build_failed — MSVC compiler error C#### + extracts the source file", () => {
    const stdout =
      "..\\..\\src\\foo\\bar.cpp(42,7): error C2065: 'undeclared_identifier': undeclared identifier";
    const r = categorize(input({ exitCode: 1, stdout }));
    expect(r.category).toBe("build_failed");
    expect(r.reason).toContain("error C2065");
    expect(r.failedFiles).toContain("..\\..\\src\\foo\\bar.cpp");
  });

  it("build_failed — clang/gcc file:line:col: error: form", () => {
    const stderr = "src/render/pipeline.cpp:88:13: error: no member named 'foo' in 'Bar'";
    const r = categorize(input({ exitCode: 1, stderr }));
    expect(r.category).toBe("build_failed");
    expect(r.failedFiles).toContain("src/render/pipeline.cpp");
  });

  it("build_failed — MSBuild 'N Error(s)' summary (N>=1) without a per-line code", () => {
    const stdout = "Build FAILED.\n\n    12 Warning(s)\n    3 Error(s)\n";
    expect(categorize(input({ exitCode: 1, stdout })).category).toBe("build_failed");
  });

  it("lint_failed still wins for warning-only output with no compile/link error", () => {
    // Guard the boundary: a warnings-only non-zero exit (no LNK/C####/N Error(s))
    // must remain lint_failed, not get swept into build_failed.
    const stdout = "warning: something is deprecated\n\n    7 Warning(s)\n    0 Error(s)\n";
    expect(categorize(input({ exitCode: 1, stdout })).category).toBe("lint_failed");
  });

  it("test_failed — pytest FAILURES + extracts py files", () => {
    const stdout = [
      "=================================== FAILURES ===================================",
      "____________________ tests/test_foo.py::test_bar ____________________",
      "some assertion error",
      "____________________ tests/test_baz.py::test_qux ____________________",
    ].join("\n");
    const r = categorize(input({ exitCode: 1, stdout }));
    expect(r.category).toBe("test_failed");
    expect(r.failedFiles).toEqual(["tests/test_foo.py", "tests/test_baz.py"]);
  });

  it("test_failed — unittest FAILED (failures=", () => {
    const stderr = "FAILED (failures=2)";
    expect(categorize(input({ exitCode: 1, stderr })).category).toBe("test_failed");
  });

  it("test_failed — cargo test result: FAILED", () => {
    const stdout = "test result: FAILED. 3 passed; 1 failed; 0 ignored";
    const r = categorize(input({ exitCode: 101, stdout }));
    expect(r.category).toBe("test_failed");
    expect(r.failedFiles).toEqual([]);
  });

  it("test_failed — generic FAIL line marker", () => {
    const stdout = "FAIL src/foo.test.ts";
    expect(categorize(input({ exitCode: 1, stdout })).category).toBe("test_failed");
  });

  it("lint_failed — eslint pattern with non-zero exit", () => {
    const stdout =
      "/src/foo.ts\n  1:1  error  Unexpected console statement  no-console\n\n1 problem\neslint found errors";
    const r = categorize(input({ exitCode: 1, stdout }));
    expect(r.category).toBe("lint_failed");
  });

  it("lint_failed — clippy pattern", () => {
    const stderr = "warning: this is clippy::needless_return";
    const r = categorize(input({ exitCode: 1, stderr }));
    expect(r.category).toBe("lint_failed");
  });

  it("lint_failed — prettier pattern", () => {
    const stdout = "Prettier check failed";
    expect(categorize(input({ exitCode: 1, stdout })).category).toBe("lint_failed");
  });

  it("other — non-zero exit, no recognized pattern", () => {
    const r = categorize(input({ exitCode: 3, stderr: "boom" }));
    expect(r.category).toBe("other");
    expect(r.reason).toContain("exit code 3");
  });

  it("other — surfaces the tail error line, not a bare exit code (codegen abort)", () => {
    // The real game_one bite: a from-scratch shader codegen aborts on a UBO
    // layout drift. Matches no known toolchain signature, so it lands in `other`
    // — but the reason must carry the actual abort line, not just "exit code 1",
    // or agents misread a legitimate reject as an integrator fault.
    const stdout = [
      "compiling shaders...",
      "[1/412] dynamic_vegetation_shadow_full.comp",
      "rynx-codegen: layout drift on 'DynamicVegetationShadowFrame' between dynamic_vegetation_shadow_full and dynamic_vegetation_shadow_update (sizes 96 vs 80) -- aborting due to cross-shader block layout drift",
    ].join("\n");
    const r = categorize(input({ exitCode: 1, stdout }));
    expect(r.category).toBe("other");
    expect(r.reason).toContain("exit code 1");
    expect(r.reason).toContain("layout drift on 'DynamicVegetationShadowFrame'");
  });

  it("other — falls back to the last non-empty line when nothing looks error-ish", () => {
    const r = categorize(input({ exitCode: 2, stdout: "step one\nstep two\nstep three" }));
    expect(r.category).toBe("other");
    expect(r.reason).toContain("step three");
  });

  it("build_failed takes precedence over plain non-zero exit", () => {
    const r = categorize(input({ exitCode: 1, stderr: "error[E0001]: x\n  --> a.rs:1:1" }));
    expect(r.category).toBe("build_failed");
  });
});

describe("lastMeaningfulErrorLine", () => {
  it("scans from the tail for the last error-ish line", () => {
    const text = "error: early transient\nlots of normal output\nfatal: the real reason\ndone.";
    expect(lastMeaningfulErrorLine(text)).toBe("fatal: the real reason");
  });

  it("empty input yields empty string", () => {
    expect(lastMeaningfulErrorLine("   \n  \n")).toBe("");
  });
});

describe("tailExcerpt", () => {
  it("returns the input unchanged when under the cap", () => {
    expect(tailExcerpt("short log", 4096)).toBe("short log");
  });

  it("keeps the TAIL (where the error is), flagging the elided head", () => {
    const body = "x".repeat(5000) + "\nFATAL: the actual error at the end";
    const out = tailExcerpt(body, 4096);
    expect(out).toContain("FATAL: the actual error at the end");
    expect(out).toContain("earlier chars omitted");
    // The head noise is dropped; only ~cap chars survive.
    expect(out.length).toBeLessThan(4200);
  });
});

// ─── Catch2 (rynx / game_one) ────────────────────────────────────────────────

/** A green Catch2 binary that still prints FAILED: blocks for its [!shouldfail] cases. */
const CATCH2_GREEN_WITH_SHOULDFAIL = [
  "-------------------------------------------------------------------------------",
  "mech kick drift stays inside the authored envelope",
  "-------------------------------------------------------------------------------",
  "D:\\wt\\rynx\\src\\test\\tech\\test_collision_response.cpp(880)",
  "...............................................................................",
  "",
  "D:\\wt\\rynx\\src\\test\\tech\\test_collision_response.cpp(890): FAILED:",
  "  REQUIRE( drift < 6.0f )",
  "with expansion:",
  "  7.87f < 6.0f",
  "",
  "===============================================================================",
  "test cases:   1327 |   1324 passed | 3 failed as expected",
  "assertions: 8171350 | 8171347 passed | 3 failed as expected",
].join("\n");

/** A red Catch2 binary: the real game_one testgamebehavior failure. */
const CATCH2_RED = [
  "-------------------------------------------------------------------------------",
  "P1 trigger-aware role matrix is deterministic for every fixture and distance",
  "-------------------------------------------------------------------------------",
  "D:\\wt\\src\\topdownshooter\\test\\behavior\\test_weapon_definition_matrix.cpp(278)",
  "...............................................................................",
  "",
  "D:\\wt\\src\\topdownshooter\\test\\behavior\\test_weapon_definition_matrix.cpp(307): FAILED:",
  '  REQUIRE( hex_u64(contract, "scenario_digest") == digest )',
  "with expansion:",
  "  10613189815033782153 == 17509516702106595936",
  "",
  "===============================================================================",
  "test cases:    378 |    375 passed | 3 failed",
  "assertions: 163889 | 163886 passed | 3 failed",
].join("\n");

/** The teardown chatter that used to hijack every reject reason. */
const AUDIO_CHATTER = Array.from(
  { length: 752 },
  () => "failed to close audio stream: Invalid stream pointer",
).join("\n");

describe("categorize — Catch2", () => {
  it("test_failed — names the failing case, file:line and assertion", () => {
    const r = categorize(input({ exitCode: 1, stdout: CATCH2_RED }));
    expect(r.category).toBe("test_failed");
    expect(r.reason).toContain("3 failed");
    expect(r.reason).toContain("P1 trigger-aware role matrix is deterministic");
    expect(r.reason).toContain("test_weapon_definition_matrix.cpp:307");
    expect(r.reason).toContain("scenario_digest");
    expect(r.failedFiles).toHaveLength(1);
    expect(r.failedFiles[0]).toContain("test_weapon_definition_matrix.cpp");
  });

  it("`N failed as expected` is a PASS — [!shouldfail] never reads as a failure", () => {
    // Catch2 scores [!shouldfail] cases as passes and prints FAILED: blocks for
    // them anyway. game_one's verify carries three; keying on the block instead
    // of the summary term would report a green suite as red.
    const r = categorize(input({ exitCode: 1, stdout: CATCH2_GREEN_WITH_SHOULDFAIL }));
    expect(r.category).not.toBe("test_failed");
  });

  it("a mixed summary still matches on the real failures", () => {
    const stdout = "test cases: 5 | 2 passed | 1 failed | 2 failed as expected";
    expect(categorize(input({ exitCode: 1, stdout })).category).toBe("test_failed");
  });

  it("scopes extraction to the binary that failed, not an earlier green one", () => {
    // One verify log, two binaries: a green suite whose [!shouldfail] blocks come
    // FIRST, then the red one. The reported failure must be the red binary's.
    const stdout = `${CATCH2_GREEN_WITH_SHOULDFAIL}\n\n${CATCH2_RED}`;
    const r = categorize(input({ exitCode: 1, stdout }));
    expect(r.category).toBe("test_failed");
    expect(r.reason).toContain("test_weapon_definition_matrix.cpp:307");
    expect(r.failedFiles.join()).not.toContain("test_collision_response.cpp");
  });

  it("stderr chatter cannot hijack the reason (the live regression)", () => {
    // The exact reject that read as integrator flakiness: 752 lines of headless
    // audio teardown noise on stderr, a real red suite on stdout. It must be
    // categorized on the tests, and must never quote the chatter.
    const r = categorize(input({ exitCode: 1, stdout: CATCH2_RED, stderr: AUDIO_CHATTER }));
    expect(r.category).toBe("test_failed");
    expect(r.reason).not.toContain("failed to close audio stream");
    expect(r.reason).toContain("test_weapon_definition_matrix.cpp:307");
  });
});

describe("lastMeaningfulErrorLine — repeated chatter", () => {
  it("skips a line the log repeats, preferring the one-off diagnostic", () => {
    const text = `${AUDIO_CHATTER}\nrynx-codegen: layout drift -- aborting\n${AUDIO_CHATTER}`;
    expect(lastMeaningfulErrorLine(text)).toBe("rynx-codegen: layout drift -- aborting");
  });

  it("falls back to chatter when the log holds nothing else err-ish", () => {
    expect(lastMeaningfulErrorLine(AUDIO_CHATTER)).toBe(
      "failed to close audio stream: Invalid stream pointer",
    );
  });
});

describe("failureExcerpt", () => {
  it("a chatty stderr cannot evict stdout", () => {
    // 34 KB of stderr noise vs a 4 KB cap: concatenate-then-tail kept ZERO
    // stdout, so the stored excerpt could not show which tests failed.
    const out = failureExcerpt(CATCH2_RED, AUDIO_CHATTER, 4096);
    expect(out).toContain("test_weapon_definition_matrix.cpp(307)");
    expect(out).toContain("failed to close audio stream");
    expect(out.length).toBeLessThan(4400);
  });

  it("gives the whole cap to the only stream that has content", () => {
    expect(failureExcerpt("", "just stderr", 4096)).toBe("just stderr");
    expect(failureExcerpt("just stdout", "", 4096)).toBe("just stdout");
  });
});
