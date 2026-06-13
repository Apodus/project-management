import { describe, it, expect, vi } from "vitest";
import { WakeClient, PmApiError } from "../src/api-client.js";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("WakeClient", () => {
  it("listUndelivered builds worker_key query and unwraps {data}", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ unreadCount: 1 }] }));
    const client = new WakeClient({
      baseUrl: "http://h:3000",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.listUndelivered("worker-1");
    expect(out).toEqual([{ unreadCount: 1 }]);
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toBe("http://h:3000/api/v1/escalations/undelivered?worker_key=worker-1");
  });

  it("listUndelivered appends project_id when given", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = new WakeClient({
      baseUrl: "http://h:3000",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.listUndelivered("wk a", "proj 9");
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toBe(
      "http://h:3000/api/v1/escalations/undelivered?worker_key=wk%20a&project_id=proj%209",
    );
  });

  it("markDelivered POSTs {workerKey, uptoSeq} and unwraps {data}", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { id: "esc-1", status: "answered" } }));
    const client = new WakeClient({
      baseUrl: "http://h:3000",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.markDelivered("esc-1", "worker-1", 7);
    expect(out).toEqual({ id: "esc-1", status: "answered" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://h:3000/api/v1/escalations/esc-1/mark-delivered");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ workerKey: "worker-1", uptoSeq: 7 });
  });

  it("wraps a fetch rejection as PmApiError(0, NETWORK)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("connection refused");
    });
    const client = new WakeClient({
      baseUrl: "http://h:3000",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.listUndelivered("w")).rejects.toMatchObject({
      name: "PmApiError",
      status: 0,
      code: "NETWORK",
    });
  });

  it("maps a non-ok JSON error body to PmApiError(status, code)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "FORBIDDEN", message: "nope" } }, 403),
    );
    const client = new WakeClient({
      baseUrl: "http://h:3000",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await client.markDelivered("e", "w", 1).catch((e) => e);
    expect(err).toBeInstanceOf(PmApiError);
    expect((err as PmApiError).status).toBe(403);
    expect((err as PmApiError).code).toBe("FORBIDDEN");
  });
});
