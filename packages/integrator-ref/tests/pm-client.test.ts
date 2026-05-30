/**
 * PmClient unit tests (phase 7.2 Step 7).
 *
 * Uses a fetchImpl stub to capture the exact HTTP method/URL/body the client
 * sends. Focus: the Step-7 additions — postBatchEvent relay, and the optional
 * batchId/speculativePosition tags on pickup/startAttempt (sent when supplied,
 * omitted when not).
 */
import { describe, it, expect } from "vitest";
import { PmClient } from "../src/pm-client.js";
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
      expect(calls[0].url).toBe(
        "http://pm.local/api/v1/projects/proj-1/merge-batches/events",
      );
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

describe("PmClient pickup/startAttempt batch tags", () => {
  it("pickup sends batchId/speculativePosition when tags supplied", async () => {
    const { client, calls } = makeClient();
    await client.pickupMergeRequest("req-1", {
      batchId: "b1",
      speculativePosition: 3,
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      "http://pm.local/api/v1/merge-requests/req-1/pickup",
    );
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
    expect(calls[0].url).toBe(
      "http://pm.local/api/v1/merge-requests/req-1/attempts",
    );
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
