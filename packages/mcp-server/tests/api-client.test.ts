import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiRequest, ApiError } from "../src/api-client.js";

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
