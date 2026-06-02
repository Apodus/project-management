import { describe, it, expect } from "vitest";
import {
  selectEpicDependencySchema,
  insertEpicDependencySchema,
  epicGraphSchema,
} from "../src/index.js";

const VALID_ULID = "01H5K3RCH3EABY3V5SXGM7N1WQ";
const VALID_ULID_2 = "01H5K3RCH3EABY3V5SXGM7N1WR";
const VALID_TIMESTAMP = "2026-05-27T12:00:00.000Z";

// ─── selectEpicDependencySchema ───────────────────────────────────

describe("selectEpicDependencySchema", () => {
  const validRow = {
    id: VALID_ULID,
    project_id: VALID_ULID,
    epic_id: VALID_ULID,
    depends_on_epic_id: VALID_ULID_2,
    dependency_type: "blocks" as const,
    created_at: VALID_TIMESTAMP,
    created_by: VALID_ULID,
  };

  it("round-trips a full valid row", () => {
    expect(selectEpicDependencySchema.parse(validRow)).toEqual(validRow);
  });

  it("accepts both dependency types", () => {
    for (const dependency_type of ["blocks", "relates_to"] as const) {
      expect(selectEpicDependencySchema.parse({ ...validRow, dependency_type })).toBeTruthy();
    }
  });

  it("rejects an unknown dependency_type", () => {
    expect(() =>
      selectEpicDependencySchema.parse({
        ...validRow,
        dependency_type: "follows",
      }),
    ).toThrow();
  });

  it("rejects a non-ULID epic_id", () => {
    expect(() =>
      selectEpicDependencySchema.parse({ ...validRow, epic_id: "not-a-ulid" }),
    ).toThrow();
  });

  it("rejects a missing project_id", () => {
    const { project_id: _, ...row } = validRow;
    expect(() => selectEpicDependencySchema.parse(row)).toThrow();
  });

  it("rejects a missing created_by (required in Zod, per selectEpicSchema precedent)", () => {
    const { created_by: _, ...row } = validRow;
    expect(() => selectEpicDependencySchema.parse(row)).toThrow();
  });
});

// ─── insertEpicDependencySchema ───────────────────────────────────

describe("insertEpicDependencySchema", () => {
  it("parses a body without id/created_at", () => {
    const body = {
      project_id: VALID_ULID,
      epic_id: VALID_ULID,
      depends_on_epic_id: VALID_ULID_2,
      dependency_type: "blocks" as const,
      created_by: VALID_ULID,
    };
    expect(insertEpicDependencySchema.parse(body)).toEqual(body);
  });
});

// ─── epicGraphSchema ──────────────────────────────────────────────

describe("epicGraphSchema", () => {
  // The finalized P4 contract makes enrichment REQUIRED — getGraph always emits
  // health/activity_recency/time_window. This valid node carries all three so the
  // provenance/taskSummary rejection tests below isolate their INTENDED defect.
  const validNode = {
    id: VALID_ULID,
    project_id: VALID_ULID,
    name: "Epic One",
    status: "active",
    priority: "medium",
    created_at: VALID_TIMESTAMP,
    updated_at: VALID_TIMESTAMP,
    taskSummary: { total: 3, done: 1, byStatus: { backlog: 2, done: 1 } },
    health: "on_track" as const,
    activity_recency: VALID_TIMESTAMP,
    time_window: { start: VALID_TIMESTAMP, end: null },
  };

  it("rejects an enrichment-omitted node (P4 contract is finalized & required)", () => {
    const {
      health: _h,
      activity_recency: _a,
      time_window: _t,
      ...nodeWithoutEnrichment
    } = validNode;
    const payload = {
      nodes: [nodeWithoutEnrichment],
      edges: [
        {
          from: VALID_ULID_2,
          to: VALID_ULID,
          dependency_type: "blocks" as const,
          provenance: "derived" as const,
        },
      ],
      hasCycle: false,
    };
    expect(() => epicGraphSchema.parse(payload)).toThrow();
  });

  it("succeeds on a full payload with enrichment + cycles (P4 forward-compat)", () => {
    const payload = {
      nodes: [
        {
          ...validNode,
          target_date: VALID_TIMESTAMP,
          health: "on_track",
          activity_recency: VALID_TIMESTAMP,
          time_window: { start: VALID_TIMESTAMP, end: null },
        },
      ],
      edges: [
        {
          from: VALID_ULID_2,
          to: VALID_ULID,
          dependency_type: "relates_to" as const,
          provenance: "explicit" as const,
        },
      ],
      hasCycle: true,
      cycles: [[VALID_ULID, VALID_ULID_2]],
    };
    expect(epicGraphSchema.parse(payload)).toBeTruthy();
  });

  it("rejects an edge with unknown provenance", () => {
    const payload = {
      nodes: [validNode],
      edges: [
        {
          from: VALID_ULID_2,
          to: VALID_ULID,
          dependency_type: "blocks" as const,
          provenance: "guessed",
        },
      ],
      hasCycle: false,
    };
    expect(() => epicGraphSchema.parse(payload)).toThrow();
  });

  it("rejects a node missing taskSummary", () => {
    const { taskSummary: _, ...nodeNoSummary } = validNode;
    const payload = {
      nodes: [nodeNoSummary],
      edges: [],
      hasCycle: false,
    };
    expect(() => epicGraphSchema.parse(payload)).toThrow();
  });
});
