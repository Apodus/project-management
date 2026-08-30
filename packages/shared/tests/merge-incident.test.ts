import { describe, it, expect } from "vitest";
import {
  MERGE_INCIDENT_STATES,
  MERGE_INCIDENT_TYPES,
  MERGE_INCIDENT_TYPE_INFO,
  MERGE_INCIDENT_RESOLUTION_MODES,
  mergeIncidentTypeInfo,
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
    expect([...MERGE_INCIDENT_TYPES]).toEqual(["orphaned_inner", "dangling_gitlink"]);
  });
});

// ─── MERGE_INCIDENT_TYPE_INFO ─────────────────────────────────────

describe("MERGE_INCIDENT_TYPE_INFO", () => {
  it("describes every declared incident type and nothing else", () => {
    // The Record<MergeIncidentType, _> makes an omission a compile error; this
    // catches a loosely-typed record that dodges that check at runtime.
    expect(Object.keys(MERGE_INCIDENT_TYPE_INFO).sort()).toEqual([...MERGE_INCIDENT_TYPES].sort());
  });

  it("gives every type a direction (design lock 6)", () => {
    for (const type of MERGE_INCIDENT_TYPES) {
      expect(["inner_ahead_of_outer", "outer_ahead_of_inner"]).toContain(
        MERGE_INCIDENT_TYPE_INFO[type].direction,
      );
    }
  });

  it("every summary() is self-identifying — it starts with `${label}: `", () => {
    for (const type of MERGE_INCIDENT_TYPES) {
      const info = MERGE_INCIDENT_TYPE_INFO[type];
      const line = info.summary({ innerRepo: "core", outerRepo: "shell", sha: "abc123" });
      expect(line.startsWith(`${info.label}: `)).toBe(true);
      expect(line).toContain("abc123");
    }
  });

  it("states the two directions in opposite order", () => {
    expect(MERGE_INCIDENT_TYPE_INFO.orphaned_inner.direction).toBe("inner_ahead_of_outer");
    expect(MERGE_INCIDENT_TYPE_INFO.dangling_gitlink.direction).toBe("outer_ahead_of_inner");
  });

  it("dangling_gitlink is cured by a human, never by the train (design lock 2)", () => {
    expect(MERGE_INCIDENT_TYPE_INFO.dangling_gitlink.curedBy).toBe("human");
    expect(MERGE_INCIDENT_TYPE_INFO.orphaned_inner.curedBy).toBe("train");
  });

  it("no descriptor string exonerates, blames or prescribes a cure (design lock 3)", () => {
    for (const type of MERGE_INCIDENT_TYPES) {
      const info = MERGE_INCIDENT_TYPE_INFO[type];
      const text = `${info.summary({ innerRepo: "core", outerRepo: "shell", sha: "abc123" })} ${info.shaMeaning}`;
      expect(text).not.toMatch(/not (a|in) (defect|the change|your)/i);
      expect(text).not.toMatch(/defect in the train/i);
    }
  });
});

describe("mergeIncidentTypeInfo", () => {
  it("resolves a known type from a plain string (the DB row shape)", () => {
    expect(mergeIncidentTypeInfo("dangling_gitlink")?.label).toBe("Dangling gitlink");
    expect(mergeIncidentTypeInfo("orphaned_inner")?.direction).toBe("inner_ahead_of_outer");
  });

  it("returns undefined for an unrecognized type rather than guessing", () => {
    expect(mergeIncidentTypeInfo("orphaned_outer")).toBeUndefined();
    expect(mergeIncidentTypeInfo("")).toBeUndefined();
  });

  it("does not resolve inherited Object.prototype keys", () => {
    expect(mergeIncidentTypeInfo("toString")).toBeUndefined();
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

  it("accepts the observed-cure mode (the train saw it, did not apply it)", () => {
    const body = { mode: "auto_observed" as const, note: "invariant holds again" };
    expect(mergeIncidentResolutionSchema.parse(body)).toEqual(body);
  });

  it("accepts every declared resolution mode", () => {
    for (const mode of MERGE_INCIDENT_RESOLUTION_MODES) {
      expect(mergeIncidentResolutionSchema.parse({ mode })).toBeTruthy();
    }
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
