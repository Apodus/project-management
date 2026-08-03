import { describe, it, expect } from "vitest";
import {
  MERGE_PHASES,
  MERGE_PHASES_DERIVED,
  MERGE_PHASES_OBSERVED,
  MERGE_PHASE_BASES,
  mergePhaseEntryInputSchema,
  mergePhaseIngestSchema,
  mergePhaseIngestResultSchema,
  mergePhaseRowSchema,
  derivedPhaseEntrySchema,
  phaseTraceEntrySchema,
  mergePhaseSampleSchema,
  deriveQueueWait,
  deriveForming,
} from "../src/index.js";

// ─── The partition (THE anti-double-count invariant) ──────────────
//
// If DERIVED and OBSERVED ever overlap, a phase PM computes AND the integrator
// reports lands in the aggregate twice. Asserted, never eyeballed.

describe("merge phase taxonomy", () => {
  it("MERGE_PHASES is exactly DERIVED ++ OBSERVED, and the halves are disjoint", () => {
    expect([...MERGE_PHASES]).toEqual([...MERGE_PHASES_DERIVED, ...MERGE_PHASES_OBSERVED]);

    const overlap = MERGE_PHASES_DERIVED.filter((p) =>
      (MERGE_PHASES_OBSERVED as readonly string[]).includes(p),
    );
    expect(overlap).toEqual([]);
    expect(new Set(MERGE_PHASES).size).toBe(MERGE_PHASES.length);
  });

  it("pins the PIPELINE order (the render-order contract P3/P4/P5 read)", () => {
    expect([...MERGE_PHASES]).toEqual([
      "forming",
      "queue_wait",
      "assemble",
      "materialize",
      "rebase",
      "verify",
      "land",
    ]);
  });

  it("pins the derived-basis discriminator", () => {
    expect([...MERGE_PHASE_BASES]).toEqual(["exact", "requeued"]);
  });
});

// ─── Ingest schema: strict identity, lenient values ───────────────

describe("mergePhaseEntryInputSchema", () => {
  const base = { startedAt: "2026-08-03T10:00:00.000Z", durationMs: 1000 };

  it("accepts every OBSERVED phase", () => {
    for (const phase of MERGE_PHASES_OBSERVED) {
      expect(mergePhaseEntryInputSchema.safeParse({ ...base, phase }).success).toBe(true);
    }
  });

  it("REJECTS every DERIVED phase (PM computes those — accepting one double-counts it)", () => {
    for (const phase of MERGE_PHASES_DERIVED) {
      expect(mergePhaseEntryInputSchema.safeParse({ ...base, phase }).success).toBe(false);
    }
  });

  it("rejects a non-ISO startedAt and an empty id (strict identity/shape)", () => {
    expect(
      mergePhaseEntryInputSchema.safeParse({ ...base, phase: "verify", startedAt: "yesterday" })
        .success,
    ).toBe(false);
    expect(
      mergePhaseEntryInputSchema.safeParse({ ...base, phase: "verify", requestId: "" }).success,
    ).toBe(false);
  });

  it("ACCEPTS out-of-range values — they are normalized server-side, never 400 (design lock 1)", () => {
    const parsed = mergePhaseEntryInputSchema.parse({
      phase: "verify",
      startedAt: base.startedAt,
      durationMs: -5.7,
      label: "x".repeat(500),
      detail: { anything: [1, 2, 3] },
    });
    expect(parsed.durationMs).toBe(-5.7);
    expect(parsed.label).toHaveLength(500);
  });

  it("accepts null label/detail and omits recordedBy entirely (server-assigned)", () => {
    const parsed = mergePhaseEntryInputSchema.parse({
      ...base,
      phase: "land",
      label: null,
      detail: null,
      recordedBy: "spoofed",
    });
    expect(parsed.label).toBeNull();
    expect(parsed).not.toHaveProperty("recordedBy");
  });
});

describe("mergePhaseIngestSchema", () => {
  const entry = { phase: "rebase", startedAt: "2026-08-03T10:00:00.000Z", durationMs: 1 };

  it("defaults resource to main", () => {
    expect(mergePhaseIngestSchema.parse({ phases: [entry] }).resource).toBe("main");
  });

  it("requires at least 1 entry and caps the batch at 100", () => {
    expect(mergePhaseIngestSchema.safeParse({ phases: [] }).success).toBe(false);
    expect(
      mergePhaseIngestSchema.safeParse({ phases: Array.from({ length: 100 }, () => entry) })
        .success,
    ).toBe(true);
    expect(
      mergePhaseIngestSchema.safeParse({ phases: Array.from({ length: 101 }, () => entry) })
        .success,
    ).toBe(false);
  });

  it("the ack carries recorded + adjusted", () => {
    expect(mergePhaseIngestResultSchema.parse({ recorded: 3, adjusted: 1 })).toEqual({
      recorded: 3,
      adjusted: 1,
    });
  });
});

// ─── Read views ───────────────────────────────────────────────────

describe("phase trace union", () => {
  const row = {
    derived: false,
    id: "01ROW",
    projectId: "p1",
    resource: "main",
    requestId: "r1",
    groupId: null,
    attemptId: null,
    phase: "verify",
    label: null,
    startedAt: "2026-08-03T10:00:00.000Z",
    durationMs: 60_000,
    detail: null,
    recordedBy: "integrator",
    createdAt: "2026-08-03T10:01:00.000Z",
  };
  const derived = {
    derived: true,
    phase: "queue_wait",
    projectId: "p1",
    resource: "main",
    requestId: "r1",
    groupId: null,
    startedAt: "2026-08-03T09:00:00.000Z",
    durationMs: 3_600_000,
    originAt: "2026-08-03T08:00:00.000Z",
    originDurationMs: 7_200_000,
    basis: "requeued",
  };

  it("discriminates on `derived`", () => {
    const parsedRow = phaseTraceEntrySchema.parse(row);
    const parsedDerived = phaseTraceEntrySchema.parse(derived);
    expect(parsedRow.derived).toBe(false);
    expect(parsedDerived.derived).toBe(true);
    expect(mergePhaseRowSchema.safeParse(row).success).toBe(true);
    expect(derivedPhaseEntrySchema.safeParse(derived).success).toBe(true);
  });

  it("a derived entry has NO id (nothing to address) and a stored row must have one", () => {
    expect(derivedPhaseEntrySchema.parse(derived)).not.toHaveProperty("id");
    const { id: _id, ...idless } = row;
    expect(mergePhaseRowSchema.safeParse(idless).success).toBe(false);
  });

  it("a stored row cannot carry a DERIVED phase name", () => {
    expect(mergePhaseRowSchema.safeParse({ ...row, phase: "queue_wait" }).success).toBe(false);
  });

  it("the sample projection spans the WHOLE phase set (stored + derived concatenate)", () => {
    for (const phase of MERGE_PHASES) {
      expect(
        mergePhaseSampleSchema.safeParse({
          phase,
          durationMs: 1,
          startedAt: "2026-08-03T10:00:00.000Z",
          requestId: null,
          groupId: null,
        }).success,
      ).toBe(true);
    }
  });
});

// ─── The derivation helpers ───────────────────────────────────────

const IDS = { projectId: "p1", resource: "main", requestId: "r1" };

describe("deriveQueueWait", () => {
  it("exact: no prior integration → the whole wait, both durations agree", () => {
    const entry = deriveQueueWait({
      ...IDS,
      enqueuedAt: "2026-08-03T10:00:00.000Z",
      pickedUpAt: "2026-08-03T10:10:00.000Z",
      priorIntegrationAt: null,
    })!;
    expect(entry.basis).toBe("exact");
    expect(entry.phase).toBe("queue_wait");
    expect(entry.startedAt).toBe("2026-08-03T10:00:00.000Z");
    expect(entry.durationMs).toBe(600_000);
    expect(entry.originDurationMs).toBe(600_000);
    expect(entry.groupId).toBeNull();
    expect(entry.derived).toBe(true);
  });

  it("requeued: a prior integration inside the window re-anchors the LAST segment", () => {
    // The bug this prevents: 10:00 submit → 39-minute verify → requeue at 10:39
    // → picked up again at 10:44. Naive subtraction calls that a 44-minute queue.
    const entry = deriveQueueWait({
      ...IDS,
      enqueuedAt: "2026-08-03T10:00:00.000Z",
      pickedUpAt: "2026-08-03T10:44:00.000Z",
      priorIntegrationAt: "2026-08-03T10:39:00.000Z",
    })!;
    expect(entry.basis).toBe("requeued");
    expect(entry.startedAt).toBe("2026-08-03T10:39:00.000Z");
    expect(entry.durationMs).toBe(300_000); // 5m — the honest queue segment
    expect(entry.originAt).toBe("2026-08-03T10:00:00.000Z");
    expect(entry.originDurationMs).toBe(2_640_000); // 44m — total since submit
  });

  it("evidence at or outside the window is ignored (strictly-between rule)", () => {
    for (const prior of [
      "2026-08-03T09:00:00.000Z", // before origin
      "2026-08-03T10:00:00.000Z", // == origin
      "2026-08-03T10:10:00.000Z", // == pickup
      "2026-08-03T11:00:00.000Z", // after pickup
    ]) {
      const entry = deriveQueueWait({
        ...IDS,
        enqueuedAt: "2026-08-03T10:00:00.000Z",
        pickedUpAt: "2026-08-03T10:10:00.000Z",
        priorIntegrationAt: prior,
      })!;
      expect(entry.basis).toBe("exact");
      expect(entry.durationMs).toBe(600_000);
    }
  });

  it("a null pickup yields null — completed windows only, like a stored row", () => {
    expect(
      deriveQueueWait({
        ...IDS,
        enqueuedAt: "2026-08-03T10:00:00.000Z",
        pickedUpAt: null,
        priorIntegrationAt: null,
      }),
    ).toBeNull();
  });

  it("clock skew (pickup before enqueue) clamps to 0 rather than minting a negative", () => {
    const entry = deriveQueueWait({
      ...IDS,
      enqueuedAt: "2026-08-03T10:10:00.000Z",
      pickedUpAt: "2026-08-03T10:00:00.000Z",
      priorIntegrationAt: null,
    })!;
    expect(entry.durationMs).toBe(0);
    expect(entry.originDurationMs).toBe(0);
  });

  it("unparseable timestamps yield null and NEVER throw", () => {
    for (const args of [
      { enqueuedAt: "not-a-date", pickedUpAt: "2026-08-03T10:00:00.000Z" },
      { enqueuedAt: "2026-08-03T10:00:00.000Z", pickedUpAt: "" },
      { enqueuedAt: "", pickedUpAt: "" },
    ]) {
      expect(() =>
        deriveQueueWait({ ...IDS, ...args, priorIntegrationAt: "also-garbage" }),
      ).not.toThrow();
      expect(deriveQueueWait({ ...IDS, ...args, priorIntegrationAt: "also-garbage" })).toBeNull();
    }
  });

  it("garbage evidence degrades to `exact` instead of poisoning the window", () => {
    const entry = deriveQueueWait({
      ...IDS,
      enqueuedAt: "2026-08-03T10:00:00.000Z",
      pickedUpAt: "2026-08-03T10:10:00.000Z",
      priorIntegrationAt: "nonsense",
    })!;
    expect(entry.basis).toBe("exact");
  });

  it("originDurationMs >= durationMs, always", () => {
    const instants = [
      "2026-08-03T09:00:00.000Z",
      "2026-08-03T10:00:00.000Z",
      "2026-08-03T10:30:00.000Z",
      "2026-08-03T11:00:00.000Z",
    ];
    for (const enqueuedAt of instants) {
      for (const pickedUpAt of instants) {
        for (const priorIntegrationAt of [null, ...instants]) {
          const entry = deriveQueueWait({ ...IDS, enqueuedAt, pickedUpAt, priorIntegrationAt });
          if (!entry) continue;
          expect(entry.originDurationMs).toBeGreaterThanOrEqual(entry.durationMs);
          expect(entry.durationMs).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("emits the ISO output verbatim from its input (no re-formatting drift)", () => {
    const entry = deriveQueueWait({
      ...IDS,
      enqueuedAt: "2026-08-03T10:00:00+00:00",
      pickedUpAt: "2026-08-03T10:10:00.000Z",
      priorIntegrationAt: null,
    })!;
    expect(entry.startedAt).toBe("2026-08-03T10:00:00+00:00");
    expect(derivedPhaseEntrySchema.safeParse(entry).success).toBe(true);
  });
});

describe("deriveForming", () => {
  const GROUP = { projectId: "p1", resource: "main", groupId: "g1" };

  it("measures group creation → first member pickup, requestId null", () => {
    const entry = deriveForming({
      ...GROUP,
      groupCreatedAt: "2026-08-03T10:00:00.000Z",
      firstMemberPickupAt: "2026-08-03T10:03:00.000Z",
      priorIntegrationAt: null,
    })!;
    expect(entry.phase).toBe("forming");
    expect(entry.basis).toBe("exact");
    expect(entry.durationMs).toBe(180_000);
    expect(entry.requestId).toBeNull();
    expect(entry.groupId).toBe("g1");
  });

  it("re-anchors on a prior integration exactly as queue_wait does", () => {
    const entry = deriveForming({
      ...GROUP,
      groupCreatedAt: "2026-08-03T10:00:00.000Z",
      firstMemberPickupAt: "2026-08-03T11:00:00.000Z",
      priorIntegrationAt: "2026-08-03T10:50:00.000Z",
    })!;
    expect(entry.basis).toBe("requeued");
    expect(entry.durationMs).toBe(600_000);
    expect(entry.originDurationMs).toBe(3_600_000);
  });

  it("a group with no member pickup yet yields null", () => {
    expect(
      deriveForming({
        ...GROUP,
        groupCreatedAt: "2026-08-03T10:00:00.000Z",
        firstMemberPickupAt: null,
        priorIntegrationAt: null,
      }),
    ).toBeNull();
  });
});
