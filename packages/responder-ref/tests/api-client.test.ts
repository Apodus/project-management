import { describe, it, expect, vi } from "vitest";
import { ResponderClient, PmApiError } from "../src/api-client.js";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ResponderClient", () => {
  it("listOpenEscalations builds /projects/{id}/escalations?status=open and unwraps {data} (pagination envelope)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ id: "e1", status: "open" }], pagination: { total: 1 } }),
    );
    const client = new ResponderClient({
      baseUrl: "http://h:3000",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.listOpenEscalations("proj-1");
    expect(out).toEqual([{ id: "e1", status: "open" }]);
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toBe("http://h:3000/api/v1/projects/proj-1/escalations?status=open");
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("GET");
  });

  it("acknowledge POSTs the right path with NO body and unwraps {data}", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { id: "esc-1", status: "acknowledged", holderId: "me" } }),
    );
    const client = new ResponderClient({
      baseUrl: "http://h:3000",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.acknowledge("esc-1");
    expect(out).toEqual({ id: "esc-1", status: "acknowledged", holderId: "me" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://h:3000/api/v1/escalations/esc-1/acknowledge");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("getMe GETs /auth/me and unwraps {data}", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { id: "u-self", type: "ai_agent", username: "responder" } }),
    );
    const client = new ResponderClient({
      baseUrl: "http://h:3000",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const me = await client.getMe();
    expect(me.id).toBe("u-self");
    expect(me.type).toBe("ai_agent");
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toBe("http://h:3000/api/v1/auth/me");
  });

  it("submitMergeRequest POSTs /projects/{id}/merge-requests with the body and unwraps {data}", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { data: { id: "mr-1", branch: "pm/escalation-e1", commitSha: "abc123" } },
        201,
      ),
    );
    const client = new ResponderClient({
      baseUrl: "http://h:3000",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.submitMergeRequest("proj-1", {
      resource: "main",
      taskId: null,
      branch: "pm/escalation-e1",
      commitSha: "abc123",
      verifyCmd: null,
      escalationId: "e1",
    });
    expect(out).toEqual({ id: "mr-1", branch: "pm/escalation-e1", commitSha: "abc123" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://h:3000/api/v1/projects/proj-1/merge-requests");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({
      resource: "main",
      taskId: null,
      branch: "pm/escalation-e1",
      escalationId: "e1",
    });
  });

  it("submitMergeRequest maps a non-ok JSON error body to PmApiError", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "VALIDATION_ERROR", message: "bad" } }, 400),
    );
    const client = new ResponderClient({
      baseUrl: "http://h:3000",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await client
      .submitMergeRequest("proj-1", {
        resource: "main",
        taskId: null,
        branch: "b",
        commitSha: null,
        verifyCmd: null,
        escalationId: "e1",
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PmApiError);
    expect((err as PmApiError).status).toBe(400);
    expect((err as PmApiError).code).toBe("VALIDATION_ERROR");
  });

  it("createEpic POSTs /projects/{id}/epics with the body and unwraps {data} → {id}", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { id: "epic-1", name: "Systemic rework" } }, 201),
    );
    const client = new ResponderClient({
      baseUrl: "http://h:3000",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.createEpic("proj-1", {
      name: "Systemic rework",
      description: "Auto-driven vision for escalation e1",
      priority: "high",
    });
    expect(out).toEqual({ id: "epic-1", name: "Systemic rework" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://h:3000/api/v1/projects/proj-1/epics");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({
      name: "Systemic rework",
      priority: "high",
    });
  });

  it("createEpic maps a non-ok JSON error body to PmApiError", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "VALIDATION_ERROR", message: "bad" } }, 400),
    );
    const client = new ResponderClient({
      baseUrl: "http://h:3000",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await client.createEpic("proj-1", { name: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(PmApiError);
    expect((err as PmApiError).status).toBe(400);
    expect((err as PmApiError).code).toBe("VALIDATION_ERROR");
  });

  it("createTask POSTs /projects/{id}/tasks with {title,epicId,...} and unwraps {data} → {id}", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { id: "task-1" } }, 201));
    const client = new ResponderClient({
      baseUrl: "http://h:3000",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.createTask("proj-1", {
      title: "C1",
      description: "d",
      epicId: "epic-1",
      priority: "high",
    });
    expect(out).toEqual({ id: "task-1" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://h:3000/api/v1/projects/proj-1/tasks");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({
      title: "C1",
      epicId: "epic-1",
      priority: "high",
    });
  });

  it("createTask maps a non-ok JSON error body to PmApiError", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "VALIDATION_ERROR", message: "bad" } }, 400),
    );
    const client = new ResponderClient({
      baseUrl: "http://h:3000",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await client.createTask("proj-1", { title: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(PmApiError);
    expect((err as PmApiError).status).toBe(400);
    expect((err as PmApiError).code).toBe("VALIDATION_ERROR");
  });

  it("maps a 403 JSON error body to PmApiError(403)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "FORBIDDEN", message: "held by another" } }, 403),
    );
    const client = new ResponderClient({
      baseUrl: "http://h:3000",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await client.acknowledge("e1").catch((e) => e);
    expect(err).toBeInstanceOf(PmApiError);
    expect((err as PmApiError).status).toBe(403);
    expect((err as PmApiError).code).toBe("FORBIDDEN");
  });

  it("wraps a fetch rejection as PmApiError(0, NETWORK)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("connection refused");
    });
    const client = new ResponderClient({
      baseUrl: "http://h:3000",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.listOpenEscalations("p")).rejects.toMatchObject({
      name: "PmApiError",
      status: 0,
      code: "NETWORK",
    });
  });
});
