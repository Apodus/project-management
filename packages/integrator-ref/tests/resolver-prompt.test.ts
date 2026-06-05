import { describe, it, expect } from "vitest";
import { DEFAULT_RESOLVER_PROMPT } from "@pm/shared";
import { buildReconcilePrompt } from "../src/resolver-runner.js";

describe("buildReconcilePrompt (Phase 7.6 — resolver.prompt override)", () => {
  it("substitutes {files} and {verify_command} in the default prompt", () => {
    const out = buildReconcilePrompt(DEFAULT_RESOLVER_PROMPT, ["a.ts", "b.ts"], "pnpm test");
    expect(out).toContain("a.ts, b.ts");
    expect(out).toContain("pnpm test");
    expect(out).not.toContain("{files}");
    expect(out).not.toContain("{verify_command}");
  });

  it("includes the status-file + full-verify in-session instructions (Phase 7.6.1)", () => {
    const out = buildReconcilePrompt(DEFAULT_RESOLVER_PROMPT, ["a.ts", "b.ts"], "pnpm test");
    // The agent owns the verify loop and declares via the status sentinel file.
    expect(out).toContain("PM_RESOLUTION_STATUS_PATH");
    expect(out).toMatch(/full[\s\S]*suite/i);
  });

  it("uses a placeholder for an empty conflicting-files list", () => {
    const out = buildReconcilePrompt(DEFAULT_RESOLVER_PROMPT, [], "v");
    expect(out).toContain("conflict markers in this worktree");
    expect(out).not.toContain("{files}");
  });

  it("honors a custom template (override) and substitutes its placeholders", () => {
    const custom = "Fix {files} then run {verify_command}. Be terse.";
    const out = buildReconcilePrompt(custom, ["x.rs"], "cargo test");
    expect(out).toBe("Fix x.rs then run cargo test. Be terse.");
  });

  it("leaves a custom template that omits placeholders untouched", () => {
    const custom = "Just resolve the conflict.";
    expect(buildReconcilePrompt(custom, ["x"], "v")).toBe(custom);
  });
});
