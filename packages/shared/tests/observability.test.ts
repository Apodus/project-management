import { describe, it, expect } from "vitest";
import {
  integratorHeartbeatSchema,
  integratorHealthView,
  metricsBundleSchema,
  inFlightBundleSchema,
  sloBlockSchema,
  sloDimensionSchema,
  timelineSchema,
} from "../src/index.js";

const VALID_ULID = "01H5K3RCH3EABY3V5SXGM7N1WQ";
const VALID_TIMESTAMP = "2026-05-30T12:00:00.000Z";

// ─── integratorHeartbeatSchema (§3.2) ─────────────────────────────

describe("integratorHeartbeatSchema", () => {
  it("accepts a full heartbeat", () => {
    const body = {
      resource: "main",
      status: "idle" as const,
      pool_utilization: { size: 3, leased: 1 },
      in_flight: { requests: 1, batches: 1, groups: 0 },
      version: "0.0.0",
    };
    expect(integratorHeartbeatSchema.parse(body)).toEqual(body);
  });

  it("defaults resource to main + in_flight to all-zero when omitted", () => {
    const parsed = integratorHeartbeatSchema.parse({
      status: "integrating",
      pool_utilization: { size: 2, leased: 2 },
      version: "1.2.3",
    });
    expect(parsed.resource).toBe("main");
    expect(parsed.in_flight).toEqual({ requests: 0, batches: 0, groups: 0 });
  });

  it("rejects an unknown status", () => {
    expect(() =>
      integratorHeartbeatSchema.parse({
        status: "busy",
        pool_utilization: { size: 1, leased: 0 },
        version: "0.0.0",
      }),
    ).toThrow();
  });

  it("rejects a missing version", () => {
    expect(() =>
      integratorHeartbeatSchema.parse({
        status: "idle",
        pool_utilization: { size: 1, leased: 0 },
      }),
    ).toThrow();
  });

  it("rejects a missing pool_utilization", () => {
    expect(() =>
      integratorHeartbeatSchema.parse({ status: "idle", version: "0.0.0" }),
    ).toThrow();
  });

  // ── last_release_failure (C2): TRI-STATE on the wire ─────────────

  it("last_release_failure ABSENT (old integrator) → parses, key undefined", () => {
    const parsed = integratorHeartbeatSchema.parse({
      status: "idle",
      pool_utilization: { size: 1, leased: 0 },
      version: "0.0.0",
    });
    expect(parsed.last_release_failure).toBeUndefined();
  });

  it("last_release_failure explicit NULL (the clear signal) → preserved as null", () => {
    const parsed = integratorHeartbeatSchema.parse({
      status: "idle",
      pool_utilization: { size: 1, leased: 0 },
      version: "0.0.0",
      last_release_failure: null,
    });
    expect(parsed.last_release_failure).toBeNull();
  });

  it("last_release_failure { at, message } → accepted; malformed → rejected", () => {
    const parsed = integratorHeartbeatSchema.parse({
      status: "idle",
      pool_utilization: { size: 1, leased: 0 },
      version: "0.0.0",
      last_release_failure: { at: VALID_TIMESTAMP, message: "HTTP 500" },
    });
    expect(parsed.last_release_failure).toEqual({
      at: VALID_TIMESTAMP,
      message: "HTTP 500",
    });

    expect(() =>
      integratorHeartbeatSchema.parse({
        status: "idle",
        pool_utilization: { size: 1, leased: 0 },
        version: "0.0.0",
        last_release_failure: { message: "missing at" },
      }),
    ).toThrow();
  });
});

// ─── integratorHealthView (§3.4) ──────────────────────────────────

describe("integratorHealthView", () => {
  it("accepts a healthy lane view", () => {
    const view = {
      resource: "main",
      status: "idle",
      healthy: true,
      last_seen_at: VALID_TIMESTAMP,
      staleness_ms: 12000,
      pool_size: 3,
      pool_leased: 1,
      in_flight_requests: 0,
      in_flight_batches: 0,
      in_flight_groups: 0,
      version: "0.0.0",
      integrator_id: VALID_ULID,
      last_release_failure: null,
    };
    expect(integratorHealthView.parse(view)).toEqual(view);
  });

  it("accepts a recorded last_release_failure (C2)", () => {
    const view = {
      resource: "main",
      status: "idle",
      healthy: true,
      last_seen_at: VALID_TIMESTAMP,
      staleness_ms: 12000,
      pool_size: 3,
      pool_leased: 1,
      in_flight_requests: 0,
      in_flight_batches: 0,
      in_flight_groups: 0,
      version: "0.0.0",
      integrator_id: VALID_ULID,
      last_release_failure: { at: VALID_TIMESTAMP, message: "HTTP 500" },
    };
    expect(integratorHealthView.parse(view)).toEqual(view);
  });

  it("accepts a never_seen view (nulls)", () => {
    const view = {
      resource: "main",
      status: "never_seen",
      healthy: false,
      last_seen_at: null,
      staleness_ms: null,
      pool_size: null,
      pool_leased: null,
      in_flight_requests: 0,
      in_flight_batches: 0,
      in_flight_groups: 0,
      version: null,
      integrator_id: null,
      last_release_failure: null,
    };
    expect(integratorHealthView.parse(view)).toBeTruthy();
  });

  it("rejects a non-boolean healthy", () => {
    expect(() =>
      integratorHealthView.parse({
        resource: "main",
        status: "idle",
        healthy: "yes",
        last_seen_at: null,
        staleness_ms: null,
        pool_size: null,
        pool_leased: null,
        in_flight_requests: 0,
        in_flight_batches: 0,
        in_flight_groups: 0,
        version: null,
        integrator_id: null,
        last_release_failure: null,
      }),
    ).toThrow();
  });
});

// ─── SLO blocks (§6.2) ────────────────────────────────────────────

describe("sloDimensionSchema / sloBlockSchema", () => {
  it("accepts a time-to-land dimension", () => {
    expect(
      sloDimensionSchema.parse({
        target_sec: 600,
        measured_ms: 720000,
        compliant: false,
      }),
    ).toBeTruthy();
  });

  it("accepts a rate dimension", () => {
    expect(
      sloDimensionSchema.parse({
        target: 0.9,
        measured: 0.92,
        compliant: true,
      }),
    ).toBeTruthy();
  });

  it("accepts a full slo block with overall null (no config)", () => {
    expect(sloBlockSchema.parse({ overall_compliant: null })).toBeTruthy();
  });

  it("accepts an slo block with all three dimensions", () => {
    expect(
      sloBlockSchema.parse({
        p95_time_to_land: { target_sec: 600, measured_ms: 720000, compliant: false },
        verify_success_rate: { target: 0.9, measured: 0.92, compliant: true },
        abandon_rate: { target: 0.1, measured: 0.04, compliant: true },
        overall_compliant: false,
      }),
    ).toBeTruthy();
  });

  it("rejects a dimension missing compliant", () => {
    expect(() => sloDimensionSchema.parse({ target: 0.9 })).toThrow();
  });
});

// ─── metricsBundleSchema (§5.6) ───────────────────────────────────

describe("metricsBundleSchema", () => {
  const validBundle = {
    resource: "main",
    queue_depth: 2,
    in_flight: 1,
    time_to_land: { p50_ms: 540000, p95_ms: 720000, p99_ms: 900000, sample_size: 14 },
    verify_success_rate: { ratio: 0.92, passed: 23, total: 25 },
    abandon_rate: { ratio: 0.04, abandoned: 1, resolved: 25 },
    pool_utilization: { size: 3, leased: 1, ratio: 0.33 },
    health: {
      resource: "main",
      status: "idle",
      healthy: true,
      last_seen_at: VALID_TIMESTAMP,
      staleness_ms: 12000,
      pool_size: 3,
      pool_leased: 1,
      in_flight_requests: 1,
      in_flight_batches: 1,
      in_flight_groups: 0,
      version: "0.0.0",
      integrator_id: VALID_ULID,
      last_release_failure: null,
    },
    slo: { overall_compliant: null },
    window_hours: 24,
    computed_at: VALID_TIMESTAMP,
  };

  it("accepts a full bundle", () => {
    expect(metricsBundleSchema.parse(validBundle)).toEqual(validBundle);
  });

  it("accepts null percentiles + null ratios (empty window)", () => {
    const empty = {
      ...validBundle,
      time_to_land: { p50_ms: null, p95_ms: null, p99_ms: null, sample_size: 0 },
      verify_success_rate: { ratio: null, passed: 0, total: 0 },
      abandon_rate: { ratio: null, abandoned: 0, resolved: 0 },
      pool_utilization: { size: null, leased: null, ratio: null },
    };
    expect(metricsBundleSchema.parse(empty)).toBeTruthy();
  });

  it("rejects a missing health block", () => {
    const { health: _omit, ...bundle } = validBundle;
    expect(() => metricsBundleSchema.parse(bundle)).toThrow();
  });

  it("rejects a string queue_depth", () => {
    expect(() =>
      metricsBundleSchema.parse({ ...validBundle, queue_depth: "2" }),
    ).toThrow();
  });
});

// ─── inFlightBundleSchema (§5.3) ──────────────────────────────────

describe("inFlightBundleSchema", () => {
  it("accepts an empty bundle", () => {
    expect(inFlightBundleSchema.parse({ groups: [], members: [] })).toEqual({
      groups: [],
      members: [],
    });
  });

  it("accepts members with + without an attempt and a group", () => {
    const bundle = {
      groups: [
        {
          id: VALID_ULID,
          project_id: VALID_ULID,
          resource: "main",
          state: "integrating",
          submitted_by: VALID_ULID,
          integrator_id: VALID_ULID,
          resolved_at: null,
          resolution_reason: null,
          created_at: VALID_TIMESTAMP,
          updated_at: VALID_TIMESTAMP,
        },
      ],
      members: [
        {
          id: VALID_ULID,
          group_id: VALID_ULID,
          status: "integrating",
          enqueued_at: VALID_TIMESTAMP,
          picked_up_at: VALID_TIMESTAMP,
          attempt: {
            status: "running",
            base_sha: "abc123",
            tree_sha: null,
            started_at: VALID_TIMESTAMP,
          },
        },
        {
          id: VALID_ULID,
          group_id: null,
          status: "integrating",
          enqueued_at: VALID_TIMESTAMP,
          picked_up_at: null,
          attempt: null,
        },
      ],
    };
    expect(inFlightBundleSchema.parse(bundle)).toBeTruthy();
  });

  it("rejects a member missing status", () => {
    expect(() =>
      inFlightBundleSchema.parse({
        groups: [],
        members: [
          {
            id: VALID_ULID,
            group_id: null,
            enqueued_at: VALID_TIMESTAMP,
            picked_up_at: null,
            attempt: null,
          },
        ],
      }),
    ).toThrow();
  });
});

// ─── timelineSchema (§8.3) ────────────────────────────────────────

describe("timelineSchema", () => {
  const request = {
    id: VALID_ULID,
    projectId: VALID_ULID,
    resource: "main",
    submittedBy: VALID_ULID,
    taskId: VALID_ULID,
    branch: "feature/x",
    commitSha: "abc123",
    verifyCmd: "pnpm test",
    worktreePath: null,
    status: "landed",
    enqueuedAt: VALID_TIMESTAMP,
    pickedUpAt: VALID_TIMESTAMP,
    resolvedAt: VALID_TIMESTAMP,
    landedSha: "def456",
    rejectCategory: null,
    rejectReason: null,
    failedFiles: null,
    logExcerpt: null,
    logUrl: null,
    createdAt: VALID_TIMESTAMP,
    updatedAt: VALID_TIMESTAMP,
  };

  it("accepts a timeline with milestone + attempt + audit events", () => {
    const timeline = {
      request,
      events: [
        { at: VALID_TIMESTAMP, kind: "queued" as const },
        { at: VALID_TIMESTAMP, kind: "integrating" as const },
        {
          at: VALID_TIMESTAMP,
          kind: "attempt" as const,
          attemptNumber: 1,
          baseSha: "abc123",
          treeSha: "def456",
          status: "passed",
          startedAt: VALID_TIMESTAMP,
          completedAt: VALID_TIMESTAMP,
        },
        {
          at: VALID_TIMESTAMP,
          kind: "audit" as const,
          action: "force_land",
          actorId: VALID_ULID,
          reason: "hotfix",
          metadataBefore: { status: "integrating" },
          metadataAfter: { status: "landed", overridden: true },
        },
        { at: VALID_TIMESTAMP, kind: "landed" as const, landedSha: "def456" },
      ],
    };
    expect(timelineSchema.parse(timeline)).toBeTruthy();
  });

  it("accepts an empty event list", () => {
    expect(timelineSchema.parse({ request, events: [] })).toBeTruthy();
  });

  it("rejects an event with an unknown kind", () => {
    expect(() =>
      timelineSchema.parse({
        request,
        events: [{ at: VALID_TIMESTAMP, kind: "exploded" }],
      }),
    ).toThrow();
  });

  it("rejects a timeline missing the request", () => {
    expect(() => timelineSchema.parse({ events: [] })).toThrow();
  });
});
