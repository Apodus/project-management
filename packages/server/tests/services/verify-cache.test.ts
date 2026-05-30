import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestApp,
  createTestProject,
  type TestApp,
} from "../utils.js";
import { verifyCache } from "../../src/db/index.js";
import * as svc from "../../src/services/verify-cache.service.js";

// A canonical 5-tuple key the round-trip + strict-key tests pivot on.
function baseKey(projectId: string): svc.LookupArgs {
  return {
    projectId,
    resource: "main",
    treeSha: "tree-aaa",
    stepId: "lint",
    stepConfigSha: "cfg-111",
  };
}

function recordArgs(
  projectId: string,
  overrides: Partial<svc.RecordArgs> = {},
): svc.RecordArgs {
  return {
    ...baseKey(projectId),
    result: "pass",
    durationMs: 4200,
    logExcerpt: "ok",
    logUrl: "http://logs/1",
    ...overrides,
  };
}

function rowsFor(testApp: TestApp, projectId: string) {
  return testApp.db
    .select()
    .from(verifyCache)
    .where(eq(verifyCache.projectId, projectId))
    .all();
}

describe("verify-cache service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── 1. Round-trip ────────────────────────────────────────────────

  it("lookup of an unseeded key MISSes (null); after record it HITs with the cached verdict", () => {
    const project = createTestProject(testApp.db);
    const now = "2026-05-30T12:00:00.000Z";

    // MISS before anything is recorded.
    expect(svc.lookup(baseKey(project.id), now)).toBeNull();

    svc.record(
      recordArgs(project.id, { result: "pass", durationMs: 4200 }),
      now,
    );

    // HIT — the cached result + durationMs are served back.
    const hit = svc.lookup(baseKey(project.id), "2026-05-30T12:00:05.000Z");
    expect(hit).not.toBeNull();
    expect(hit!.result).toBe("pass");
    expect(hit!.durationMs).toBe(4200);
    expect(hit!.logExcerpt).toBe("ok");
  });

  // ── 2. STRICT KEY: each of the 5 fields differing → MISS ─────────

  it("a lookup differing in ANY ONE of the 5 key fields MISSes (the no-stale-hit proof)", () => {
    const project = createTestProject(testApp.db);
    // A second project so the differing-projectId probe satisfies the FK.
    const other = createTestProject(testApp.db);
    const now = "2026-05-30T12:00:00.000Z";

    svc.record(recordArgs(project.id), now);

    // Sanity: the exact key HITs.
    expect(svc.lookup(baseKey(project.id), now)).not.toBeNull();

    // Each of the 5 fields differing one at a time → MISS (null).
    expect(
      svc.lookup({ ...baseKey(project.id), projectId: other.id }, now),
    ).toBeNull();
    expect(
      svc.lookup({ ...baseKey(project.id), resource: "hotfix" }, now),
    ).toBeNull();
    expect(
      svc.lookup({ ...baseKey(project.id), treeSha: "tree-bbb" }, now),
    ).toBeNull();
    expect(
      svc.lookup({ ...baseKey(project.id), stepId: "unit" }, now),
    ).toBeNull();
    expect(
      svc.lookup({ ...baseKey(project.id), stepConfigSha: "cfg-222" }, now),
    ).toBeNull();
  });

  // ── 3. Hit bump (PM-owned) ───────────────────────────────────────

  it("each HIT bumps hit_count (0→1→2) and sets last_hit_at; a MISS bumps nothing", () => {
    const project = createTestProject(testApp.db);
    const t0 = "2026-05-30T12:00:00.000Z";
    svc.record(recordArgs(project.id), t0);

    // Freshly recorded: hit_count 0, last_hit_at null.
    let row = rowsFor(testApp, project.id)[0];
    expect(row.hitCount).toBe(0);
    expect(row.lastHitAt).toBeNull();

    // First HIT → 1, last_hit_at = the lookup now.
    const t1 = "2026-05-30T12:00:10.000Z";
    const h1 = svc.lookup(baseKey(project.id), t1);
    expect(h1!.hitCount).toBe(1);
    expect(h1!.lastHitAt).toBe(t1);
    row = rowsFor(testApp, project.id)[0];
    expect(row.hitCount).toBe(1);
    expect(row.lastHitAt).toBe(t1);

    // Second HIT → 2.
    const t2 = "2026-05-30T12:00:20.000Z";
    const h2 = svc.lookup(baseKey(project.id), t2);
    expect(h2!.hitCount).toBe(2);
    expect(h2!.lastHitAt).toBe(t2);

    // A MISS (different key) bumps nothing — the seeded row stays at 2.
    expect(
      svc.lookup({ ...baseKey(project.id), treeSha: "tree-zzz" }, t2),
    ).toBeNull();
    row = rowsFor(testApp, project.id)[0];
    expect(row.hitCount).toBe(2);
  });

  // ── 4. Record-upsert: no duplicate + preserve hit_count/last_hit_at/created_at ──

  it("re-recording the same key UPDATEs in place (1 row) and PRESERVES hit_count/last_hit_at/created_at", () => {
    const project = createTestProject(testApp.db);
    const t0 = "2026-05-30T12:00:00.000Z";

    // First record: pass / 4200.
    svc.record(
      recordArgs(project.id, { result: "pass", durationMs: 4200 }),
      t0,
    );
    expect(rowsFor(testApp, project.id)).toHaveLength(1);
    const createdAt = rowsFor(testApp, project.id)[0].createdAt;

    // Seed a hit between the two records → hit_count 1, last_hit_at set.
    const tHit = "2026-05-30T12:00:10.000Z";
    svc.lookup(baseKey(project.id), tHit);

    // Second record: the shadow self-heal flips the verdict to fail / 9999.
    const t1 = "2026-05-30T12:00:20.000Z";
    const view = svc.record(
      recordArgs(project.id, { result: "fail", durationMs: 9999 }),
      t1,
    );

    // Exactly ONE row — the upsert did not duplicate.
    expect(rowsFor(testApp, project.id)).toHaveLength(1);

    // Verdict / duration / updatedAt overwritten.
    expect(view.result).toBe("fail");
    expect(view.durationMs).toBe(9999);
    expect(view.updatedAt).toBe(t1);

    // hit_count / last_hit_at / created_at PRESERVED through the overwrite.
    expect(view.hitCount).toBe(1);
    expect(view.lastHitAt).toBe(tHit);
    expect(view.createdAt).toBe(createdAt);
    expect(view.createdAt).toBe(t0);
  });

  // ── 5. Cache-hit-rate (§7.2) ─────────────────────────────────────

  it("cacheHitRate sums hit_count in the last_hit_at window over rows created in the window, scoped per-resource", () => {
    const project = createTestProject(testApp.db);
    const db = testApp.db;
    const ts = "2026-05-30T12:00:00.000Z";

    const from = "2026-05-30T00:00:00.000Z";
    const to = "2026-05-30T23:59:59.000Z";

    // Helper to seed a raw row with known created_at/last_hit_at/hit_count.
    function seed(o: {
      treeSha: string;
      resource?: string;
      createdAt: string;
      lastHitAt: string | null;
      hitCount: number;
    }) {
      db.insert(verifyCache)
        .values({
          id: `id-${o.treeSha}-${o.resource ?? "main"}`,
          projectId: project.id,
          resource: o.resource ?? "main",
          treeSha: o.treeSha,
          stepId: "lint",
          stepConfigSha: "cfg",
          result: "pass",
          durationMs: 1000,
          logExcerpt: null,
          logUrl: null,
          createdAt: o.createdAt,
          lastHitAt: o.lastHitAt,
          hitCount: o.hitCount,
          updatedAt: ts,
        })
        .run();
    }

    // In-window main rows: 2 created in-window (→ 2 misses), with hit_count
    // 3 + 2 last-hit in-window (→ 5 hits).
    seed({ treeSha: "a", createdAt: ts, lastHitAt: ts, hitCount: 3 });
    seed({ treeSha: "b", createdAt: ts, lastHitAt: ts, hitCount: 2 });
    // Out-of-window: created + last-hit BEFORE the window → excluded entirely.
    seed({
      treeSha: "c",
      createdAt: "2026-05-29T00:00:00.000Z",
      lastHitAt: "2026-05-29T00:00:00.000Z",
      hitCount: 100,
    });
    // A different-resource row inside the window → excluded by per-resource scope.
    seed({
      treeSha: "d",
      resource: "hotfix",
      createdAt: ts,
      lastHitAt: ts,
      hitCount: 50,
    });

    const rate = svc.cacheHitRate(project.id, "main", from, to);
    expect(rate.hits).toBe(5); // 3 + 2 (the hotfix 50 + out-of-window 100 excluded)
    expect(rate.lookups).toBe(7); // 5 hits + 2 misses (rows a,b created in-window)
    expect(rate.ratio).toBeCloseTo(5 / 7, 10);

    // The hotfix lane: 1 row created in-window, 50 hits → ratio 50/51.
    const hotfix = svc.cacheHitRate(project.id, "hotfix", from, to);
    expect(hotfix.hits).toBe(50);
    expect(hotfix.lookups).toBe(51);

    // An empty lane → null ratio (the 7.4 null-when-zero convention).
    const empty = svc.cacheHitRate(project.id, "nonexistent", from, to);
    expect(empty.hits).toBe(0);
    expect(empty.lookups).toBe(0);
    expect(empty.ratio).toBeNull();
  });

  // ── 6. list (§8.4) ───────────────────────────────────────────────

  it("list returns rows newest-first, honors filters + pagination + total", () => {
    const project = createTestProject(testApp.db);
    const db = testApp.db;

    function seed(o: {
      treeSha: string;
      resource?: string;
      stepId?: string;
      result?: "pass" | "fail";
      createdAt: string;
    }) {
      db.insert(verifyCache)
        .values({
          id: `id-${o.treeSha}`,
          projectId: project.id,
          resource: o.resource ?? "main",
          treeSha: o.treeSha,
          stepId: o.stepId ?? "lint",
          stepConfigSha: "cfg",
          result: o.result ?? "pass",
          durationMs: 1000,
          logExcerpt: null,
          logUrl: null,
          createdAt: o.createdAt,
          lastHitAt: null,
          hitCount: 0,
          updatedAt: o.createdAt,
        })
        .run();
    }

    seed({ treeSha: "a", createdAt: "2026-05-30T10:00:00.000Z" });
    seed({
      treeSha: "b",
      stepId: "unit",
      result: "fail",
      createdAt: "2026-05-30T12:00:00.000Z",
    });
    seed({ treeSha: "c", resource: "hotfix", createdAt: "2026-05-30T11:00:00.000Z" });

    // All rows, newest-first.
    const all = svc.list(project.id, { page: 1, perPage: 50 });
    expect(all.total).toBe(3);
    expect(all.rows.map((r) => r.treeSha)).toEqual(["b", "c", "a"]);

    // resource filter.
    const main = svc.list(project.id, { resource: "main", page: 1, perPage: 50 });
    expect(main.total).toBe(2);

    // stepId + result filter.
    const failUnit = svc.list(project.id, {
      stepId: "unit",
      result: "fail",
      page: 1,
      perPage: 50,
    });
    expect(failUnit.total).toBe(1);
    expect(failUnit.rows[0].treeSha).toBe("b");

    // Pagination: page 2 of perPage 1 → the second-newest (c).
    const page2 = svc.list(project.id, { page: 2, perPage: 1 });
    expect(page2.total).toBe(3);
    expect(page2.rows).toHaveLength(1);
    expect(page2.rows[0].treeSha).toBe("c");
  });

  // ── 7. timeSaved (§7.2) ──────────────────────────────────────────

  it("timeSaved sums hit_count*duration_ms over the last_hit_at window, per-resource, non-null duration", () => {
    const project = createTestProject(testApp.db);
    const db = testApp.db;
    const from = "2026-05-30T00:00:00.000Z";
    const to = "2026-05-30T23:59:59.000Z";
    const inWin = "2026-05-30T12:00:00.000Z";

    function seed(o: {
      treeSha: string;
      resource?: string;
      durationMs: number | null;
      lastHitAt: string | null;
      hitCount: number;
    }) {
      db.insert(verifyCache)
        .values({
          id: `id-${o.treeSha}-${o.resource ?? "main"}`,
          projectId: project.id,
          resource: o.resource ?? "main",
          treeSha: o.treeSha,
          stepId: "lint",
          stepConfigSha: "cfg",
          result: "pass",
          durationMs: o.durationMs,
          logExcerpt: null,
          logUrl: null,
          createdAt: inWin,
          lastHitAt: o.lastHitAt,
          hitCount: o.hitCount,
          updatedAt: inWin,
        })
        .run();
    }

    // 3 hits × 1000 = 3000, 2 hits × 5000 = 10000 → 13000 saved.
    seed({ treeSha: "a", durationMs: 1000, lastHitAt: inWin, hitCount: 3 });
    seed({ treeSha: "b", durationMs: 5000, lastHitAt: inWin, hitCount: 2 });
    // Out-of-window last_hit → excluded.
    seed({
      treeSha: "c",
      durationMs: 9000,
      lastHitAt: "2026-05-29T00:00:00.000Z",
      hitCount: 100,
    });
    // null duration → excluded from the sum.
    seed({ treeSha: "d", durationMs: null, lastHitAt: inWin, hitCount: 50 });
    // Different resource → excluded.
    seed({
      treeSha: "e",
      resource: "hotfix",
      durationMs: 7000,
      lastHitAt: inWin,
      hitCount: 4,
    });

    expect(svc.timeSaved(project.id, "main", from, to)).toBe(13000);
    expect(svc.timeSaved(project.id, "hotfix", from, to)).toBe(28000); // 4×7000
    expect(svc.timeSaved(project.id, "nonexistent", from, to)).toBe(0);
  });

  // ── 8. perStep (§7.2) ────────────────────────────────────────────

  it("perStep groups by step_id over the created_at window: runs/cached/pass_rate/avg_duration/fail_count", () => {
    const project = createTestProject(testApp.db);
    const db = testApp.db;
    const from = "2026-05-30T00:00:00.000Z";
    const to = "2026-05-30T23:59:59.000Z";
    const inWin = "2026-05-30T12:00:00.000Z";

    function seed(o: {
      treeSha: string;
      stepId: string;
      result: "pass" | "fail";
      durationMs: number | null;
      hitCount: number;
      createdAt?: string;
    }) {
      db.insert(verifyCache)
        .values({
          id: `id-${o.treeSha}`,
          projectId: project.id,
          resource: "main",
          treeSha: o.treeSha,
          stepId: o.stepId,
          stepConfigSha: `cfg-${o.treeSha}`,
          result: o.result,
          durationMs: o.durationMs,
          logExcerpt: null,
          logUrl: null,
          createdAt: o.createdAt ?? inWin,
          lastHitAt: null,
          hitCount: o.hitCount,
          updatedAt: o.createdAt ?? inWin,
        })
        .run();
    }

    // lint: 2 runs (1 pass / 1 fail), durations 4000 + 2000 → avg 3000, cached 10.
    seed({ treeSha: "l1", stepId: "lint", result: "pass", durationMs: 4000, hitCount: 6 });
    seed({ treeSha: "l2", stepId: "lint", result: "fail", durationMs: 2000, hitCount: 4 });
    // unit: 1 run pass, duration 90000, cached 1.
    seed({ treeSha: "u1", stepId: "unit", result: "pass", durationMs: 90000, hitCount: 1 });
    // Out-of-window lint row → excluded.
    seed({
      treeSha: "lOld",
      stepId: "lint",
      result: "fail",
      durationMs: 999,
      hitCount: 50,
      createdAt: "2026-05-29T00:00:00.000Z",
    });

    const steps = svc.perStep(project.id, "main", from, to);
    // Ordered by step_id (lint, unit).
    expect(steps.map((s) => s.stepId)).toEqual(["lint", "unit"]);

    const lint = steps[0];
    expect(lint.runs).toBe(2);
    expect(lint.cached).toBe(10); // 6 + 4
    expect(lint.passRate).toBeCloseTo(1 / 2, 10);
    expect(lint.avgDurationMs).toBeCloseTo(3000, 10);
    expect(lint.failCount).toBe(1);

    const unit = steps[1];
    expect(unit.runs).toBe(1);
    expect(unit.cached).toBe(1);
    expect(unit.passRate).toBe(1);
    expect(unit.avgDurationMs).toBe(90000);
    expect(unit.failCount).toBe(0);
  });
});
