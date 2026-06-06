import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  apiRequest,
  ApiError,
  claimAgent,
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

  it("strips trailing slashes from PM_API_URL", async () => {
    process.env.PM_API_URL = "http://test-server:9999///";
    const fetchMock = mockFetch({ status: 200, ok: true, body: { data: [] } });

    await apiRequest("GET", "/projects");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test-server:9999/api/v1/projects");
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
