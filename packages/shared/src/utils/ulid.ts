import { ulid, monotonicFactory } from "ulid";

/**
 * Generate a new ULID.
 * Suitable for standard single-entity creation.
 */
export function createId(): string {
  return ulid();
}

/**
 * Cached monotonic factory for generating ULIDs in batch operations.
 * Guarantees strict ordering even when called within the same millisecond.
 */
const monotonicUlid = monotonicFactory();

/**
 * Generate a monotonically increasing ULID.
 * Use for batch operations where ordering within the same millisecond matters.
 */
export function createMonotonicId(): string {
  return monotonicUlid();
}
