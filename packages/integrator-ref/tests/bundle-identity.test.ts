/**
 * The daemon must be able to say which code it is running.
 *
 * These tests exist because on 2026-09-19 a restart would have come back on a
 * bundle 49 commits stale and reported success: new pid, health ALIVE, fresh
 * heartbeats, "Integrator ready". Every signal the daemon emitted was true and
 * none of them answered the question.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeRunningBundle, versionWithBundle } from "../src/bundle-identity.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bundle-identity-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("describeRunningBundle", () => {
  it("reports the sha256 of the bytes it read", () => {
    const p = join(workDir, "bundle.mjs");
    writeFileSync(p, "console.log('a');");
    const expected = createHash("sha256").update("console.log('a');").digest("hex");

    const got = describeRunningBundle(p);

    expect(got.sha256).toBe(expected);
    expect(got.shortSha).toBe(expected.slice(0, 8));
    expect(got.path).toBe(p);
  });

  it("DISTINGUISHES two bundles — the whole point, and what `Version: 0.1.0` could not do", () => {
    const a = join(workDir, "a.mjs");
    const b = join(workDir, "b.mjs");
    writeFileSync(a, "OLD BUNDLE");
    writeFileSync(b, "NEW BUNDLE");

    expect(describeRunningBundle(a).shortSha).not.toBe(describeRunningBundle(b).shortSha);
  });

  it("reports the file's mtime, so a replaced-since-load file is detectable", () => {
    const p = join(workDir, "bundle.mjs");
    writeFileSync(p, "v1");
    const loaded = describeRunningBundle(p);

    // The deployment case: the file on disk is replaced while the daemon keeps
    // running the bytes it loaded. The hash in hand still describes the OLD
    // bytes — only the mtime comparison reveals a restart is due.
    const later = new Date(statSync(p).mtime.getTime() + 60_000);
    writeFileSync(p, "v2");
    utimesSync(p, later, later);

    const onDisk = statSync(p).mtime.toISOString();
    expect(loaded.mtime).not.toBe(onDisk);
    expect(new Date(onDisk).getTime()).toBeGreaterThan(new Date(loaded.mtime!).getTime());
  });

  it("never throws on an unreadable path — a daemon must not fail to start introspecting itself", () => {
    const got = describeRunningBundle(join(workDir, "does-not-exist.mjs"));
    expect(got.sha256).toBeNull();
    expect(got.shortSha).toBeNull();
    expect(got.mtime).toBeNull();
  });
});

describe("versionWithBundle", () => {
  it("appends the build identity to the package version", () => {
    const p = join(workDir, "bundle.mjs");
    writeFileSync(p, "x");
    const bundle = describeRunningBundle(p);

    expect(versionWithBundle("0.1.0", bundle)).toBe(`0.1.0+${bundle.shortSha}`);
  });

  it("two bundles of the SAME package version report different strings", () => {
    const a = join(workDir, "a.mjs");
    const b = join(workDir, "b.mjs");
    writeFileSync(a, "OLD BUNDLE");
    writeFileSync(b, "NEW BUNDLE");

    // This is the regression under test. Before this change both of these were
    // "0.1.0", so health could not tell the bundle that graded five aborted
    // verifies as passes from the one that fixed it.
    expect(versionWithBundle("0.1.0", describeRunningBundle(a))).not.toBe(
      versionWithBundle("0.1.0", describeRunningBundle(b)),
    );
  });

  it("degrades to the bare package version when the bundle cannot be read", () => {
    const bundle = describeRunningBundle(join(workDir, "missing.mjs"));
    expect(versionWithBundle("0.1.0", bundle)).toBe("0.1.0");
  });

  it("stays a plain non-empty string, which is all the heartbeat schema accepts", () => {
    const p = join(workDir, "bundle.mjs");
    writeFileSync(p, "x");
    const v = versionWithBundle("0.1.0", describeRunningBundle(p));

    // Carried in the EXISTING `version` field on purpose: the running server
    // validates heartbeats against a schema that strips keys it does not know,
    // so a new field would be silently dropped until the server is rebuilt and
    // restarted — the same silent-drop failure this work exists to repair.
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
  });
});
