import { describe, it, expect, vi } from "vitest";
import { TriagerClient, PmApiError } from "../src/api-client.js";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mkClient(fetchImpl: unknown): TriagerClient {
  return new TriagerClient({
    baseUrl: "http://h:3000",
    token: "t",
    fetchImpl: fetchImpl as typeof fetch,
  });
}

describe("TriagerClient", () => {
  it("listOpenNotes builds /projects/{id}/notes?status=open and unwraps {data} (pagination envelope)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ id: "n1", status: "open" }], pagination: { total: 1 } }),
    );
    const client = mkClient(fetchImpl);
    const out = await client.listOpenNotes("proj-1");
    expect(out).toEqual([{ id: "n1", status: "open" }]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://h:3000/api/v1/projects/proj-1/notes?status=open");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("getProject GETs /projects/{id} and unwraps {data} (null settings tolerated)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { id: "proj-1", settings: null } }));
    const client = mkClient(fetchImpl);
    const out = await client.getProject("proj-1");
    expect(out).toEqual({ id: "proj-1", settings: null });
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toBe("http://h:3000/api/v1/projects/proj-1");
  });

  it("getProject reads a parsed settings.notesTriage object on the wire", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: { id: "proj-1", settings: { notesTriage: { enabled: true, mode: "on" } } },
      }),
    );
    const client = mkClient(fetchImpl);
    const out = await client.getProject("proj-1");
    expect(out.settings?.notesTriage).toEqual({ enabled: true, mode: "on" });
  });

  it("recordTriageDecision POSTs /projects/{id}/triage-decisions with the body and unwraps {data}", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { data: { id: "td-1", noteId: "n1", mode: "shadow", decision: "dismiss" } },
        201,
      ),
    );
    const client = mkClient(fetchImpl);
    const out = await client.recordTriageDecision("proj-1", {
      noteId: "n1",
      mode: "shadow",
      decision: "dismiss",
      rationale: "stale",
    });
    expect(out).toMatchObject({ id: "td-1", noteId: "n1", decision: "dismiss" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://h:3000/api/v1/projects/proj-1/triage-decisions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({
      noteId: "n1",
      mode: "shadow",
      decision: "dismiss",
      rationale: "stale",
    });
  });

  it("getMe GETs /auth/me and unwraps {data}", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { id: "u-self", type: "ai_agent", username: "triager" } }),
    );
    const client = mkClient(fetchImpl);
    const me = await client.getMe();
    expect(me.id).toBe("u-self");
    expect(me.type).toBe("ai_agent");
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toBe("http://h:3000/api/v1/auth/me");
  });

  it("maps a non-ok JSON error envelope to PmApiError(status, code)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "VALIDATION_ERROR", message: "bad" } }, 400),
    );
    const client = mkClient(fetchImpl);
    const err = await client
      .recordTriageDecision("proj-1", { noteId: "n1", mode: "on", decision: "give_up" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PmApiError);
    expect((err as PmApiError).status).toBe(400);
    expect((err as PmApiError).code).toBe("VALIDATION_ERROR");
  });

  it("wraps a fetch rejection as PmApiError(0, NETWORK)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("connection refused");
    });
    const client = mkClient(fetchImpl);
    await expect(client.listOpenNotes("p")).rejects.toMatchObject({
      name: "PmApiError",
      status: 0,
      code: "NETWORK",
    });
  });

  it("maps a non-JSON non-ok response to PmApiError(status, UNKNOWN_ERROR)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("upstream boom", { status: 502, headers: { "content-type": "text/plain" } }),
    );
    const client = mkClient(fetchImpl);
    const err = await client.getProject("p").catch((e) => e);
    expect(err).toBeInstanceOf(PmApiError);
    expect((err as PmApiError).status).toBe(502);
    expect((err as PmApiError).code).toBe("UNKNOWN_ERROR");
  });
});
