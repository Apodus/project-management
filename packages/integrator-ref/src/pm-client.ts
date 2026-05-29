/**
 * Standalone HTTP client for the PM REST API.
 *
 * Deliberately duplicates structure of packages/mcp-server/src/api-client.ts
 * rather than sharing a layer — both leaf packages have different runtime
 * deps (MCP SDK vs. CLI) and a shared HTTP module would force unwanted
 * dependencies across the boundary. Single source of truth for view types
 * is @pm/shared.
 */

import type {
  MergeRequestView,
  MergeAttemptView,
  MergeRequestStatus,
} from "@pm/shared";

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

export interface PmClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface IntegratorSettings {
  enabled: boolean;
  verify_command?: string;
  verify_timeout_sec?: number;
  worktree_root?: string;
  git_remote?: string;
  git_main_branch?: string;
  worktree_name?: string;
}

export interface ProjectDetail {
  id: string;
  name: string;
  slug: string;
  status: string;
  gitRepoUrl: string | null;
  settings: { integrator?: IntegratorSettings } | null;
}

export type RejectCategory =
  | "conflict"
  | "build_failed"
  | "test_failed"
  | "lint_failed"
  | "verify_timeout"
  | "policy"
  | "other";

export type MergeRequestDetailView = MergeRequestView & {
  attempts: MergeAttemptView[];
};

export class PmClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PmClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      if (!res.ok) {
        throw new PmApiError(res.status, "UNKNOWN_ERROR", `HTTP ${res.status}`);
      }
      return undefined as T;
    }
    const json = await res.json();
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

  // ── Project ────────────────────────────────────────────────────────
  getProject(projectId: string): Promise<ProjectDetail> {
    return this.request<ProjectDetail>("GET", `/projects/${encodeURIComponent(projectId)}`);
  }

  // ── Merge request lifecycle ────────────────────────────────────────
  listMergeRequests(
    projectId: string,
    filters?: { resource?: string; status?: MergeRequestStatus },
  ): Promise<MergeRequestView[]> {
    const params: string[] = [];
    if (filters?.resource) params.push(`resource=${encodeURIComponent(filters.resource)}`);
    if (filters?.status) params.push(`status=${encodeURIComponent(filters.status)}`);
    const qs = params.length > 0 ? `?${params.join("&")}` : "";
    return this.request<MergeRequestView[]>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/merge-requests${qs}`,
    );
  }

  getMergeRequest(requestId: string): Promise<MergeRequestDetailView> {
    return this.request<MergeRequestDetailView>(
      "GET",
      `/merge-requests/${encodeURIComponent(requestId)}`,
    );
  }

  pickupMergeRequest(requestId: string): Promise<MergeRequestView> {
    return this.request<MergeRequestView>(
      "POST",
      `/merge-requests/${encodeURIComponent(requestId)}/pickup`,
    );
  }

  landMergeRequest(requestId: string, landedSha: string): Promise<MergeRequestView> {
    return this.request<MergeRequestView>(
      "POST",
      `/merge-requests/${encodeURIComponent(requestId)}/land`,
      { landedSha },
    );
  }

  resetToQueued(requestId: string, reason: string): Promise<MergeRequestView> {
    return this.request<MergeRequestView>(
      "POST",
      `/merge-requests/${encodeURIComponent(requestId)}/reset-to-queued`,
      { reason },
    );
  }

  rejectMergeRequest(
    requestId: string,
    payload: {
      category: RejectCategory;
      reason: string;
      failedFiles?: string[];
      logExcerpt?: string;
      logUrl?: string;
    },
  ): Promise<MergeRequestView> {
    return this.request<MergeRequestView>(
      "POST",
      `/merge-requests/${encodeURIComponent(requestId)}/reject`,
      payload,
    );
  }

  // ── Attempts ───────────────────────────────────────────────────────
  startAttempt(requestId: string, baseSha: string): Promise<MergeAttemptView> {
    return this.request<MergeAttemptView>(
      "POST",
      `/merge-requests/${encodeURIComponent(requestId)}/attempts`,
      { baseSha },
    );
  }

  completeAttempt(
    attemptId: string,
    body:
      | { status: "passed"; treeSha: string }
      | {
          status: "failed";
          failureCategory: RejectCategory;
          failureReason: string;
          failedFiles?: string[];
          logExcerpt?: string;
          logUrl?: string;
        }
      | { status: "cancelled" },
  ): Promise<MergeAttemptView> {
    return this.request<MergeAttemptView>(
      "PATCH",
      `/merge-attempts/${encodeURIComponent(attemptId)}`,
      body,
    );
  }

  // ── Stage 1 merge lock ─────────────────────────────────────────────
  acquireLock(
    projectId: string,
    resource: string,
    intent?: {
      taskId?: string | null;
      branch?: string | null;
      commitSha?: string | null;
      verifyCmd?: string | null;
      worktreePath?: string | null;
    },
  ): Promise<{
    ok: boolean;
    status: "held" | "queued" | "already_held";
    position?: number | null;
    expiresAt?: string | null;
  }> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/merge-locks/${encodeURIComponent(resource)}/acquire`,
      intent ?? {},
    );
  }

  heartbeatLock(
    projectId: string,
    resource: string,
  ): Promise<{ ok: boolean; status: "refreshed" | "not_holder"; expiresAt?: string | null }> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/merge-locks/${encodeURIComponent(resource)}/heartbeat`,
    );
  }

  releaseLock(
    projectId: string,
    resource: string,
    opts?: { landedSha?: string; reason?: string },
  ): Promise<{
    ok: boolean;
    status: "released" | "not_held" | "not_holder";
    grantedTo?: string | null;
  }> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/merge-locks/${encodeURIComponent(resource)}/release`,
      opts ?? {},
    );
  }
}
