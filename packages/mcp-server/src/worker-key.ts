/**
 * The caller's stable worker identity key, read from PM_WORKER_KEY.
 *
 * Used by the C2 escalation delivery surfaces (pm_check_messages drain +
 * the response piggyback) to identify WHICH worker the directed replies are
 * addressed to. Trimmed; an empty/whitespace value reads as undefined (no key
 * ⇒ the surfaces short-circuit, byte-identical to before).
 *
 * The inline reads in index.ts / api-client.ts (claim/release lifecycle) are
 * intentionally left untouched.
 */
export function getWorkerKey(): string | undefined {
  return process.env.PM_WORKER_KEY?.trim() || undefined;
}
