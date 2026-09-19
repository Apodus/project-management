/**
 * Which code is this daemon actually running?
 *
 * On 2026-09-19 the answer was nearly wrong in the worst way. A bundle had
 * landed on main, the daemon was restarted, and every available signal reported
 * success — a new pid, health ALIVE, fresh heartbeats, "Integrator ready", both
 * resolver pools up. None of those distinguishes new code from old, and the
 * daemon loads its bundle from a checkout that happened to be 49 commits behind,
 * so the restart would have come back on the OLD bundle and been reported as a
 * deployment.
 *
 * It was caught by a two-part manual check: hash the file on disk against the
 * landed blob, and compare the process start time to the file's mtime. That
 * check works. But it is a PROCEDURE — it has to be remembered, by the right
 * person, at the right moment — and it produced the right answer only because
 * the instruction happened to be worded "verify it came up on the NEW bundle,
 * not merely that it came up". A procedure that depends on the wording of a
 * message is not a property.
 *
 * This makes it a property. The daemon reads its own entry file at startup and
 * reports what it loaded, so "which code is the train running" is answerable
 * from a log line by anyone, later, without access to the deploying session's
 * reasoning or even to the machine.
 *
 * BOTH FIELDS EARN THEIR PLACE. The hash says WHICH code. The mtime says
 * whether the file has been REPLACED since this process loaded it — which a
 * hash alone cannot tell you, because the hash describes the bytes in memory
 * and says nothing about the bytes now on disk. A daemon whose reported mtime
 * is older than the file beside it is visibly due for a restart. That is the
 * second half of the two-part check, self-served.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export interface BundleIdentity {
  /** Absolute path of the entry file this process was started from. */
  path: string;
  /** sha256 of that file's bytes as loaded, or null if it could not be read. */
  sha256: string | null;
  /** First 8 hex characters of the sha256 — enough to distinguish deployments. */
  shortSha: string | null;
  /** The file's mtime when this process read it, ISO-8601, or null. */
  mtime: string | null;
}

/**
 * Describe the file this process is running from. Never throws: a daemon must
 * not fail to start because it could not introspect itself, and "unknown" is an
 * honest answer that a reader can act on. Silence is not — which is the whole
 * complaint against the `Version: 0.1.0` this replaces.
 */
export function describeRunningBundle(entryPath: string): BundleIdentity {
  try {
    const sha256 = createHash("sha256").update(readFileSync(entryPath)).digest("hex");
    return {
      path: entryPath,
      sha256,
      shortSha: sha256.slice(0, 8),
      mtime: statSync(entryPath).mtime.toISOString(),
    };
  } catch {
    return { path: entryPath, sha256: null, shortSha: null, mtime: null };
  }
}

/**
 * The string reported as the heartbeat's `version`, and rendered by
 * `pm_get_integrator_health` as `Version: ...`.
 *
 * `0.1.0` alone was WORSE THAN ABSENT. It was `0.1.0` on the bundle that graded
 * five aborted verifies as passes, and it is `0.1.0` now; it cannot distinguish
 * two bundles, and its presence made the health output LOOK like it answered
 * the question it could not answer. A field that reads as an answer and is not
 * one is the specific failure this whole line of work has been about.
 *
 * The package version is kept — it is still the right thing for a human
 * comparing releases — and the build identity is appended, so the existing
 * string field carries both. Deliberately NOT a new heartbeat field: the
 * running server validates heartbeats against a schema that strips keys it does
 * not know, so a new field would be silently dropped until the server is
 * rebuilt and restarted. Silently dropped is exactly the failure mode being
 * repaired here, and it would have been invisible in the same way.
 */
export function versionWithBundle(packageVersion: string, bundle: BundleIdentity): string {
  return bundle.shortSha === null ? packageVersion : `${packageVersion}+${bundle.shortSha}`;
}
