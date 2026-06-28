/**
 * Standalone HTTP client for the PM notes/triage REST surface (triager slice).
 *
 * A deliberately minimal trim of the responder's pm-client: the triager only
 * ever touches a handful of endpoints — open-notes list (per project), project
 * read (for the per-tick effective enablement), triage-decision record (the
 * append-only side-log), and /auth/me (resolve selfId once at startup). The
 * single source of truth for the wire types is @pm/shared.
 *
 * P4 will add the decision-EXECUTION wrappers (promote-to-proposal / dismiss /
 * flag-needs-human / claim-proposal / implement-proposal). They are DEFERRED:
 * wiring them now (with no caller) would be dead code. The P2 stub mutates
 * NOTHING — `recordTriageDecision` is wired but not called by the stub.
 */
import type { Note, NotesTriageMode, TriageDecision, TriageDecisionKind } from "@pm/shared";

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

/** The minimal self-identity slice the triager reads from /auth/me. */
export interface SelfIdentity {
  id: string;
  type: string;
}

/**
 * The narrow project view the triager reads per tick to compose effective
 * notes-triage enablement. Only `settings.notesTriage` is consumed — every field
 * is optional + tolerant (absent ⇒ the defaults `resolveNotesTriage` applies:
 * enabled off, mode "shadow"). `settings` may be null (a project with no settings
 * block). The shape is assignable to `resolveNotesTriage`'s settings parameter.
 */
export interface TriagerProjectView {
  id: string;
  settings: {
    notesTriage?: { enabled?: boolean; mode?: NotesTriageMode; triageAgentId?: string };
  } | null;
}

/**
 * The body the triager POSTs to record a triage decision (T2·P1 side-log). Omits
 * id/projectId/actorId/createdAt — all server/auth/URL-derived. Mirrors the
 * server's `createTriageDecisionBody` (= @pm/shared `CreateTriageDecision`). The
 * record NEVER mutates the referenced note. Wired now; NOT called by the P2 stub.
 */
export interface RecordTriageDecisionBody {
  noteId: string;
  mode: NotesTriageMode;
  decision: TriageDecisionKind;
  rationale?: string | null;
  confidence?: number | null;
  resultingProposalId?: string | null;
  resultingTaskId?: string | null;
}

export interface TriagerClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class TriagerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TriagerClientOptions) {
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
    // list's pagination envelope is discarded; the triager reads only `.data`.
    if (json && typeof json === "object" && "data" in json) {
      return (json as { data: T }).data;
    }
    return json as T;
  }

  /**
   * The project's OPEN notes. Unwraps the `{ data, pagination }` list envelope to
   * the bare array. The seed filter (not self-authored, not the triage agent's,
   * not in flight) lives in the loop, not here.
   */
  listOpenNotes(projectId: string): Promise<Note[]> {
    return this.request<Note[]>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/notes?status=open`,
    );
  }

  /**
   * Fetch a project. The triager reads `data.settings.notesTriage` per watched
   * project per tick to compose the EFFECTIVE enablement/mode (the DB toggle
   * composed with the env master). `request<T>` unwraps the `{ data }` envelope.
   */
  getProject(projectId: string): Promise<TriagerProjectView> {
    return this.request<TriagerProjectView>("GET", `/projects/${encodeURIComponent(projectId)}`);
  }

  /**
   * Record a triage decision in the append-only side-log (T2·P1). NEVER mutates
   * the referenced note — it only attributes a disposition to the caller under a
   * rollout mode. Both shadow- and on-mode triage write here. `request<T>`
   * unwraps the `{ data }` envelope (201). Wired now; NOT called by the P2 stub.
   */
  recordTriageDecision(projectId: string, body: RecordTriageDecisionBody): Promise<TriageDecision> {
    return this.request<TriageDecision>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/triage-decisions`,
      body,
    );
  }

  /** Resolve this triager's own identity (used once at startup for selfId). */
  getMe(): Promise<SelfIdentity> {
    return this.request<SelfIdentity>("GET", "/auth/me");
  }
}
