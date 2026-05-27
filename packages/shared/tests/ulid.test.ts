import { describe, it, expect } from "vitest";
import { createId, createMonotonicId, ulidSchema } from "../src/index.js";

describe("createId", () => {
  it("returns a 26-character string", () => {
    const id = createId();
    expect(id).toHaveLength(26);
  });

  it("returns a valid ULID format", () => {
    const id = createId();
    expect(() => ulidSchema.parse(id)).not.toThrow();
  });

  it("generates unique values", () => {
    const ids = new Set(Array.from({ length: 100 }, () => createId()));
    expect(ids.size).toBe(100);
  });
});

describe("createMonotonicId", () => {
  it("returns a 26-character string", () => {
    const id = createMonotonicId();
    expect(id).toHaveLength(26);
  });

  it("returns a valid ULID format", () => {
    const id = createMonotonicId();
    expect(() => ulidSchema.parse(id)).not.toThrow();
  });

  it("generates unique values", () => {
    const ids = new Set(Array.from({ length: 100 }, () => createMonotonicId()));
    expect(ids.size).toBe(100);
  });

  it("generates monotonically increasing values", () => {
    const ids = Array.from({ length: 50 }, () => createMonotonicId());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });
});
