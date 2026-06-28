/**
 * Standalone HTTP client for the PM notes/triage REST surface (triager slice).
 *
 * A deliberately minimal trim of the responder's pm-client: the triager only
 * ever touches a handful of endpoints — open-notes list (per project), project
 * read (for the per-tick effective enablement), triage-decision record (the
 * append-only side-log), and /auth/me (resolve selfId once at startup). The
 * single source of truth for the wire types is @pm/shared.
 *
 * P4 adds the decision-EXECUTION wrappers (promote-to-proposal / dismiss /
 * flag-needs-human / claim-proposal / implement-proposal) — they are now LIVE,
 * driven by the executor (`executor.ts`) under the resolved rollout mode. The
 * note/proposal action endpoints are project-AGNOSTIC in the path (the server
 * resolves the project from the entity), so these wrappers take a noteId /
 * proposalId, NOT a projectId.
 */
import type {
  Note,
  NotesTriageMode,
  ProposalKind,
  TriageDecision,
  TriageDecisionKind,
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

/**
 * The minimal proposal view the promote-to-proposal response returns as a
 * SIBLING of `data` (the note). Mirrors the server's `promotedProposalSchema`
 * (routes/notes.ts) — the raw create row, NOT the enriched proposal view.
 */
export interface PromotedProposal {
  id: string;
  projectId: string | null;
  title: string;
  description: string | null;
  status: string;
  proposalKind: ProposalKind;
  createdBy: string;
  sourceNoteId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The promote-to-proposal result: the (now-triaged) note + the minted proposal. */
export interface PromoteNoteToProposalResult {
  note: Note;
  proposal: PromotedProposal;
}

/** The structured claim outcome (no claimant IDs leaked). */
export interface ClaimResult {
  ok: boolean;
  status: string;
}

/** One epic to mint when implementing a proposal. */
export interface ImplementEpicInput {
  name: string;
  description?: string | null;
}

/** One task to mint when implementing a proposal. */
export interface ImplementTaskInput {
  title: string;
  description?: string | null;
  epicIndex?: number;
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

  /**
   * Unwrap the `{ data }` / `{ data, pagination }` envelope to the bare payload.
   * Most endpoints carry the payload under `.data`; the rest is delegated to
   * `requestRaw`. Use `requestRaw` directly when the response carries SIBLING
   * keys alongside `data` (e.g. promote-to-proposal's `{ data: note, proposal }`).
   */
  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const json = await this.requestRaw<unknown>(method, path, body);
    // Both the list (`{ data, pagination }`) and the single-entity responses
    // (`{ data }`) carry the payload under `.data` — unwrap it uniformly. The
    // list's pagination envelope is discarded; the triager reads only `.data`.
    if (json && typeof json === "object" && "data" in json) {
      return (json as { data: T }).data;
    }
    return json as T;
  }

  /**
   * The raw transport: performs the request, wraps every transport/HTTP failure
   * as a `PmApiError`, and returns the parsed JSON body VERBATIM (no `.data`
   * unwrap). `request` layers the envelope-unwrap on top.
   */
  private async requestRaw<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
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

  /**
   * Promote a note to a new proposal (triage outcome `promoted`). The ONLY
   * note→proposal path the triager has — task creation flows exclusively through
   * implementProposal on a fast_track proposal (the proposal-gate). Uses
   * `requestRaw` because the response is `{ data: note, proposal }` with
   * `proposal` a SIBLING of `data` (routes/notes.ts promoteToProposal handler).
   */
  async promoteToProposal(
    noteId: string,
    body: { proposalKind: ProposalKind; title?: string; description?: string },
  ): Promise<PromoteNoteToProposalResult> {
    const json = await this.requestRaw<{ data: Note; proposal: PromotedProposal }>(
      "POST",
      `/notes/${encodeURIComponent(noteId)}/promote-to-proposal`,
      body,
    );
    return { note: json.data, proposal: json.proposal };
  }

  /**
   * Terminally dismiss a note (triage outcome `dismissed`). Authz: only the
   * note's author OR a human may dismiss — a triager whose identity is NOT the
   * project's `triageAgentId` gets a 403 (the executor escalates that to
   * needs_human rather than hot-looping). `reason` must be non-empty.
   */
  dismissNote(noteId: string, reason: string): Promise<Note> {
    return this.request<Note>("POST", `/notes/${encodeURIComponent(noteId)}/dismiss`, { reason });
  }

  /**
   * Raise an open note to needs_human (signal-elevating; NO authz gate, so it is
   * the safe escalation sink that never 403s). Sets no triage metadata — the note
   * stays mutable.
   */
  flagNeedsHuman(noteId: string): Promise<Note> {
    return this.request<Note>("POST", `/notes/${encodeURIComponent(noteId)}/flag-needs-human`);
  }

  /** Atomically claim a proposal for the triager. Returns a structured outcome. */
  claimProposal(proposalId: string): Promise<ClaimResult> {
    return this.request<ClaimResult>("POST", `/proposals/${encodeURIComponent(proposalId)}/claim`);
  }

  /**
   * Atomically create epics + tasks from a (claimed) proposal, moving it to
   * in_progress. The fast_track breakdown is materialized HERE — the proposal-gate
   * means a note's tasks are only ever minted via a proposal, never directly.
   */
  async implementProposal(
    proposalId: string,
    body: { epics?: ImplementEpicInput[]; tasks?: ImplementTaskInput[] },
  ): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/proposals/${encodeURIComponent(proposalId)}/implement`,
      body,
    );
  }

  /** Resolve this triager's own identity (used once at startup for selfId). */
  getMe(): Promise<SelfIdentity> {
    return this.request<SelfIdentity>("GET", "/auth/me");
  }
}
