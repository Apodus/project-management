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
  MergeRequestGroupView,
  MergeGroupState,
  MergeIncidentView,
  MergeIncidentType,
  MergeIncidentState,
  IntegratorHeartbeat,
  IntegratorHealthView,
  TrainStateView,
  VerifyCacheRowView,
  VerifyResultValue,
  VerifyStep,
  VerifyStepResult,
  CacheMode,
  MergeResolutionView,
} from "@pm/shared";
// Type-only import (avoids a runtime circular import with batch.ts).
import type { BatchEvent } from "./batch.js";

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
  parallelism?: number;
  /**
   * Phase 7.4 §3.6: the integrator heartbeat cadence in seconds (default 30).
   * The integrator POSTs a heartbeat on this interval; PM's HEALTH_STALE_MS is
   * derived as this × 3 (§3.4).
   */
  heartbeat_interval_sec?: number;
  /** Phase 7.5 §2.1: the verify_steps DAG (default [] = single-command). */
  verify_steps?: VerifyStep[];
  /** Phase 7.5 §4.2: the cache kill-switch (default false = no cache). */
  cache_enabled?: boolean;
  /** Phase 7.5 §4.3: the cache mode (default "off"). */
  cache_mode?: CacheMode;
  linked_repos?: {
    name: string;
    path: string;
    role: "inner" | "outer";
    gitlink_parent?: string;
    gitlink_path?: string;
  }[];
  /**
   * Phase 7.6 §3: intelligent merge-conflict resolution config. Absent/empty ⇒
   * `{ enabled: false }` (inert; a conflict rejects exactly as in 7.5). Mirrors
   * the canonical Zod schema in `@pm/shared` (project.ts §resolver).
   */
  resolver?: {
    enabled?: boolean;
    max_concurrent?: number;
    time_budget_sec?: number;
    token_budget?: number;
    command?: string;
  };
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

/**
 * Phase 7.3 group view + members (the `getMergeGroup` shape). Mirrors the
 * server's `GroupWithMembers` projection — the group row fields plus its
 * ordered member requests (inner/outer for a 2-repo group).
 */
export type MergeGroupWithMembers = MergeRequestGroupView & {
  members: MergeRequestView[];
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

  // ── Phase 7.4 observability: heartbeat + train state ────────────────
  /**
   * POST a periodic integrator heartbeat (§3.2/§3.6). The payload ALWAYS carries
   * the resource explicitly (the schema defaults it to "main", but the integrator
   * is authoritative about its own lane). Returns the derived health view. The
   * caller fires this and-forgets — a failed POST must NEVER break the loop.
   */
  postHeartbeat(
    projectId: string,
    payload: IntegratorHeartbeat,
  ): Promise<IntegratorHealthView> {
    return this.request<IntegratorHealthView>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/integrator/heartbeat`,
      payload,
    );
  }

  /**
   * GET the train control state for a lane (§4.2 / §8.6). The integrator reads
   * this as a soft, read-side admission gate: `state === "paused"` → admit no new
   * work. The poll is the correctness floor; the train.paused/resumed SSE events
   * are the latency hint. A read failure is treated FAIL-OPEN by the caller (the
   * lane lock + PM transitions + the force-* overrides are the hard safety).
   */
  getTrainState(projectId: string, resource: string): Promise<TrainStateView> {
    return this.request<TrainStateView>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/train/state?resource=${encodeURIComponent(resource)}`,
    );
  }

  // ── Merge request lifecycle ────────────────────────────────────────
  listMergeRequests(
    projectId: string,
    filters?: {
      resource?: string;
      status?: MergeRequestStatus;
      /** Exclude grouped members (groupId != null) — the single-repo FIFO drain
       *  passes this so a grouped member is never speculatively interleaved
       *  (design §9 finding 3). */
      ungrouped?: boolean;
    },
  ): Promise<MergeRequestView[]> {
    const params: string[] = [];
    if (filters?.resource) params.push(`resource=${encodeURIComponent(filters.resource)}`);
    if (filters?.status) params.push(`status=${encodeURIComponent(filters.status)}`);
    if (filters?.ungrouped) params.push(`ungrouped=true`);
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

  pickupMergeRequest(
    requestId: string,
    tags?: { batchId?: string; speculativePosition?: number },
  ): Promise<MergeRequestView> {
    return this.request<MergeRequestView>(
      "POST",
      `/merge-requests/${encodeURIComponent(requestId)}/pickup`,
      tags ?? {},
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
  startAttempt(
    requestId: string,
    baseSha: string,
    tags?: { batchId?: string; speculativePosition?: number },
  ): Promise<MergeAttemptView> {
    return this.request<MergeAttemptView>(
      "POST",
      `/merge-requests/${encodeURIComponent(requestId)}/attempts`,
      { baseSha, ...(tags ?? {}) },
    );
  }

  completeAttempt(
    attemptId: string,
    body:
      | { status: "passed"; treeSha: string; steps?: VerifyStepResult[] }
      | {
          status: "failed";
          failureCategory: RejectCategory;
          failureReason: string;
          failedFiles?: string[];
          logExcerpt?: string;
          logUrl?: string;
          steps?: VerifyStepResult[];
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

  // ── Phase 7.3 merge groups (cross-repo atomic unit) ────────────────
  /**
   * List merge groups for a project (optionally filtered by resource/state).
   * GET /api/v1/projects/{projectId}/merge-groups?resource=&state=.
   */
  listMergeGroups(
    projectId: string,
    filters?: { resource?: string; state?: MergeGroupState },
  ): Promise<MergeRequestGroupView[]> {
    const params: string[] = [];
    if (filters?.resource) {
      params.push(`resource=${encodeURIComponent(filters.resource)}`);
    }
    if (filters?.state) params.push(`state=${encodeURIComponent(filters.state)}`);
    const qs = params.length > 0 ? `?${params.join("&")}` : "";
    return this.request<MergeRequestGroupView[]>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/merge-groups${qs}`,
    );
  }

  /**
   * Get a single group WITH its member requests (used to bind inner/outer
   * members before assembly). GET /api/v1/merge-groups/{id}.
   */
  getMergeGroup(groupId: string): Promise<MergeGroupWithMembers> {
    return this.request<MergeGroupWithMembers>(
      "GET",
      `/merge-groups/${encodeURIComponent(groupId)}`,
    );
  }

  /**
   * Integrator pickup of the whole group: forming → integrating (flips every
   * queued member to integrating in one txn server-side).
   * POST /api/v1/merge-groups/{id}/pickup.
   */
  markGroupIntegrating(
    groupId: string,
    opts?: { integratorId?: string },
  ): Promise<MergeGroupWithMembers> {
    return this.request<MergeGroupWithMembers>(
      "POST",
      `/merge-groups/${encodeURIComponent(groupId)}/pickup`,
      opts ?? {},
    );
  }

  /**
   * Reset a stranded integrating group: integrating → forming (§9 finding 2 /
   * §6.4). Atomically resets the group to forming AND every integrating member
   * back to queued, so the §6.4 crash-between-pushes window re-integrates as a
   * clean atom. The server REFUSES (409) a non-integrating group or one with an
   * open incident (the corruption fence — a real orphan is recovered by
   * rollforward, never reset). POST /api/v1/merge-groups/{id}/reset.
   */
  resetGroup(
    groupId: string,
    opts?: { reason?: string },
  ): Promise<MergeGroupWithMembers> {
    return this.request<MergeGroupWithMembers>(
      "POST",
      `/merge-groups/${encodeURIComponent(groupId)}/reset`,
      opts ?? {},
    );
  }

  /**
   * Reject the whole group: forming → rejected OR integrating → rejected. The
   * server rejects ALL non-terminal members atomically in one txn — callers
   * MUST NOT additionally per-member reject. The `reason` IS the surfacing
   * record (emitted on merge.group.rejected; no merge_rejection comment is
   * posted by the group-reject path — §6.6).
   * POST /api/v1/merge-groups/{id}/reject.
   */
  rejectGroup(
    groupId: string,
    payload: { reason: string; category?: RejectCategory },
  ): Promise<MergeGroupWithMembers> {
    return this.request<MergeGroupWithMembers>(
      "POST",
      `/merge-groups/${encodeURIComponent(groupId)}/reject`,
      payload,
    );
  }

  /**
   * Atomic clean-land of the whole group — integrating → landed (§6.7). Lands
   * every member (status landed + landedSha + landed_sha git_ref) and the group
   * in one server-side txn. The per-member `role` ("inner" | "outer") tags the
   * member-landed / group-landed events. The integrator MUST first complete each
   * member's attempt as passed (§6.7 / CONSTRAINT C) — landGroup does NOT touch
   * attempts. POST /api/v1/merge-groups/{id}/land.
   */
  landGroup(
    groupId: string,
    body: { members: { requestId: string; landedSha: string; role: string }[] },
  ): Promise<MergeGroupWithMembers> {
    return this.request<MergeGroupWithMembers>(
      "POST",
      `/merge-groups/${encodeURIComponent(groupId)}/land`,
      body,
    );
  }

  /**
   * Set the inner member to the `orphaned` outcome — member integrating →
   * orphaned (§6.5 step 1; a group-land-FAMILY op admitted by the G1 guard). The
   * inner DID land on its remote, but its group outcome is "orphaned", not the
   * clean `landed` G1 reserves for group-land. Does NOT open the incident.
   * POST /api/v1/merge-requests/{id}/orphan.
   */
  markInnerOrphaned(
    innerRequestId: string,
    orphanedSha: string,
  ): Promise<MergeRequestView> {
    return this.request<MergeRequestView>(
      "POST",
      `/merge-requests/${encodeURIComponent(innerRequestId)}/orphan`,
      { orphanedSha },
    );
  }

  /**
   * Mark the group partially landed — integrating → partially_landed (§6.5).
   * Outer-push-fail-after-inner-land: sets the group row only (member states are
   * set by markInnerOrphaned + the outer-member reject). The `incidentId`
   * cross-links the open incident. POST /api/v1/merge-groups/{id}/partially-land.
   */
  markPartiallyLanded(
    groupId: string,
    body: { reason: string; incidentId?: string },
  ): Promise<MergeRequestGroupView> {
    return this.request<MergeRequestGroupView>(
      "POST",
      `/merge-groups/${encodeURIComponent(groupId)}/partially-land`,
      body,
    );
  }

  /**
   * Open an orphaned-inner incident — the durable PM record that inner main
   * landed at `orphanedSha` but the outer gitlink was NOT updated (§6.5 step 2 /
   * §4.3). Returns the created MergeIncidentView (capture `.id`).
   * POST /api/v1/projects/{projectId}/merge-incidents.
   */
  openIncident(params: {
    projectId: string;
    type: MergeIncidentType;
    innerRepo: string;
    orphanedSha: string;
    outerRepo: string;
    groupId?: string | null;
    innerRequestId?: string | null;
    taskId?: string | null;
  }): Promise<MergeIncidentView> {
    const { projectId, ...body } = params;
    return this.request<MergeIncidentView>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/merge-incidents`,
      body,
    );
  }

  /**
   * List merge incidents for a project (Step 12 recovery detection, §7.2). The
   * server orders by `openedAt` asc (oldest-first), which is exactly the order
   * recovery rolls forward. Optional filters: state / type / groupId.
   * GET /api/v1/projects/{projectId}/merge-incidents?qs.
   */
  listMergeIncidents(
    projectId: string,
    filters?: {
      state?: MergeIncidentState;
      type?: MergeIncidentType;
      groupId?: string;
    },
  ): Promise<MergeIncidentView[]> {
    const params: string[] = [];
    if (filters?.state) params.push(`state=${encodeURIComponent(filters.state)}`);
    if (filters?.type) params.push(`type=${encodeURIComponent(filters.type)}`);
    if (filters?.groupId) {
      params.push(`groupId=${encodeURIComponent(filters.groupId)}`);
    }
    const qs = params.length > 0 ? `?${params.join("&")}` : "";
    return this.request<MergeIncidentView[]>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/merge-incidents${qs}`,
    );
  }

  /**
   * Resolve a merge incident — the §7.3 step-6 auto-rollforward resolution
   * (`mode: "auto_rollforward"`, ai_agent-gated server-side). `outerLandedSha`
   * is the verified roll-forward outer SHA just pushed; `resolvedByGroupId` is
   * the integrating group's id (if any). POST /api/v1/merge-incidents/{id}/resolve.
   */
  resolveIncident(
    incidentId: string,
    body: {
      mode: "auto_rollforward" | "human";
      outerLandedSha?: string;
      resolvedByGroupId?: string;
      note?: string;
    },
  ): Promise<MergeIncidentView> {
    return this.request<MergeIncidentView>(
      "POST",
      `/merge-incidents/${encodeURIComponent(incidentId)}/resolve`,
      body,
    );
  }

  // ── Phase 7.2 batch-marker relay (design §13.2) ────────────────────
  /**
   * POST a batch-marker event to the thin relay endpoint. PM re-emits it on
   * the merge.batch.* SSE stream and persists nothing. The endpoint returns a
   * 202 (which the `request` helper tolerates as a non-JSON / data 2xx).
   */
  async postBatchEvent(projectId: string, marker: BatchEvent): Promise<void> {
    await this.request<{ ok: boolean }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/merge-batches/events`,
      marker,
    );
  }

  // ── Phase 7.5 verify cache (lookup / record / mismatch, §8.5) ──────
  /**
   * Probe the verify cache BEFORE running a step (§3.2/§8.5). A HIT returns the
   * cached row view (the verdict + duration + log; the server bumps
   * hit_count/last_hit_at), a MISS returns null. The `request` helper unwraps
   * `{ data }` — `data: null` (the miss) surfaces here as `null`.
   */
  lookupVerifyCache(
    projectId: string,
    key: {
      resource: string;
      treeSha: string;
      stepId: string;
      stepConfigSha: string;
    },
  ): Promise<VerifyCacheRowView | null> {
    return this.request<VerifyCacheRowView | null>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/verify-cache/lookup`,
      key,
    );
  }

  /**
   * Record a verify verdict AFTER running a step (§8.5) — a write-or-update on
   * the unique 5-tuple key that preserves hit_count/last_hit_at/created_at on a
   * re-record (the shadow self-heal). Returns the recorded row view.
   */
  recordVerifyCache(
    projectId: string,
    entry: {
      resource: string;
      treeSha: string;
      stepId: string;
      stepConfigSha: string;
      result: VerifyResultValue;
      durationMs?: number | null;
      logExcerpt?: string | null;
      logUrl?: string | null;
    },
  ): Promise<VerifyCacheRowView> {
    return this.request<VerifyCacheRowView>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/verify-cache/record`,
      entry,
    );
  }

  /**
   * Relay a shadow-mode cache mismatch (§4.4/§9) — fire-and-forget, like
   * postBatchEvent. PM re-emits verify.cache_mismatch on the SSE stream and
   * persists nothing; the endpoint returns 202 (which `request` tolerates). A
   * relay failure must NEVER break the verify pass (the verdict the member uses
   * is the REAL run's, already in hand).
   */
  async emitVerifyCacheMismatch(
    projectId: string,
    mismatch: {
      resource: string;
      treeSha: string;
      stepId: string;
      stepConfigSha: string;
      cachedResult: VerifyResultValue;
      realResult: VerifyResultValue;
      requestId?: string;
      attemptId?: string;
    },
  ): Promise<void> {
    await this.request<{ ok: boolean }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/verify-cache/mismatch`,
      mismatch,
    );
  }

  // ── Phase 7.6 merge resolution (conflict → resolution, §5.1/§6) ────
  /**
   * Open a resolution for an origin request that hit a textual rebase conflict
   * (§5.1 / §6). The server creates a `pending` `merge_resolutions` row and
   * emits `merge.resolution.pending`. Called ONLY when `resolver.enabled` and
   * AFTER the origin has already been rejected `conflict` + the lane lock
   * released — the seam never resolves under the lock (§5.1). Returns the
   * created MergeResolutionView (capture `.id` for the resolution job).
   * POST /api/v1/projects/{projectId}/merge-resolutions.
   */
  openResolution(
    projectId: string,
    resource: string,
    originRequestId: string,
    conflictingFiles: string[],
  ): Promise<MergeResolutionView> {
    return this.request<MergeResolutionView>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/merge-resolutions`,
      { originRequestId, resource, conflictingFiles },
    );
  }
}
