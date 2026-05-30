import { describe, it, expect } from "vitest";
import { TRAIN_STATES, trainStateSchema } from "../src/index.js";

const VALID_ULID = "01H5K3RCH3EABY3V5SXGM7N1WQ";
const VALID_TIMESTAMP = "2026-05-30T12:00:00.000Z";

// ─── Enum constants ───────────────────────────────────────────────

describe("TRAIN_STATES", () => {
  it("contains exactly the canonical values in canonical order", () => {
    expect([...TRAIN_STATES]).toEqual(["running", "paused"]);
  });

  it("starts with 'running' (the DB column default)", () => {
    expect(TRAIN_STATES[0]).toBe("running");
  });
});

// ─── trainStateSchema ─────────────────────────────────────────────

describe("trainStateSchema", () => {
  const runningRow = {
    id: VALID_ULID,
    projectId: VALID_ULID,
    resource: "main",
    state: "running" as const,
    changedBy: null,
    reason: null,
    changedAt: null,
    createdAt: VALID_TIMESTAMP,
    updatedAt: VALID_TIMESTAMP,
  };

  it("accepts a fresh running lane (null change fields)", () => {
    expect(trainStateSchema.parse(runningRow)).toEqual(runningRow);
  });

  it("accepts a paused lane with changedBy/reason/changedAt", () => {
    const paused = {
      ...runningRow,
      state: "paused" as const,
      changedBy: VALID_ULID,
      reason: "draining for a deploy",
      changedAt: VALID_TIMESTAMP,
    };
    expect(trainStateSchema.parse(paused)).toBeTruthy();
  });

  it("accepts both valid states", () => {
    for (const state of TRAIN_STATES) {
      expect(trainStateSchema.parse({ ...runningRow, state })).toBeTruthy();
    }
  });

  it("rejects an unknown state", () => {
    expect(() =>
      trainStateSchema.parse({ ...runningRow, state: "stopped" }),
    ).toThrow();
  });

  it("rejects a missing resource", () => {
    const { resource: _omit, ...row } = runningRow;
    expect(() => trainStateSchema.parse(row)).toThrow();
  });
});
