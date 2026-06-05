/**
 * PmClient unit tests (phase 7.2 Step 7).
 *
 * Uses a fetchImpl stub to capture the exact HTTP method/URL/body the client
 * sends. Focus: the Step-7 additions — postBatchEvent relay, and the optional
 * batchId/speculativePosition tags on pickup/startAttempt (sent when supplied,
 * omitted when not).
 */
import { describe, it, expect } from "vitest";
import { PmClient, PmApiError } from "../src/pm-client.js";
import type { BatchEvent } from "../src/batch.js";

interface CapturedCall {
  method: string;
  url: string;
  body: unknown;
}

function makeClient(): { client: PmClient; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    // 202 with a JSON envelope (the batch relay shape); also fine for the
    // request helper's data-unwrap path.
    return new Response(JSON.stringify({ data: { ok: true } }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const client = new PmClient({
    baseUrl: "http://pm.local",
    token: "tok",
    fetchImpl,
  });
  return { client, calls };
}

describe("PmClient.postBatchEvent", () => {
  const markers: BatchEvent[] = [
    {
      type: "started",
      batchId: "b1",
      resource: "main",
      memberCount: 2,
      memberRequestIds: ["r1", "r2"],
    },
    {
      type: "member_landed",
      batchId: "b1",
      requestId: "r1",
      speculativePosition: 0,
      landedSha: "sha0",
    },
    {
      type: "member_invalidated",
      batchId: "b1",
      requestId: "r2",
      speculativePosition: 1,
      reason: "predecessor r1 failed",
      failedPredecessorRequestId: "r1",
    },
    {
      type: "completed",
      batchId: "b1",
      landed: 1,
      rejected: 1,
      invalidated: 0,
    },
  ];

  for (const marker of markers) {
    it(`POSTs the ${marker.type} marker to the relay URL with the marker body`, async () => {
      const { client, calls } = makeClient();
      await client.postBatchEvent("proj-1", marker);

      expect(calls.length).toBe(1);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toBe("http://pm.local/api/v1/projects/proj-1/merge-batches/events");
      expect(calls[0].body).toEqual(marker);
    });
  }

  it("URL-encodes the projectId", async () => {
    const { client, calls } = makeClient();
    await client.postBatchEvent("proj/odd id", {
      type: "completed",
      batchId: "b",
      landed: 0,
      rejected: 0,
      invalidated: 0,
    });
    expect(calls[0].url).toBe(
      "http://pm.local/api/v1/projects/proj%2Fodd%20id/merge-batches/events",
    );
  });

  it("wires onBatchEvent → postBatchEvent (the Step-9 integration shape)", async () => {
    const { client, calls } = makeClient();
    const onBatchEvent = (e: BatchEvent): void => {
      void client.postBatchEvent("proj-1", e);
    };
    onBatchEvent({
      type: "started",
      batchId: "bX",
      resource: "main",
      memberCount: 0,
      memberRequestIds: [],
    });
    // Allow the fire-and-forget promise to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(1);
    expect(calls[0].body).toMatchObject({ type: "started", batchId: "bX" });
  });
});

describe("PmClient verify cache (lookup / record / mismatch)", () => {
  // A client whose fetch returns a caller-supplied JSON body + status.
  function makeClientWith(
    responseBody: unknown,
    status = 200,
  ): { client: PmClient; calls: CapturedCall[] } {
    const calls: CapturedCall[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(url),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify(responseBody), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new PmClient({
      baseUrl: "http://pm.local",
      token: "tok",
      fetchImpl,
    });
    return { client, calls };
  }

  const row = {
    id: "vc-1",
    projectId: "proj-1",
    resource: "main",
    treeSha: "t-1",
    stepId: "lint",
    stepConfigSha: "cfg-1",
    result: "pass" as const,
    durationMs: 4200,
    logExcerpt: "ok",
    logUrl: null,
    createdAt: "2026-05-30T12:00:00.000Z",
    lastHitAt: "2026-05-30T12:00:05.000Z",
    hitCount: 1,
    updatedAt: "2026-05-30T12:00:05.000Z",
  };

  it("lookupVerifyCache POSTs the key and unwraps a HIT row", async () => {
    const { client, calls } = makeClientWith({ data: row });
    const result = await client.lookupVerifyCache("proj-1", {
      resource: "main",
      treeSha: "t-1",
      stepId: "lint",
      stepConfigSha: "cfg-1",
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://pm.local/api/v1/projects/proj-1/verify-cache/lookup");
    expect(calls[0].body).toEqual({
      resource: "main",
      treeSha: "t-1",
      stepId: "lint",
      stepConfigSha: "cfg-1",
    });
    expect(result).toEqual(row);
  });

  it("lookupVerifyCache unwraps a MISS (data:null) to null", async () => {
    const { client } = makeClientWith({ data: null });
    const result = await client.lookupVerifyCache("proj-1", {
      resource: "main",
      treeSha: "t-x",
      stepId: "lint",
      stepConfigSha: "cfg-1",
    });
    expect(result).toBeNull();
  });

  it("recordVerifyCache POSTs the verdict body to /record and returns the row", async () => {
    const { client, calls } = makeClientWith({ data: row });
    const result = await client.recordVerifyCache("proj-1", {
      resource: "main",
      treeSha: "t-1",
      stepId: "lint",
      stepConfigSha: "cfg-1",
      result: "pass",
      durationMs: 4200,
      logExcerpt: "ok",
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://pm.local/api/v1/projects/proj-1/verify-cache/record");
    expect(calls[0].body).toEqual({
      resource: "main",
      treeSha: "t-1",
      stepId: "lint",
      stepConfigSha: "cfg-1",
      result: "pass",
      durationMs: 4200,
      logExcerpt: "ok",
    });
    expect(result).toEqual(row);
  });

  it("emitVerifyCacheMismatch POSTs to /mismatch and tolerates a 202", async () => {
    const { client, calls } = makeClientWith({ data: { ok: true } }, 202);
    await client.emitVerifyCacheMismatch("proj-1", {
      resource: "main",
      treeSha: "t-1",
      stepId: "unit",
      stepConfigSha: "cfg-1",
      cachedResult: "pass",
      realResult: "fail",
      requestId: "req-1",
      attemptId: "att-1",
    });
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://pm.local/api/v1/projects/proj-1/verify-cache/mismatch");
    expect(calls[0].body).toMatchObject({
      treeSha: "t-1",
      cachedResult: "pass",
      realResult: "fail",
    });
  });
});

describe("PmClient.request error wrapping (total infra discriminator)", () => {
  // A request() failure must ALWAYS surface as a PmApiError so the integrator's
  // `isApiError` is a reliable "PM/infra fault" discriminator. status 0 signals
  // a transport-level fault (network reject / JSON parse), distinct from an HTTP
  // non-ok PmApiError (status = the HTTP code).
  function makeClientWithFetch(fetchImpl: typeof fetch): PmClient {
    return new PmClient({ baseUrl: "http://pm.local", token: "tok", fetchImpl });
  }

  it("wraps a fetch rejection (raw TypeError) as a PmApiError status 0 NETWORK", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = makeClientWithFetch(fetchImpl);
    const err = await client
      .getProject("proj-1")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PmApiError);
    expect((err as PmApiError).status).toBe(0);
    expect((err as PmApiError).code).toBe("NETWORK");
    expect((err as PmApiError).message).toContain("ECONNREFUSED");
  });

  it("wraps a JSON parse failure as a PmApiError status 0 PARSE", async () => {
    const fetchImpl = (async () =>
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const client = makeClientWithFetch(fetchImpl);
    const err = await client
      .getProject("proj-1")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PmApiError);
    expect((err as PmApiError).status).toBe(0);
    expect((err as PmApiError).code).toBe("PARSE");
  });

  it("keeps an HTTP non-ok PmApiError unchanged (status = the HTTP code)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "nope" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const client = makeClientWithFetch(fetchImpl);
    const err = await client
      .getProject("proj-1")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PmApiError);
    expect((err as PmApiError).status).toBe(404);
    expect((err as PmApiError).code).toBe("NOT_FOUND");
  });
});

describe("PmClient pickup/startAttempt batch tags", () => {
  it("pickup sends batchId/speculativePosition when tags supplied", async () => {
    const { client, calls } = makeClient();
    await client.pickupMergeRequest("req-1", {
      batchId: "b1",
      speculativePosition: 3,
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://pm.local/api/v1/merge-requests/req-1/pickup");
    expect(calls[0].body).toEqual({ batchId: "b1", speculativePosition: 3 });
  });

  it("pickup sends an empty body when no tags supplied (7.1 behavior)", async () => {
    const { client, calls } = makeClient();
    await client.pickupMergeRequest("req-1");
    expect(calls[0].body).toEqual({});
  });

  it("startAttempt sends baseSha + tags when supplied", async () => {
    const { client, calls } = makeClient();
    await client.startAttempt("req-1", "base000", {
      batchId: "b1",
      speculativePosition: 2,
    });
    expect(calls[0].url).toBe("http://pm.local/api/v1/merge-requests/req-1/attempts");
    expect(calls[0].body).toEqual({
      baseSha: "base000",
      batchId: "b1",
      speculativePosition: 2,
    });
  });

  it("startAttempt sends only baseSha when no tags supplied (7.1 behavior)", async () => {
    const { client, calls } = makeClient();
    await client.startAttempt("req-1", "base000");
    expect(calls[0].body).toEqual({ baseSha: "base000" });
  });
});
