/**
 * Phase 7.3 Step 13 — reclaimStrandedGroups unit tests (FakePm).
 *
 * The stranded-GROUP recovery sweep (design §9 finding 2 / §6.4): on integrator
 * restart, a cross-repo group left `integrating` by a crash must be reset to a
 * re-integratable state — but ONLY if it is a genuinely-stranded group (NO open
 * orphaned_inner incident), NOT a real orphan (open incident → §7 rollforward).
 *
 * Proves:
 *  (1) a stranded integrating group with NO incident → resetGroup called (the
 *      §6.4 window).
 *  (2) an integrating group WITH an open incident → NOT reset (left for §7).
 *  (3) a partially_landed group → NEVER listed (list is state=integrating), so
 *      NEVER reset (the corruption guard, verified via the list filter).
 *  (4) the incident filter is keyed on (state=open, type=orphaned_inner,
 *      groupId) so a DIFFERENT group's incident does not block a reset.
 */
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { reclaimStrandedGroups } from "../src/recovery.js";
import type { PmClient } from "../src/pm-client.js";
import type {
  MergeRequestGroupView,
  MergeIncidentView,
} from "@pm/shared";

const logger = createLogger("error");

function nowIso(): string {
  return new Date().toISOString();
}

function makeGroup(over: Partial<MergeRequestGroupView>): MergeRequestGroupView {
  return {
    id: "grp-1",
    projectId: "proj-1",
    resource: "main",
    state: "integrating",
    submittedBy: "worker-1",
    integratorId: "int-1",
    resolvedAt: null,
    resolutionReason: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...over,
  };
}

function makeIncident(over: Partial<MergeIncidentView>): MergeIncidentView {
  return {
    id: "inc-1",
    projectId: "proj-1",
    groupId: "grp-1",
    type: "orphaned_inner",
    innerRepo: "rynx-inner",
    orphanedSha: "0".repeat(40),
    outerRepo: "app-outer",
    innerRequestId: "req-inner",
    taskId: "task-inner",
    state: "open",
    openedAt: nowIso(),
    resolvedAt: null,
    resolution: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...over,
  };
}

interface FakeState {
  groups: MergeRequestGroupView[];
  incidents: MergeIncidentView[];
  calls: string[];
  resetCalls: { groupId: string; reason?: string }[];
}

function makeFakePm(state: FakeState): PmClient {
  const fake = {
    async listMergeGroups(
      _projectId: string,
      filters?: { resource?: string; state?: string },
    ): Promise<MergeRequestGroupView[]> {
      state.calls.push("listMergeGroups");
      return state.groups.filter(
        (g) =>
          (!filters?.resource || g.resource === filters.resource) &&
          (!filters?.state || g.state === filters.state),
      );
    },
    async listMergeIncidents(
      _projectId: string,
      filters?: { state?: string; type?: string; groupId?: string },
    ): Promise<MergeIncidentView[]> {
      state.calls.push("listMergeIncidents");
      return state.incidents.filter(
        (i) =>
          (!filters?.state || i.state === filters.state) &&
          (!filters?.type || i.type === filters.type) &&
          (!filters?.groupId || i.groupId === filters.groupId),
      );
    },
    async resetGroup(
      groupId: string,
      opts?: { reason?: string },
    ): Promise<MergeRequestGroupView> {
      state.calls.push("resetGroup");
      state.resetCalls.push({ groupId, reason: opts?.reason });
      const g = state.groups.find((x) => x.id === groupId);
      if (g) {
        g.state = "forming";
        g.integratorId = null;
      }
      return g as MergeRequestGroupView;
    },
  };
  return fake as unknown as PmClient;
}

describe("reclaimStrandedGroups", () => {
  it("(1) stranded integrating group with NO incident → reset to forming", async () => {
    const state: FakeState = {
      groups: [makeGroup({ id: "grp-1", state: "integrating" })],
      incidents: [],
      calls: [],
      resetCalls: [],
    };
    const pm = makeFakePm(state);

    const result = await reclaimStrandedGroups(pm, "proj-1", "main", logger);

    expect(result.scanned).toBe(1);
    expect(result.reclaimed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(state.resetCalls).toHaveLength(1);
    expect(state.resetCalls[0].groupId).toBe("grp-1");
    expect(state.resetCalls[0].reason).toMatch(/§6\.4|stranded/i);
    // The group flipped to forming via the fake.
    expect(state.groups[0].state).toBe("forming");
    expect(state.groups[0].integratorId).toBeNull();
  });

  it("(2) integrating group WITH an open incident → NOT reset (left for §7)", async () => {
    const state: FakeState = {
      groups: [makeGroup({ id: "grp-1", state: "integrating" })],
      incidents: [makeIncident({ groupId: "grp-1", state: "open" })],
      calls: [],
      resetCalls: [],
    };
    const pm = makeFakePm(state);

    const result = await reclaimStrandedGroups(pm, "proj-1", "main", logger);

    expect(result.scanned).toBe(1);
    expect(result.reclaimed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(state.resetCalls).toHaveLength(0);
    expect(state.calls).not.toContain("resetGroup");
    // The group is left integrating (a real orphan, recovered by rollforward).
    expect(state.groups[0].state).toBe("integrating");
  });

  it("(3) a partially_landed group is never listed (state=integrating) → never reset", async () => {
    const state: FakeState = {
      groups: [
        makeGroup({ id: "grp-partial", state: "partially_landed" }),
        makeGroup({ id: "grp-landed", state: "landed" }),
      ],
      // Even with an incident present, the partially_landed group is not listed.
      incidents: [makeIncident({ groupId: "grp-partial", state: "open" })],
      calls: [],
      resetCalls: [],
    };
    const pm = makeFakePm(state);

    const result = await reclaimStrandedGroups(pm, "proj-1", "main", logger);

    // Nothing integrating → nothing scanned, nothing reset (the corruption guard
    // is structural: the sweep only ever lists state=integrating).
    expect(result.scanned).toBe(0);
    expect(result.reclaimed).toBe(0);
    expect(state.resetCalls).toHaveLength(0);
    expect(state.groups.find((g) => g.id === "grp-partial")?.state).toBe(
      "partially_landed",
    );
  });

  it("(4) a DIFFERENT group's open incident does not block a stranded group's reset", async () => {
    const state: FakeState = {
      groups: [makeGroup({ id: "grp-stranded", state: "integrating" })],
      // Incident belongs to a different (already-partially-landed) group.
      incidents: [makeIncident({ groupId: "grp-other", state: "open" })],
      calls: [],
      resetCalls: [],
    };
    const pm = makeFakePm(state);

    const result = await reclaimStrandedGroups(pm, "proj-1", "main", logger);

    expect(result.reclaimed).toBe(1);
    expect(state.resetCalls).toHaveLength(1);
    expect(state.resetCalls[0].groupId).toBe("grp-stranded");
  });

  it("(5) multiple integrating groups: reset those without incidents, leave those with", async () => {
    const state: FakeState = {
      groups: [
        makeGroup({ id: "grp-a", state: "integrating" }),
        makeGroup({ id: "grp-b", state: "integrating" }),
        makeGroup({ id: "grp-c", state: "integrating" }),
      ],
      incidents: [makeIncident({ id: "inc-b", groupId: "grp-b", state: "open" })],
      calls: [],
      resetCalls: [],
    };
    const pm = makeFakePm(state);

    const result = await reclaimStrandedGroups(pm, "proj-1", "main", logger);

    expect(result.scanned).toBe(3);
    expect(result.reclaimed).toBe(2); // a + c
    expect(result.skipped).toBe(1); // b
    expect(state.resetCalls.map((r) => r.groupId).sort()).toEqual([
      "grp-a",
      "grp-c",
    ]);
  });
});
