import { describe, expect, it } from "vitest";
import { categorize, type CategorizeInput } from "../src/categorize.js";

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
    expect(categorize(input({ exitCode: 1, signal: "SIGTERM" })).category).toBe(
      "verify_timeout",
    );
  });

  it("verify_timeout — SIGKILL signal", () => {
    expect(categorize(input({ exitCode: 1, signal: "SIGKILL" })).category).toBe(
      "verify_timeout",
    );
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
    expect(r.failedFiles).toEqual([
      "crates/renderer/src/skinned.rs",
      "crates/renderer/src/lib.rs",
    ]);
    expect(r.reason).toContain("error[E0599]");
  });

  it("build_failed — error: could not compile", () => {
    const stderr = "error: aborting due to previous error\nerror: could not compile `renderer`";
    const r = categorize(input({ exitCode: 101, stderr }));
    expect(r.category).toBe("build_failed");
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
    const stdout = "/src/foo.ts\n  1:1  error  Unexpected console statement  no-console\n\n1 problem\neslint found errors";
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

  it("build_failed takes precedence over plain non-zero exit", () => {
    const r = categorize(input({ exitCode: 1, stderr: "error[E0001]: x\n  --> a.rs:1:1" }));
    expect(r.category).toBe("build_failed");
  });
});
