/**
 * C2 (failure legibility): the resolved_from FRESH RE-READ at the conflict
 * seam. `maybeOpenResolution` must not rely on the member snapshot alone —
 * a `resolved_from` written mid-flight (between snapshot and seam) must still
 * block a second resolution (the no-recursion invariant, snapshot-independent).
 *
 * Unit-level: drives maybeOpenResolution directly with a fake PmClient whose
 * getMergeRequest returns a chosen fresh view (or throws). The mid-flight
 * write is simulated by snapshot=null + fresh.resolvedFrom!=null (resolvedFrom
 * is creation-only through the API today, so the "DB injection" is the fake's
 * fresh view).
 */
import { describe, expect, it, vi } from "vitest";
import { maybeOpenResolution } from "../src/batch.js";
import { createLogger } from "../src/logger.js";
import type { PmClient } from "../src/pm-client.js";

const logger = createLogger("silent");

const ARGS = {
  projectId: "proj-1",
  resource: "main",
  originRequestId: "req-origin",
  conflictingFiles: ["feature.txt"],
  baseSha: "base123",
  ref: "feature/x",
};

function fakePm(opts: { freshResolvedFrom?: string | null; throws?: boolean }): {
  pmClient: PmClient;
  fetches: string[];
} {
  const fetches: string[] = [];
  const pmClient = {
    getMergeRequest: async (id: string) => {
      fetches.push(id);
      if (opts.throws) throw new Error("HTTP 503: PM unreachable");
      return { id, resolvedFrom: opts.freshResolvedFrom ?? null };
    },
  } as unknown as PmClient;
  return { pmClient, fetches };
}

function resolverSpy(): {
  resolver: { enabled: true; openAndEnqueue: ReturnType<typeof vi.fn> };
  openAndEnqueue: ReturnType<typeof vi.fn>;
} {
  const openAndEnqueue = vi.fn(async () => "res-1");
  return { resolver: { enabled: true as const, openAndEnqueue }, openAndEnqueue };
}

describe("maybeOpenResolution — resolved_from fresh re-read (C2)", () => {
  it("snapshot resolvedFrom != null → fast-path skip: NO fetch, NO openAndEnqueue", async () => {
    const { pmClient, fetches } = fakePm({ freshResolvedFrom: null });
    const { resolver, openAndEnqueue } = resolverSpy();

    await maybeOpenResolution(
      { resolver, logger, pmClient },
      { ...ARGS, originResolvedFrom: "req-earlier" },
    );

    expect(fetches).toHaveLength(0); // snapshot fast-path — no fetch
    expect(openAndEnqueue).not.toHaveBeenCalled();
  });

  it("snapshot null but FRESH resolvedFrom != null (written mid-flight) → openAndEnqueue NOT called", async () => {
    const { pmClient, fetches } = fakePm({ freshResolvedFrom: "req-resolved-by" });
    const { resolver, openAndEnqueue } = resolverSpy();

    await maybeOpenResolution(
      { resolver, logger, pmClient },
      { ...ARGS, originResolvedFrom: null },
    );

    expect(fetches).toEqual(["req-origin"]);
    expect(openAndEnqueue).not.toHaveBeenCalled();
  });

  it("fetch throws → conservative skip: openAndEnqueue NOT called, NOTHING thrown (drain-loop safety)", async () => {
    const { pmClient } = fakePm({ throws: true });
    const { resolver, openAndEnqueue } = resolverSpy();

    await expect(
      maybeOpenResolution({ resolver, logger, pmClient }, { ...ARGS, originResolvedFrom: null }),
    ).resolves.toBeUndefined();
    expect(openAndEnqueue).not.toHaveBeenCalled();
  });

  it("fresh resolvedFrom null → openAndEnqueue called exactly once", async () => {
    const { pmClient, fetches } = fakePm({ freshResolvedFrom: null });
    const { resolver, openAndEnqueue } = resolverSpy();

    await maybeOpenResolution(
      { resolver, logger, pmClient },
      { ...ARGS, originResolvedFrom: null },
    );

    expect(fetches).toEqual(["req-origin"]);
    expect(openAndEnqueue).toHaveBeenCalledTimes(1);
    expect(openAndEnqueue).toHaveBeenCalledWith({
      originRequestId: "req-origin",
      conflictingFiles: ["feature.txt"],
      baseSha: "base123",
      ref: "feature/x",
    });
  });

  it("resolver disabled → no fetch, no openAndEnqueue (inert off-path)", async () => {
    const { pmClient, fetches } = fakePm({ freshResolvedFrom: null });
    const openAndEnqueue = vi.fn(async () => "res-1");

    await maybeOpenResolution(
      {
        resolver: { enabled: false, openAndEnqueue },
        logger,
        pmClient,
      },
      { ...ARGS, originResolvedFrom: null },
    );

    expect(fetches).toHaveLength(0);
    expect(openAndEnqueue).not.toHaveBeenCalled();
  });

  it("legacy client WITHOUT getMergeRequest → snapshot-only behavior (resolution still opens)", async () => {
    // The 7.6-era fake clients (batch.test.ts) carry no getMergeRequest; the
    // seam must keep their snapshot-only semantics rather than skipping.
    const pmClient = {} as unknown as PmClient;
    const { resolver, openAndEnqueue } = resolverSpy();

    await maybeOpenResolution(
      { resolver, logger, pmClient },
      { ...ARGS, originResolvedFrom: null },
    );

    expect(openAndEnqueue).toHaveBeenCalledTimes(1);
  });
});
