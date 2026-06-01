/**
 * Phase 7.6 Step 7 — the resolver onOutcome handler (resolution-outcome.ts).
 *
 * Pure unit tests over fakes (no git, no HTTP): a fake pmClient records calls
 * and a fake gitOps controls the push outcome. The handler is the STEP-7 seam:
 * on `resolved` it pushes + resubmits + records; on `escalate` it transitions +
 * comments. Critical contracts verified here:
 *   - verifyCmd PROPAGATION: the resubmitted request copies origin.verifyCmd.
 *   - resolvedFrom = origin id (the no-recursion marker).
 *   - PARTIAL-FAILURE: a resolvedResolution throw AFTER a successful submit does
 *     NOT escalate (it would be a lie) and does NOT double-submit.
 */
import { describe, it, expect, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import { makeOnOutcome } from "../src/resolution-outcome.js";
import type { ResolutionOutcome } from "../src/resolver-pool.js";
import type { PushResult } from "../src/git-ops.js";

const logger = createLogger("error");
const cfg = { projectId: "proj-1", gitRemote: "origin" };

function makeResolvedOutcome(
  over?: Partial<Extract<ResolutionOutcome, { kind: "resolved" }>>,
): Extract<ResolutionOutcome, { kind: "resolved" }> {
  return {
    kind: "resolved",
    resolutionId: "res-1",
    resolvedCommitSha: "deadbeef",
    worktreePath: "/wt/resolver-0",
    detail: { budgetConsumedSec: 12, verifyVerdict: "pass" },
    job: {
      resolutionId: "res-1",
      originRequestId: "req-origin",
      conflictingFiles: ["src/a.ts", "src/b.ts"],
      baseSha: "base-sha",
      ref: "feature/x",
      resource: "main",
    },
    ...over,
  };
}

function makeEscalateOutcome(
  over?: Partial<Extract<ResolutionOutcome, { kind: "escalate" }>>,
): Extract<ResolutionOutcome, { kind: "escalate" }> {
  return {
    kind: "escalate",
    resolutionId: "res-2",
    state: "escalated",
    reason: "verify_failed",
    detail: { budgetConsumedSec: 30, escalationReason: "verify_failed" },
    job: {
      resolutionId: "res-2",
      originRequestId: "req-origin",
      conflictingFiles: ["src/c.ts"],
      baseSha: "base-sha",
      ref: "feature/y",
      resource: "main",
    },
    ...over,
  };
}

interface FakeOrigin {
  id: string;
  taskId: string | null;
  verifyCmd: string | null;
}

function makeDeps(opts: {
  origin?: FakeOrigin | null;
  getMergeRequestThrows?: boolean;
  push?: PushResult;
  submitThrows?: boolean;
  resolvedThrows?: boolean;
}) {
  const calls: { name: string; args: unknown }[] = [];
  const record = (name: string, args: unknown) => calls.push({ name, args });

  const origin: FakeOrigin = opts.origin ?? {
    id: "req-origin",
    taskId: "task-7",
    verifyCmd: "pnpm verify:special",
  };

  const pmClient = {
    getMergeRequest: vi.fn(async (id: string) => {
      record("getMergeRequest", id);
      if (opts.getMergeRequestThrows) throw new Error("getMergeRequest boom");
      return origin as unknown as never;
    }),
    submitMergeRequest: vi.fn(async (params: unknown) => {
      record("submitMergeRequest", params);
      if (opts.submitThrows) throw new Error("submit boom");
      return { id: "req-new" } as unknown as never;
    }),
    resolvedResolution: vi.fn(async (id: string, body: unknown) => {
      record("resolvedResolution", { id, body });
      if (opts.resolvedThrows) throw new Error("resolved boom");
      return {} as unknown as never;
    }),
    escalateResolution: vi.fn(async (id: string, body: unknown) => {
      record("escalateResolution", { id, body });
      return {} as unknown as never;
    }),
    postTaskComment: vi.fn(async (taskId: string, body: unknown) => {
      record("postTaskComment", { taskId, body });
    }),
  };

  const pushResult: PushResult = opts.push ?? { ok: true, pushedSha: "pushedsha" };
  const makeGitOps = (worktreePath: string) => {
    record("makeGitOps", worktreePath);
    return {
      push: vi.fn(async (remote: string, branch: string): Promise<PushResult> => {
        record("push", { remote, branch });
        return pushResult;
      }),
    };
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onOutcome = makeOnOutcome({ pmClient: pmClient as any, makeGitOps: makeGitOps as any, logger, cfg });
  return { onOutcome, pmClient, calls };
}

function names(calls: { name: string }[]): string[] {
  return calls.map((c) => c.name);
}

describe("makeOnOutcome — resolved", () => {
  it("(a) happy path: getMergeRequest → push(remote, pm/resolution-<id>) → submit(resolvedFrom, verifyCmd) → resolvedResolution(resolvedRequestId)", async () => {
    const { onOutcome, pmClient, calls } = makeDeps({});
    const outcome = makeResolvedOutcome();
    await onOutcome(outcome);

    // origin fetched
    expect(pmClient.getMergeRequest).toHaveBeenCalledWith("req-origin");

    // push with the stable resolution branch
    const push = calls.find((c) => c.name === "push");
    expect(push?.args).toEqual({
      remote: "origin",
      branch: "pm/resolution-res-1",
    });

    // submit copies verifyCmd + sets resolvedFrom = origin id + origin taskId
    expect(pmClient.submitMergeRequest).toHaveBeenCalledTimes(1);
    const submitArgs = pmClient.submitMergeRequest.mock.calls[0][0] as {
      projectId: string;
      resource: string;
      taskId: string | null;
      branch: string;
      verifyCmd: string | null;
      resolvedFrom: string | null;
    };
    expect(submitArgs.projectId).toBe("proj-1");
    expect(submitArgs.resource).toBe("main");
    expect(submitArgs.taskId).toBe("task-7");
    expect(submitArgs.branch).toBe("pm/resolution-res-1");
    expect(submitArgs.verifyCmd).toBe("pnpm verify:special"); // PROPAGATED
    expect(submitArgs.resolvedFrom).toBe("req-origin"); // no-recursion marker

    // resolvedResolution cross-links the new request
    expect(pmClient.resolvedResolution).toHaveBeenCalledTimes(1);
    const resolvedArgs = pmClient.resolvedResolution.mock.calls[0];
    expect(resolvedArgs[0]).toBe("res-1");
    expect((resolvedArgs[1] as { resolvedRequestId: string }).resolvedRequestId).toBe("req-new");

    // never escalated, never commented
    expect(pmClient.escalateResolution).not.toHaveBeenCalled();
    expect(pmClient.postTaskComment).not.toHaveBeenCalled();
  });

  it("(c) push fails ⇒ escalate failed (resubmit_push_failed) + merge_rejection comment; NO submit", async () => {
    const { onOutcome, pmClient } = makeDeps({
      push: { ok: false, reason: "network", stderr: "no remote" },
    });
    await onOutcome(makeResolvedOutcome());

    expect(pmClient.submitMergeRequest).not.toHaveBeenCalled();
    expect(pmClient.escalateResolution).toHaveBeenCalledTimes(1);
    const esc = pmClient.escalateResolution.mock.calls[0][1] as {
      state: string;
      target: string;
      reason: string;
    };
    expect(esc.state).toBe("failed");
    expect(esc.target).toBe("author");
    expect(esc.reason).toBe("resubmit_push_failed");

    // comment posted on the origin task with the fix-forward note
    expect(pmClient.postTaskComment).toHaveBeenCalledTimes(1);
    const comment = pmClient.postTaskComment.mock.calls[0];
    expect(comment[0]).toBe("task-7");
    const cbody = comment[1] as { body: string; commentType: string };
    expect(cbody.commentType).toBe("merge_rejection");
    expect(cbody.body).toContain("fix forward, don't redo");
    expect(cbody.body).toContain("src/a.ts");
  });

  it("(d) submit throws ⇒ escalate failed (resubmit_submit_failed) + comment", async () => {
    const { onOutcome, pmClient } = makeDeps({ submitThrows: true });
    await onOutcome(makeResolvedOutcome());

    expect(pmClient.submitMergeRequest).toHaveBeenCalledTimes(1);
    expect(pmClient.resolvedResolution).not.toHaveBeenCalled();
    expect(pmClient.escalateResolution).toHaveBeenCalledTimes(1);
    const esc = pmClient.escalateResolution.mock.calls[0][1] as { state: string; reason: string };
    expect(esc.state).toBe("failed");
    expect(esc.reason).toBe("resubmit_submit_failed");
    expect(pmClient.postTaskComment).toHaveBeenCalledTimes(1);
  });

  it("(e) resolvedResolution throws AFTER submit success ⇒ does NOT escalate, does NOT double-submit, logs only", async () => {
    const { onOutcome, pmClient } = makeDeps({ resolvedThrows: true });
    await onOutcome(makeResolvedOutcome());

    // submit happened exactly once (the resolved tree is on the train)
    expect(pmClient.submitMergeRequest).toHaveBeenCalledTimes(1);
    // resolvedResolution attempted once and threw
    expect(pmClient.resolvedResolution).toHaveBeenCalledTimes(1);
    // CRITICAL: NO escalation (that would be a lie) and NO comment
    expect(pmClient.escalateResolution).not.toHaveBeenCalled();
    expect(pmClient.postTaskComment).not.toHaveBeenCalled();
  });
});

describe("makeOnOutcome — escalate", () => {
  it("(b) escalate ⇒ escalateResolution(state, target author, reason) + merge_rejection comment with fix-forward note", async () => {
    const { onOutcome, pmClient } = makeDeps({});
    await onOutcome(makeEscalateOutcome());

    expect(pmClient.escalateResolution).toHaveBeenCalledTimes(1);
    const esc = pmClient.escalateResolution.mock.calls[0];
    expect(esc[0]).toBe("res-2");
    const escBody = esc[1] as { state: string; target: string; reason: string };
    expect(escBody.state).toBe("escalated");
    expect(escBody.target).toBe("author");
    expect(escBody.reason).toBe("verify_failed");

    // comment on the origin task
    expect(pmClient.postTaskComment).toHaveBeenCalledTimes(1);
    const comment = pmClient.postTaskComment.mock.calls[0];
    expect(comment[0]).toBe("task-7");
    const cbody = comment[1] as { body: string; commentType: string };
    expect(cbody.commentType).toBe("merge_rejection");
    expect(cbody.body).toContain("fix forward, don't redo");
    expect(cbody.body).toContain("src/c.ts");

    // resolved-path methods untouched
    expect(pmClient.submitMergeRequest).not.toHaveBeenCalled();
    expect(pmClient.resolvedResolution).not.toHaveBeenCalled();
  });

  it("escalate ⇒ escalateResolution called exactly ONCE (not double-escalated by the comment helper)", async () => {
    const { onOutcome, pmClient } = makeDeps({});
    await onOutcome(makeEscalateOutcome({ state: "failed", reason: "infra_error" }));
    expect(pmClient.escalateResolution).toHaveBeenCalledTimes(1);
    expect((pmClient.escalateResolution.mock.calls[0][1] as { state: string }).state).toBe("failed");
  });

  it("(f) null origin.taskId on escalate ⇒ no comment, no throw", async () => {
    const { onOutcome, pmClient } = makeDeps({
      origin: { id: "req-origin", taskId: null, verifyCmd: "x" },
    });
    await onOutcome(makeEscalateOutcome());
    expect(pmClient.escalateResolution).toHaveBeenCalledTimes(1);
    expect(pmClient.postTaskComment).not.toHaveBeenCalled();
  });
});
