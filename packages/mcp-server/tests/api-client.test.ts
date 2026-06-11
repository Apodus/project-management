import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  apiRequest,
  ApiError,
  claimAgent,
  createNote,
  getEpicGraph,
  listLabels,
  promoteNoteToProposal,
  releaseAgent,
  getAgentIdentity,
  shouldReleaseOnShutdown,
} from "../src/api-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(response: {
  status: number;
  ok: boolean;
  body: unknown;
  contentType?: string;
}): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    status: response.status,
    ok: response.ok,
    statusText: response.ok ? "OK" : "Error",
    headers: new Headers({
      "content-type": response.contentType ?? "application/json",
    }),
    json: vi.fn().mockResolvedValue(response.body),
    // Faithful Response mock: error paths now read the body ONCE via text()
    // (readErrorBody, C2) — serve the same body as text, like a real Response.
    text: vi.fn().mockResolvedValue(JSON.stringify(response.body)),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("apiRequest", () => {
  beforeEach(() => {
    process.env.PM_API_URL = "http://test-server:9999";
    process.env.PM_API_TOKEN = "test-token-123";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PM_API_URL;
    delete process.env.PM_API_TOKEN;
  });

  it("constructs the correct URL with /api/v1 prefix", async () => {
    const fetchMock = mockFetch({ status: 200, ok: true, body: { data: [] } });

    await apiRequest("GET", "/projects");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test-server:9999/api/v1/projects");
  });

  it("sets Authorization header with Bearer token", async () => {
    const fetchMock = mockFetch({ status: 200, ok: true, body: { data: {} } });

    await apiRequest("GET", "/projects/123");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer test-token-123");
  });

  it("sets Content-Type for requests with body", async () => {
    const fetchMock = mockFetch({
      status: 201,
      ok: true,
      body: { data: { id: "1" } },
    });

    await apiRequest("POST", "/proposals/abc/comments", { body: "hello" });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ body: "hello" });
  });

  it("does not set Content-Type for GET requests", async () => {
    const fetchMock = mockFetch({ status: 200, ok: true, body: { data: [] } });

    await apiRequest("GET", "/projects");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it("extracts data from response envelope", async () => {
    mockFetch({
      status: 200,
      ok: true,
      body: { data: [{ id: "1", name: "Test Project" }] },
    });

    const result = await apiRequest<Array<{ id: string; name: string }>>("GET", "/projects");

    expect(result).toEqual([{ id: "1", name: "Test Project" }]);
  });

  it("uses default URL when PM_API_URL is not set", async () => {
    delete process.env.PM_API_URL;
    const fetchMock = mockFetch({ status: 200, ok: true, body: { data: [] } });

    await apiRequest("GET", "/projects");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/v1/projects");
  });

  it("throws when PM_API_TOKEN is not set", async () => {
    delete process.env.PM_API_TOKEN;

    await expect(apiRequest("GET", "/projects")).rejects.toThrow(
      "PM_API_TOKEN environment variable is required",
    );
  });

  it("throws ApiError on HTTP error with error body", async () => {
    mockFetch({
      status: 404,
      ok: false,
      body: { error: { code: "NOT_FOUND", message: "Project not found" } },
    });

    try {
      await apiRequest("GET", "/projects/missing");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.code).toBe("NOT_FOUND");
      expect(apiErr.message).toBe("Project not found");
    }
  });

  it("throws ApiError on HTTP error without error body", async () => {
    mockFetch({
      status: 500,
      ok: false,
      body: {},
    });

    try {
      await apiRequest("GET", "/projects");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(500);
      expect(apiErr.code).toBe("UNKNOWN_ERROR");
    }
  });

  it("handles non-JSON error responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 502,
        ok: false,
        statusText: "Bad Gateway",
        headers: new Headers({ "content-type": "text/html" }),
        json: vi.fn().mockRejectedValue(new Error("not JSON")),
      }),
    );

    try {
      await apiRequest("GET", "/projects");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(502);
      expect(apiErr.message).toContain("Bad Gateway");
    }
  });

  it("preserves a non-JSON error body excerpt (C2 de-silence)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 502,
        ok: false,
        statusText: "Bad Gateway",
        headers: new Headers({ "content-type": "text/html" }),
        json: vi.fn().mockRejectedValue(new Error("not JSON")),
        text: vi
          .fn()
          .mockResolvedValue(
            "<html><body>nginx: upstream timed out while reading response</body></html>",
          ),
      }),
    );

    try {
      await apiRequest("GET", "/projects");
      expect.fail("Should have thrown");
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(502);
      expect(apiErr.code).toBe("UNKNOWN_ERROR");
      // The raw body excerpt is preserved, not reduced to "HTTP 502".
      expect(apiErr.message).toContain("upstream timed out");
    }
  });

  it("caps the non-JSON error excerpt at ~300 chars (C2)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 500,
        ok: false,
        statusText: "Internal Server Error",
        headers: new Headers({ "content-type": "text/plain" }),
        json: vi.fn().mockRejectedValue(new Error("not JSON")),
        text: vi.fn().mockResolvedValue("x".repeat(5000)),
      }),
    );

    try {
      await apiRequest("GET", "/projects");
      expect.fail("Should have thrown");
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.message.length).toBeLessThan(400);
      expect(apiErr.message).toContain("xxx");
    }
  });

  it("strips trailing slashes from PM_API_URL", async () => {
    process.env.PM_API_URL = "http://test-server:9999///";
    const fetchMock = mockFetch({ status: 200, ok: true, body: { data: [] } });

    await apiRequest("GET", "/projects");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test-server:9999/api/v1/projects");
  });
});

// ---------------------------------------------------------------------------
// Epic graph — getEpicGraph (C5.P1)
// ---------------------------------------------------------------------------

describe("getEpicGraph", () => {
  beforeEach(() => {
    process.env.PM_API_URL = "http://test-server:9999";
    process.env.PM_API_TOKEN = "test-token-123";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PM_API_URL;
    delete process.env.PM_API_TOKEN;
  });

  const sampleGraph = {
    nodes: [
      {
        id: "epic_a",
        project_id: "proj 001",
        name: "Epic A",
        status: "active",
        priority: "high",
        target_date: null,
        category: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        taskSummary: { total: 1, done: 0, byStatus: { ready: 1 } },
        claimState: "unclaimed",
        health: "on_track",
        activity_recency: "2026-01-01T00:00:00Z",
        time_window: { start: "2026-01-01T00:00:00Z", end: null },
      },
    ],
    edges: [],
    hasCycle: false,
  };

  it("GETs the URL-encoded epic-graph path with the Bearer token", async () => {
    const fetchMock = mockFetch({
      status: 200,
      ok: true,
      body: { data: sampleGraph },
    });

    await getEpicGraph("proj 001");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test-server:9999/api/v1/projects/proj%20001/epic-graph");
    expect(init.method).toBe("GET");
    // A claimed token from a prior test can leak via module state; assert the
    // Bearer scheme is present rather than a specific token value.
    expect(init.headers.Authorization).toMatch(/^Bearer .+/);
  });

  it("unwraps the { data } envelope to the graph object", async () => {
    mockFetch({ status: 200, ok: true, body: { data: sampleGraph } });

    const result = await getEpicGraph("proj_001");

    expect(result).toEqual(sampleGraph);
    expect(result.cycles).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Labels — listLabels (C5.P2)
// ---------------------------------------------------------------------------

describe("listLabels", () => {
  beforeEach(() => {
    process.env.PM_API_URL = "http://test-server:9999";
    process.env.PM_API_TOKEN = "test-token-123";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PM_API_URL;
    delete process.env.PM_API_TOKEN;
  });

  const sampleLabels = [
    {
      id: "label_001",
      projectId: "proj 001",
      name: "rendering",
      color: "#ff8800",
      description: "GPU/render subsystem",
    },
  ];

  it("GETs the URL-encoded labels path with the Bearer token", async () => {
    const fetchMock = mockFetch({
      status: 200,
      ok: true,
      body: { data: sampleLabels, pagination: { total: 1 } },
    });

    await listLabels("proj 001");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test-server:9999/api/v1/projects/proj%20001/labels");
    expect(init.method).toBe("GET");
    // A claimed token from a prior test can leak via module state; assert the
    // Bearer scheme is present rather than a specific token value.
    expect(init.headers.Authorization).toMatch(/^Bearer .+/);
  });

  it("unwraps { data }, dropping pagination (total === data.length, unbounded select)", async () => {
    mockFetch({
      status: 200,
      ok: true,
      body: { data: sampleLabels, pagination: { total: 1 } },
    });

    const result = await listLabels("proj_001");

    expect(result).toEqual(sampleLabels);
  });
});

// ---------------------------------------------------------------------------
// Agent pool — claimAgent (stable per-worker identity, C1 P2)
// ---------------------------------------------------------------------------

describe("claimAgent", () => {
  beforeEach(() => {
    process.env.PM_API_URL = "http://test-server:9999";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PM_API_URL;
    delete process.env.PM_API_TOKEN;
    delete process.env.PM_POOL_SECRET;
    delete process.env.PM_WORKER_KEY;
  });

  it("sends a byte-identical keyless body when no workerKey is supplied", async () => {
    const fetchMock = mockFetch({
      status: 200,
      ok: true,
      body: { data: { user: { id: "u1", username: "agent-1" }, token: "tok-A" } },
    });

    await claimAgent("default", "secret");

    const [, init] = fetchMock.mock.calls[0];
    // No workerKey key present at all (conditional spread → keyless byte-identical).
    expect(JSON.parse(init.body)).toEqual({ poolName: "default", poolSecret: "secret" });
  });

  it("threads workerKey into the body when supplied", async () => {
    const fetchMock = mockFetch({
      status: 200,
      ok: true,
      body: { data: { user: { id: "u1", username: "agent-1" }, token: "tok-A" } },
    });

    await claimAgent("default", "secret", "worker-1");

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      poolName: "default",
      poolSecret: "secret",
      workerKey: "worker-1",
    });
  });

  it("re-binds the same identity and adopts the fresh token on reconnect", async () => {
    // First claim → identity u1, token tok-A, with a bindHandle on the wire.
    mockFetch({
      status: 200,
      ok: true,
      body: {
        data: {
          user: { id: "u1", username: "agent-1", displayName: "Agent One" },
          token: "tok-A",
          bindHandle: "h1",
        },
      },
    });

    await claimAgent("default", "secret", "worker-1");
    expect(getAgentIdentity()?.userId).toBe("u1");

    // Reconnect: same (pool, workerKey) re-binds the SAME row, fresh token.
    mockFetch({
      status: 200,
      ok: true,
      body: {
        data: {
          user: { id: "u1", username: "agent-1", displayName: "Agent One" },
          token: "tok-B",
          bindHandle: "h1",
        },
      },
    });

    await claimAgent("default", "secret", "worker-1");
    expect(getAgentIdentity()?.userId).toBe("u1");

    // A subsequent authenticated request must use the refreshed token.
    const fetchMock = mockFetch({ status: 200, ok: true, body: { data: [] } });
    await apiRequest("GET", "/projects");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer tok-B");
  });
});

// ---------------------------------------------------------------------------
// Notes — createNote bypasses apiRequest to preserve the advisory `similar`
// envelope (Campaign C1 P5). apiRequest would unwrap `.data` and drop it.
// ---------------------------------------------------------------------------

describe("createNote", () => {
  beforeEach(() => {
    process.env.PM_API_URL = "http://test-server:9999";
    process.env.PM_API_TOKEN = "test-token-123";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PM_API_URL;
    delete process.env.PM_API_TOKEN;
  });

  const sampleNote = {
    id: "note_001",
    title: "DB connection leaks on retry",
    kind: "bug",
  };

  it("returns { note, similar } preserving similar from the raw envelope", async () => {
    mockFetch({
      status: 201,
      ok: true,
      body: {
        data: sampleNote,
        similar: [{ id: "note_999", title: "Connection pool leak", kind: "bug" }],
      },
    });

    const result = await createNote("proj_001", {
      kind: "bug",
      title: "DB connection leaks on retry",
    });

    expect(result.note).toEqual(sampleNote);
    expect(result.similar).toEqual([
      { id: "note_999", title: "Connection pool leak", kind: "bug" },
    ]);
  });

  it("defaults similar to [] when absent from the envelope", async () => {
    mockFetch({ status: 201, ok: true, body: { data: sampleNote } });

    const result = await createNote("proj_001", { kind: "bug", title: "X" });

    expect(result.similar).toEqual([]);
  });

  it("sends the Bearer token to the project notes URL", async () => {
    const fetchMock = mockFetch({
      status: 201,
      ok: true,
      body: { data: sampleNote, similar: [] },
    });

    await createNote("proj_001", { kind: "bug", title: "X" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test-server:9999/api/v1/projects/proj_001/notes");
    expect(init.method).toBe("POST");
    // A claimed token from a prior test can leak via module state; assert the
    // Bearer scheme is present rather than a specific token value.
    expect(init.headers.Authorization).toMatch(/^Bearer .+/);
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("throws ApiError with the server code on a non-ok response", async () => {
    mockFetch({
      status: 400,
      ok: false,
      body: { error: { code: "VALIDATION_ERROR", message: "bad" } },
    });

    await expect(createNote("proj_001", { kind: "bug", title: "X" })).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
  });
});

describe("promoteNoteToProposal", () => {
  beforeEach(() => {
    process.env.PM_API_URL = "http://test-server:9999";
    process.env.PM_API_TOKEN = "test-token-123";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PM_API_URL;
    delete process.env.PM_API_TOKEN;
  });

  const sampleNote = {
    id: "note_001",
    title: "DB connection leaks on retry",
    kind: "bug",
    status: "triaged",
    triageOutcome: "promoted",
    promotedProposalId: "prop_900",
  };

  const sampleProposal = {
    id: "prop_900",
    projectId: "proj_001",
    title: "Fix DB connection leak",
    description: "From note.",
    status: "draft",
    createdBy: "user_001",
    sourceNoteId: "note_001",
    createdAt: "2026-06-09T01:00:00Z",
    updatedAt: "2026-06-09T01:00:00Z",
  };

  it("returns { note, proposal } preserving the proposal sibling from the raw envelope", async () => {
    mockFetch({
      status: 200,
      ok: true,
      body: { data: sampleNote, proposal: sampleProposal },
    });

    const result = await promoteNoteToProposal("note_001", { title: "Fix DB connection leak" });

    expect(result.note).toEqual(sampleNote);
    expect(result.proposal).toEqual(sampleProposal);
  });

  it("POSTs to the promote-to-proposal URL with the Bearer token", async () => {
    const fetchMock = mockFetch({
      status: 200,
      ok: true,
      body: { data: sampleNote, proposal: sampleProposal },
    });

    await promoteNoteToProposal("note_001", {});

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test-server:9999/api/v1/notes/note_001/promote-to-proposal");
    expect(init.method).toBe("POST");
    // A claimed token from a prior test can leak via module state; assert the
    // Bearer scheme is present rather than a specific token value.
    expect(init.headers.Authorization).toMatch(/^Bearer .+/);
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("throws ApiError with the server code on a non-ok response", async () => {
    mockFetch({
      status: 409,
      ok: false,
      body: { error: { code: "NOTE_NOT_OPEN", message: "not open" } },
    });

    await expect(promoteNoteToProposal("note_001", {})).rejects.toMatchObject({
      status: 409,
      code: "NOTE_NOT_OPEN",
    });
  });
});

// ---------------------------------------------------------------------------
// Release-on-shutdown gate (C1 P2, verifier correction 2)
// ---------------------------------------------------------------------------

describe("shouldReleaseOnShutdown", () => {
  beforeEach(() => {
    process.env.PM_API_URL = "http://test-server:9999";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PM_API_URL;
    delete process.env.PM_API_TOKEN;
    delete process.env.PM_POOL_SECRET;
    delete process.env.PM_WORKER_KEY;
  });

  async function claimIdentity(): Promise<void> {
    mockFetch({
      status: 200,
      ok: true,
      body: {
        data: { user: { id: "u1", username: "agent-1", displayName: "Agent One" }, token: "tok-A" },
      },
    });
    await claimAgent("default", "secret", process.env.PM_WORKER_KEY || undefined);
  }

  it("does NOT release a keyed pool claim (no agent-release POST)", async () => {
    process.env.PM_POOL_SECRET = "secret";
    process.env.PM_WORKER_KEY = "worker-1";
    await claimIdentity();

    expect(shouldReleaseOnShutdown()).toBe(false);

    // Simulate the cleanup gate: release only when shouldReleaseOnShutdown().
    const fetchMock = mockFetch({ status: 200, ok: true, body: { data: { message: "ok" } } });
    if (shouldReleaseOnShutdown()) {
      await releaseAgent();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("releases a keyless pool claim (agent-release POST is issued)", async () => {
    process.env.PM_POOL_SECRET = "secret";
    // PM_WORKER_KEY unset → keyless.
    await claimIdentity();

    expect(shouldReleaseOnShutdown()).toBe(true);

    const fetchMock = mockFetch({ status: 200, ok: true, body: { data: { message: "ok" } } });
    if (shouldReleaseOnShutdown()) {
      await releaseAgent();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test-server:9999/api/v1/auth/agent-release");
    expect(init.method).toBe("POST");
  });

  it("treats whitespace-only PM_WORKER_KEY as keyless (releases)", async () => {
    process.env.PM_POOL_SECRET = "secret";
    process.env.PM_WORKER_KEY = "   ";
    await claimIdentity();

    expect(shouldReleaseOnShutdown()).toBe(true);
  });

  it("never releases under a static PM_API_TOKEN", async () => {
    process.env.PM_API_TOKEN = "static";
    process.env.PM_POOL_SECRET = "secret";
    await claimIdentity();

    expect(shouldReleaseOnShutdown()).toBe(false);
  });
});
