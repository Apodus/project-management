/**
 * Phase 7.6.1 — reclaimResolvingResolutions unit tests (FakePm + fixed now).
 *
 * The reclaim sweep recovers `merge_resolutions` rows stranded in `resolving`
 * (resolver session died/timed out). Past a deadline (budget + grace) it
 * reconciles each row:
 *   - a resubmission exists (request with resolvedFrom == origin) → resolved.
 *   - none exists → escalate failed → author + a merge_rejection comment.
 *
 * Proves the reconcile-vs-escalate distinction (getting it wrong loses work or
 * lies to the author), the liveness deadline, and the non-fatal discipline
 * (409 → handled, list-failure → zeroes, never throws, null/NaN → skipped).
 */
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import { reclaimResolvingResolutions } from "../src/reclaim-resolutions.js";
import { PmApiError } from "../src/pm-client.js";
import type { PmClient } from "../src/pm-client.js";
import type { MergeResolutionView, MergeRequestView } from "@pm/shared";

const logger = createLogger("error");

// Fixed clock. timeBudgetSec=600 ⇒ budgetMs=600_000, grace=max(120_000,
// 0.25*600_000=150_000)=150_000 ⇒ deadline = started + 750_000ms.
const NOW = 10_000_000_000;
const TIME_BUDGET_SEC = 600;
const PAST_DEADLINE = new Date(NOW - 800_000).toISOString(); // older than deadline
const WITHIN_DEADLINE = new Date(NOW - 100_000).toISOString(); // still live

function makeResolution(over: Partial<MergeResolutionView>): MergeResolutionView {
  return {
    id: "res-1",
    projectId: "proj-1",
    resource: "main",
    originRequestId: "origin-1",
    resolvedRequestId: null,
    state: "resolving",
    conflictingFiles: ["a.ts"],
    attemptStartedAt: PAST_DEADLINE,
    attemptEndedAt: null,
    escalationTarget: null,
    detail: null,
    createdAt: PAST_DEADLINE,
    updatedAt: PAST_DEADLINE,
    ...over,
  };
}

function makeRequest(over: Partial<MergeRequestView>): MergeRequestView {
  return {
    id: "resub-1",
    projectId: "proj-1",
    resource: "main",
    taskId: "task-1",
    status: "queued",
    resolvedFrom: "origin-1",
    submittedBy: "worker-1",
    branch: "pm/resolution-res-1",
    commitSha: null,
    verifyCmd: null,
    groupId: null,
    landedSha: null,
    createdAt: PAST_DEADLINE,
    updatedAt: PAST_DEADLINE,
    ...over,
  } as MergeRequestView;
}

interface Fakes {
  listResolutions: ReturnType<typeof vi.fn>;
  listMergeRequests: ReturnType<typeof vi.fn>;
  resolvedResolution: ReturnType<typeof vi.fn>;
  escalateResolution: ReturnType<typeof vi.fn>;
  getMergeRequest: ReturnType<typeof vi.fn>;
  postTaskComment: ReturnType<typeof vi.fn>;
}

function makeFakePm(over: Partial<Fakes> = {}): { pm: PmClient; fakes: Fakes } {
  const fakes: Fakes = {
    listResolutions: over.listResolutions ?? vi.fn(async () => []),
    listMergeRequests: over.listMergeRequests ?? vi.fn(async () => []),
    resolvedResolution: over.resolvedResolution ?? vi.fn(async () => ({})),
    escalateResolution: over.escalateResolution ?? vi.fn(async () => ({})),
    getMergeRequest:
      over.getMergeRequest ?? vi.fn(async () => makeRequest({ id: "origin-1", taskId: "task-1" })),
    postTaskComment: over.postTaskComment ?? vi.fn(async () => undefined),
  };
  return { pm: fakes as unknown as PmClient, fakes };
}

function run(pm: PmClient) {
  return reclaimResolvingResolutions({
    pmClient: pm,
    logger,
    projectId: "proj-1",
    resource: "main",
    timeBudgetSec: TIME_BUDGET_SEC,
    now: () => NOW,
  });
}

describe("reclaimResolvingResolutions", () => {
  it("(a) past deadline + resubmission exists → reconcile to resolved, no escalate", async () => {
    const { pm, fakes } = makeFakePm({
      listResolutions: vi.fn(async () => [makeResolution({})]),
      listMergeRequests: vi.fn(async () => [makeRequest({ id: "resub-1" })]),
    });
    const result = await run(pm);

    expect(fakes.resolvedResolution).toHaveBeenCalledWith("res-1", {
      resolvedRequestId: "resub-1",
    });
    expect(fakes.escalateResolution).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, reconciled: 1, escalated: 0, handled: 0 });
  });

  it("(b) past deadline + no resubmission → escalate failed/author + comment", async () => {
    const { pm, fakes } = makeFakePm({
      listResolutions: vi.fn(async () => [makeResolution({})]),
      listMergeRequests: vi.fn(async () => []),
      getMergeRequest: vi.fn(async () => makeRequest({ id: "origin-1", taskId: "task-1" })),
    });
    const result = await run(pm);

    expect(fakes.escalateResolution).toHaveBeenCalledWith("res-1", {
      state: "failed",
      target: "author",
      reason: "session_died_or_timeout",
    });
    expect(fakes.getMergeRequest).toHaveBeenCalledWith("origin-1");
    expect(fakes.postTaskComment).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ commentType: "merge_rejection" }),
    );
    expect(fakes.resolvedResolution).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, escalated: 1, reconciled: 0 });
  });

  it("(c) within deadline → neither reconcile nor escalate (skipped)", async () => {
    const { pm, fakes } = makeFakePm({
      listResolutions: vi.fn(async () => [makeResolution({ attemptStartedAt: WITHIN_DEADLINE })]),
    });
    const result = await run(pm);

    expect(fakes.resolvedResolution).not.toHaveBeenCalled();
    expect(fakes.escalateResolution).not.toHaveBeenCalled();
    expect(fakes.listMergeRequests).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, skipped: 1, reconciled: 0, escalated: 0 });
  });

  it("(d) a 409 from escalate is swallowed (handled), no rethrow", async () => {
    const { pm, fakes } = makeFakePm({
      listResolutions: vi.fn(async () => [makeResolution({})]),
      listMergeRequests: vi.fn(async () => []),
      escalateResolution: vi.fn(async () => {
        throw new PmApiError(409, "CONFLICT", "already terminal");
      }),
    });
    const result = await run(pm);

    expect(result).toMatchObject({ scanned: 1, handled: 1, escalated: 0, skipped: 0 });
    expect(fakes.postTaskComment).not.toHaveBeenCalled();
  });

  it("(d') a 409 from reconcile is swallowed (handled)", async () => {
    const { pm } = makeFakePm({
      listResolutions: vi.fn(async () => [makeResolution({})]),
      listMergeRequests: vi.fn(async () => [makeRequest({ id: "resub-1" })]),
      resolvedResolution: vi.fn(async () => {
        throw new PmApiError(409, "CONFLICT", "already resolved");
      }),
    });
    const result = await run(pm);
    expect(result).toMatchObject({ scanned: 1, handled: 1, reconciled: 0 });
  });

  it("(e) listResolutions failure → zeroes, no throw", async () => {
    const { pm } = makeFakePm({
      listResolutions: vi.fn(async () => {
        throw new PmApiError(0, "NETWORK", "boom");
      }),
    });
    const result = await run(pm);
    expect(result).toEqual({
      scanned: 0,
      reconciled: 0,
      escalated: 0,
      handled: 0,
      skipped: 0,
    });
  });

  it("null attemptStartedAt → skipped (no reconcile/escalate)", async () => {
    const { pm, fakes } = makeFakePm({
      listResolutions: vi.fn(async () => [makeResolution({ attemptStartedAt: null })]),
    });
    const result = await run(pm);
    expect(fakes.listMergeRequests).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, skipped: 1 });
  });

  it("NaN attemptStartedAt → skipped", async () => {
    const { pm, fakes } = makeFakePm({
      listResolutions: vi.fn(async () => [makeResolution({ attemptStartedAt: "not-a-date" })]),
    });
    const result = await run(pm);
    expect(fakes.listMergeRequests).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, skipped: 1 });
  });

  it("a non-409 per-row error is skipped (warned), not handled, never thrown", async () => {
    const { pm } = makeFakePm({
      listResolutions: vi.fn(async () => [makeResolution({})]),
      listMergeRequests: vi.fn(async () => {
        throw new PmApiError(500, "SERVER", "boom");
      }),
    });
    const result = await run(pm);
    expect(result).toMatchObject({ scanned: 1, skipped: 1, handled: 0 });
  });
});
