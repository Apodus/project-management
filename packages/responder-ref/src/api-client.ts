/**
 * Standalone HTTP client for the PM escalation REST surface (responder slice).
 *
 * A deliberately minimal trim of the wake daemon's pm-client: the responder
 * only ever touches three endpoints — open-escalations list (per project),
 * acknowledge (claim), and /auth/me (resolve selfId once at startup). Single
 * source of truth for the view types is @pm/shared.
 */
import type {
  Escalation,
  EscalationMessage,
  EscalationMessageType,
  EscalationWithThread,
  Priority,
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

/** The minimal self-identity slice the responder reads from /auth/me. */
export interface SelfIdentity {
  id: string;
  type: string;
}

/**
 * The body the responder POSTs to create a merge request (A2 P1). Task-less,
 * escalationId-linked; the train lands it. Mirrors the route's submitBody.
 */
export interface SubmitMergeRequestBody {
  resource: string;
  taskId: string | null;
  branch: string | null;
  commitSha: string | null;
  verifyCmd: string | null;
  escalationId: string | null;
}

/** The narrow merge-request view slice the responder reads back after submit. */
export interface SubmittedMergeRequest {
  id: string;
  branch: string | null;
  commitSha: string | null;
}

/**
 * The body the daemon POSTs to create the vision's PM epic (A3 P1). The server
 * auto-attributes `createdBy` from the responder's ai_agent bearer token — no
 * creator field travels in the body.
 */
export interface CreateEpicBody {
  name: string;
  description?: string | null;
  priority?: Priority;
}

/**
 * The body the daemon POSTs to create a campaign task under the vision epic (A3 P1).
 * The server auto-attributes `reporterId` from the responder's ai_agent bearer token.
 */
export interface CreateTaskBody {
  title: string;
  description?: string | null;
  epicId?: string | null;
  priority?: Priority;
}

export interface ResponderClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class ResponderClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ResponderClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // Wrap EVERY transport failure as a PmApiError so the loop can discriminate
    // an infra fault (status 0) from a real HTTP status (403/409/5xx). A `fetch`
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
    // Both the list (`{ data, pagination }`) and the single-entity responses
    // (`{ data }`) carry the payload under `.data` — unwrap it uniformly. The
    // list's pagination envelope is discarded; the responder reads only `.data`.
    if (json && typeof json === "object" && "data" in json) {
      return (json as { data: T }).data;
    }
    return json as T;
  }

  /**
   * The project's OPEN escalations. Unwraps the `{ data, pagination }` list
   * envelope to the bare array. The seed/no-recursion filter (holder null,
   * author != self) lives in the loop, not here.
   */
  listOpenEscalations(projectId: string): Promise<Escalation[]> {
    return this.request<Escalation[]>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/escalations?status=open`,
    );
  }

  /**
   * The project's ACKNOWLEDGED escalations held by `holderId` (the reclaim seed,
   * C3 P6a). The server ANDs `status` + `holderId` filters; the responder passes
   * its own selfId to recover stranded-acknowledged threads it once claimed.
   * Unwraps the list envelope to the bare array (like listOpenEscalations).
   */
  listAcknowledgedByHolder(projectId: string, holderId: string): Promise<Escalation[]> {
    return this.request<Escalation[]>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/escalations?status=acknowledged&holderId=${encodeURIComponent(holderId)}`,
    );
  }

  /**
   * Acknowledge (claim) an escalation. No body. An ai_agent acking an unclaimed
   * open escalation auto-claims it (holderId ← actor). A DIFFERENT agent acking
   * a held one → 403; acking a non-open → 409.
   */
  acknowledge(id: string): Promise<Escalation> {
    return this.request<Escalation>(
      "POST",
      `/escalations/${encodeURIComponent(id)}/acknowledge`,
    );
  }

  /**
   * Fetch the escalation + its full ordered thread (the getById shape). The
   * responder reads this once after claiming, to seed the answering session's
   * prompt with the escalation fields + every thread message.
   */
  getEscalation(id: string): Promise<EscalationWithThread> {
    return this.request<EscalationWithThread>(
      "GET",
      `/escalations/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Answer an acknowledged escalation (acknowledged → answered). The optional
   * `body` is appended as a `diagnosis` message — it IS the text the origin
   * client receives (the C2 delivery path auto-notices the answer).
   */
  answer(id: string, body: string): Promise<Escalation> {
    return this.request<Escalation>(
      "POST",
      `/escalations/${encodeURIComponent(id)}/answer`,
      { body },
    );
  }

  /**
   * Escalate to a human (any non-terminal state → needs_human). A reason is
   * required and recorded as a `system` message. The responder routes
   * needs_human / give_up / error outcomes here so no proven work is discarded.
   */
  escalateToHuman(id: string, reason: string): Promise<Escalation> {
    return this.request<Escalation>(
      "POST",
      `/escalations/${encodeURIComponent(id)}/escalate-to-human`,
      { reason },
    );
  }

  /**
   * Append a message to an escalation thread (the auto-implement pending-land
   * handoff, A1 P3). Bumps `updatedAt` and emits ESCALATION_REPLIED but does NOT
   * transition status — the escalation STAYS `acknowledged` (A2 lands + resolves).
   * `metadata` carries the `{pendingLand:true, branch, commitSha}` marker the
   * reclaim sweep keys off to skip re-spawning a landed-but-not-yet-merged thread.
   */
  addMessage(
    id: string,
    body: string,
    messageType?: EscalationMessageType,
    metadata?: Record<string, unknown>,
  ): Promise<EscalationMessage> {
    return this.request<EscalationMessage>(
      "POST",
      `/escalations/${encodeURIComponent(id)}/messages`,
      { body, messageType, metadata },
    );
  }

  /**
   * Submit a merge request for an implemented escalation branch (A2 P1). Over
   * HTTP (NOT the pm_request_merge MCP tool) — the responder is a separate
   * ai_agent process. Task-less + escalationId-linked; the train lands it (P2).
   * `request<T>` unwraps the `{ data }` envelope to the merge-request view.
   */
  submitMergeRequest(
    projectId: string,
    body: SubmitMergeRequestBody,
  ): Promise<SubmittedMergeRequest> {
    return this.request<SubmittedMergeRequest>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/merge-requests`,
      body,
    );
  }

  /**
   * Create the vision's PM epic (A3 P1 drive). Over HTTP (NOT pm_create_epic MCP —
   * the responder is a separate ai_agent process). `request<T>` unwraps the
   * `{ data }` envelope; the server auto-attributes `createdBy` from the bearer
   * token, so no creator field travels in the body.
   */
  createEpic(projectId: string, body: CreateEpicBody): Promise<{ id: string; name?: string }> {
    return this.request<{ id: string; name?: string }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/epics`,
      body,
    );
  }

  /**
   * Create a campaign task under the vision epic (A3 P1 drive). Over HTTP (NOT
   * pm_create_task MCP). `request<T>` unwraps the `{ data }` envelope; the server
   * auto-attributes `reporterId` from the bearer token.
   */
  createTask(projectId: string, body: CreateTaskBody): Promise<{ id: string }> {
    return this.request<{ id: string }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/tasks`,
      body,
    );
  }

  /** Resolve this responder's own identity (used once at startup for selfId). */
  getMe(): Promise<SelfIdentity> {
    return this.request<SelfIdentity>("GET", "/auth/me");
  }
}
