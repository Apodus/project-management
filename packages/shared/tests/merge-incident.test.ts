import { describe, it, expect } from "vitest";
import {
  MERGE_INCIDENT_STATES,
  MERGE_INCIDENT_TYPES,
  mergeIncidentSchema,
  mergeIncidentResolutionSchema,
} from "../src/index.js";

const VALID_ULID = "01H5K3RCH3EABY3V5SXGM7N1WQ";
const VALID_TIMESTAMP = "2026-05-27T12:00:00.000Z";

// ─── Enum constants ───────────────────────────────────────────────

describe("MERGE_INCIDENT_STATES", () => {
  it("contains exactly the canonical values in canonical order", () => {
    expect([...MERGE_INCIDENT_STATES]).toEqual(["open", "auto_resolved", "human_resolved"]);
  });

  it("starts with 'open' (the DB column default)", () => {
    expect(MERGE_INCIDENT_STATES[0]).toBe("open");
  });
});

describe("MERGE_INCIDENT_TYPES", () => {
  it("contains exactly the canonical values in canonical order", () => {
    expect([...MERGE_INCIDENT_TYPES]).toEqual(["orphaned_inner"]);
  });
});

// ─── mergeIncidentResolutionSchema ────────────────────────────────

describe("mergeIncidentResolutionSchema", () => {
  it("accepts an auto_rollforward resolution with outerLandedSha + resolvedByGroupId", () => {
    const body = {
      mode: "auto_rollforward" as const,
      outerLandedSha: "def456",
      resolvedByGroupId: VALID_ULID,
    };
    expect(mergeIncidentResolutionSchema.parse(body)).toEqual(body);
  });

  it("accepts a human resolution with a note", () => {
    const body = { mode: "human" as const, note: "resolved manually by op" };
    expect(mergeIncidentResolutionSchema.parse(body)).toEqual(body);
  });

  it("accepts a bare mode with no optional fields", () => {
    expect(mergeIncidentResolutionSchema.parse({ mode: "human" })).toBeTruthy();
  });

  it("rejects an unknown mode", () => {
    expect(() => mergeIncidentResolutionSchema.parse({ mode: "magic" })).toThrow();
  });

  it("rejects a missing mode", () => {
    expect(() => mergeIncidentResolutionSchema.parse({ note: "no mode" })).toThrow();
  });
});

// ─── mergeIncidentSchema ──────────────────────────────────────────

describe("mergeIncidentSchema", () => {
  const validIncident = {
    id: VALID_ULID,
    projectId: VALID_ULID,
    groupId: VALID_ULID,
    type: "orphaned_inner" as const,
    innerRepo: "core",
    orphanedSha: "abc123",
    outerRepo: "app",
    innerRequestId: VALID_ULID,
    taskId: VALID_ULID,
    state: "open" as const,
    openedAt: VALID_TIMESTAMP,
    resolvedAt: null,
    resolution: null,
    createdAt: VALID_TIMESTAMP,
    updatedAt: VALID_TIMESTAMP,
  };

  it("accepts a valid open incident", () => {
    expect(mergeIncidentSchema.parse(validIncident)).toEqual(validIncident);
  });

  it("accepts an open incident with nullable refs null", () => {
    const nulled = {
      ...validIncident,
      groupId: null,
      innerRequestId: null,
      taskId: null,
    };
    expect(mergeIncidentSchema.parse(nulled)).toBeTruthy();
  });

  it("accepts an auto_resolved incident with resolution populated", () => {
    const resolved = {
      ...validIncident,
      state: "auto_resolved" as const,
      resolvedAt: VALID_TIMESTAMP,
      resolution: {
        mode: "auto_rollforward" as const,
        outerLandedSha: "def456",
        resolvedByGroupId: VALID_ULID,
      },
    };
    expect(mergeIncidentSchema.parse(resolved)).toBeTruthy();
  });

  it("accepts a human_resolved incident with a human resolution", () => {
    const resolved = {
      ...validIncident,
      state: "human_resolved" as const,
      resolvedAt: VALID_TIMESTAMP,
      resolution: { mode: "human" as const, note: "fixed by op" },
    };
    expect(mergeIncidentSchema.parse(resolved)).toBeTruthy();
  });

  it("accepts all valid states", () => {
    for (const state of MERGE_INCIDENT_STATES) {
      expect(mergeIncidentSchema.parse({ ...validIncident, state })).toBeTruthy();
    }
  });

  it("rejects unknown state", () => {
    expect(() => mergeIncidentSchema.parse({ ...validIncident, state: "closed" })).toThrow();
  });

  it("rejects unknown type", () => {
    expect(() => mergeIncidentSchema.parse({ ...validIncident, type: "orphaned_outer" })).toThrow();
  });

  it("rejects a malformed resolution (unknown mode)", () => {
    expect(() =>
      mergeIncidentSchema.parse({
        ...validIncident,
        resolution: { mode: "magic" },
      }),
    ).toThrow();
  });

  it("rejects missing projectId", () => {
    const { projectId: _, ...i } = validIncident;
    expect(() => mergeIncidentSchema.parse(i)).toThrow();
  });

  it("rejects missing orphanedSha", () => {
    const { orphanedSha: _, ...i } = validIncident;
    expect(() => mergeIncidentSchema.parse(i)).toThrow();
  });

  it("rejects missing innerRepo", () => {
    const { innerRepo: _, ...i } = validIncident;
    expect(() => mergeIncidentSchema.parse(i)).toThrow();
  });
});
