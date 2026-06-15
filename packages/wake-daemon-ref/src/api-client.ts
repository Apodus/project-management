/**
 * Standalone HTTP client for the PM escalation-delivery REST surface.
 *
 * A deliberately minimal trim of integrator-ref's pm-client: the wake daemon
 * only ever touches two endpoints (undelivered list + mark-delivered). Single
 * source of truth for the view types is @pm/shared.
 */
import type { Escalation, UndeliveredEscalation } from "@pm/shared";

export class PmApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PmApiError";
  }
}

export interface WakeClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class WakeClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WakeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // Wrap EVERY transport failure as a PmApiError so the loop can discriminate
    // an infra fault (status 0) from a real HTTP status (403/404/5xx). A `fetch`
    // rejection (connection refused/reset/DNS/abort → raw TypeError) would
    // otherwise escape un-typed.
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new PmApiError(
        0,
        "NETWORK",
        `network error calling ${method} ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      if (!res.ok) {
        throw new PmApiError(res.status, "UNKNOWN_ERROR", `HTTP ${res.status}`);
      }
      return undefined as T;
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new PmApiError(
        0,
        "PARSE",
        `failed to parse JSON from ${method} ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } })?.error;
      throw new PmApiError(
        res.status,
        err?.code ?? "UNKNOWN_ERROR",
        err?.message ?? `HTTP ${res.status}`,
      );
    }
    if (json && typeof json === "object" && "data" in json) {
      return (json as { data: T }).data;
    }
    return json as T;
  }

  /**
   * The watched worker's undelivered escalations — each its escalation + the
   * unread (non-origin-authored, past-cursor) replies + their count. `workerKey`
   * is the delivery identity; `projectId` optionally scopes it.
   */
  listUndelivered(workerKey: string, projectId?: string): Promise<UndeliveredEscalation[]> {
    const params: string[] = [`worker_key=${encodeURIComponent(workerKey)}`];
    if (projectId) params.push(`project_id=${encodeURIComponent(projectId)}`);
    return this.request<UndeliveredEscalation[]>(
      "GET",
      `/escalations/undelivered?${params.join("&")}`,
    );
  }

  /**
   * Advance the delivery cursor for an escalation to `uptoSeq`. `workerKey` must
   * match the escalation's originWorkerKey (else 403); the cursor is forward-only.
   */
  markDelivered(escalationId: string, workerKey: string, uptoSeq: number): Promise<Escalation> {
    return this.request<Escalation>(
      "POST",
      `/escalations/${encodeURIComponent(escalationId)}/mark-delivered`,
      { workerKey, uptoSeq },
    );
  }
}
