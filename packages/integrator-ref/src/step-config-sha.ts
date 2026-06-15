/**
 * Phase 7.5 Step 6 — the `step_config_sha` computation (design §3.3).
 *
 * A SHA-256 hex digest over a step's VERDICT-AFFECTING config: the exact shell
 * `command` plus the operator-declared out-of-tree `cache_key_inputs`. This is
 * the `step_config_sha` component of the strict cache key (§3.2) — ANY change to
 * the command or a declared input re-hashes to a different digest → a cache MISS.
 *
 * Byte-for-byte per design §3.3:
 *  - the canonical JSON has a FIXED key order `{ command, cache_key_inputs }`,
 *  - `cache_key_inputs` is sorted ASCENDING so declaration order is irrelevant,
 *  - `JSON.stringify` is called with NO spacer (no whitespace),
 *  - `depends_on` / `timeout_sec` / `id` / `tree_sha` are EXCLUDED (a step's
 *    pass/fail does not change because its predecessor, timeout, id, or tree
 *    changed — those are not verdict-for-a-fixed-tree properties; the tree_sha
 *    is a SEPARATE key component, §3.2).
 *
 * Pure + standalone so it is unit-testable in isolation.
 */
import { createHash } from "node:crypto";

export function stepConfigSha(step: { command: string; cache_key_inputs?: string[] }): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        command: step.command,
        cache_key_inputs: [...(step.cache_key_inputs ?? [])].sort(),
      }),
    )
    .digest("hex");
}
