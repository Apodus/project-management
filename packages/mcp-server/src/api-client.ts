/**
 * HTTP client for calling the Project Management REST API.
 *
 * Reads PM_API_URL (default: http://localhost:3000) and PM_API_TOKEN from env.
 * All paths are automatically prefixed with /api/v1.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  return (process.env.PM_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * Mutable API token — set after claiming an agent from the pool.
 * Falls back to PM_API_TOKEN env var for backward compatibility.
 */
let _claimedToken: string | null = null;
let _claimedUserId: string | null = null;
let _claimedUsername: string | null = null;
let _claimedDisplayName: string | null = null;

function getToken(): string {
  if (_claimedToken) {
    return _claimedToken;
  }
  const token = process.env.PM_API_TOKEN;
  if (!token) {
    throw new Error(
      "PM_API_TOKEN environment variable is required. Set it to a valid API token, or set PM_POOL_SECRET to auto-claim from the agent pool.",
    );
  }
  return token;
}

/**
 * Get the current agent's identity (set after claim, or null if using static token).
 */
export function getAgentIdentity(): {
  userId: string;
  username: string;
  displayName: string;
} | null {
  if (_claimedUserId && _claimedUsername && _claimedDisplayName) {
    return {
      userId: _claimedUserId,
      username: _claimedUsername,
      displayName: _claimedDisplayName,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// Generic request function
// ---------------------------------------------------------------------------

export async function apiRequest<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${getBaseUrl()}/api/v1${path}`;
  const token = getToken();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Handle non-JSON responses
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    if (!res.ok) {
      throw new ApiError(res.status, "UNKNOWN_ERROR", `HTTP ${res.status}: ${res.statusText}`);
    }
    return undefined as T;
  }

  const json = await res.json();

  if (!res.ok) {
    const err = json?.error;
    throw new ApiError(
      res.status,
      err?.code ?? "UNKNOWN_ERROR",
      err?.message ?? `HTTP ${res.status}`,
    );
  }

  // Extract from { data: T } envelope
  if (json && typeof json === "object" && "data" in json) {
    return json.data as T;
  }

  return json as T;
}

// ---------------------------------------------------------------------------
// Query-string helper
// ---------------------------------------------------------------------------

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

// ---------------------------------------------------------------------------
// Typed API functions — Projects
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listProjects(status?: string): Promise<ProjectSummary[]> {
  return apiRequest<ProjectSummary[]>("GET", `/projects${qs({ status })}`);
}

export async function getProject(id: string): Promise<ProjectSummary> {
  return apiRequest<ProjectSummary>("GET", `/projects/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Typed API functions — Proposals
// ---------------------------------------------------------------------------

export type ClaimStatusValue = "unclaimed" | "claimed_by_you" | "claimed_by_other";

export interface ProposalSummary {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  createdBy: string | null;
  claimedBy?: string | null;
  claimStatus?: ClaimStatusValue;
  claimState?: ClaimState;
  commentCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProposalDetail extends ProposalSummary {
  comments: CommentData[];
  workItems: {
    epics: unknown[];
    tasks: unknown[];
  };
}

export type ClaimFilterValue = "available" | "mine" | "all";

export type ClaimResultStatus =
  | "claimed_by_you"
  | "already_claimed_by_you"
  | "claimed_by_another_agent"
  | "released"
  | "not_held"
  | "closed"
  | "force_claimed";

export interface ClaimResultData {
  ok: boolean;
  status: ClaimResultStatus;
}

export interface ForceClaimResultData {
  ok: boolean;
  status: "force_claimed";
  previousHolder: string;
  newHolder: string;
}

export interface CommentData {
  id: string;
  body: string;
  authorId: string | null;
  commentType: string;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

export async function listProposals(
  projectId?: string,
  status?: string,
  claim?: ClaimFilterValue,
): Promise<ProposalSummary[]> {
  const params = { status, claim };
  if (projectId) {
    return apiRequest<ProposalSummary[]>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/proposals${qs(params)}`,
    );
  }
  // Without projectId, list all projects and aggregate proposals
  const projects = await listProjects();
  const all: ProposalSummary[] = [];
  for (const project of projects) {
    const proposals = await apiRequest<ProposalSummary[]>(
      "GET",
      `/projects/${encodeURIComponent(project.id)}/proposals${qs(params)}`,
    );
    all.push(...proposals);
  }
  return all;
}

export interface CreateProposalData {
  title: string;
  description?: string | null;
}

export async function createProposal(
  projectId: string,
  data: CreateProposalData,
): Promise<ProposalSummary> {
  return apiRequest<ProposalSummary>(
    "POST",
    `/projects/${encodeURIComponent(projectId)}/proposals`,
    data,
  );
}

export async function claimProposal(proposalId: string): Promise<ClaimResultData> {
  return apiRequest<ClaimResultData>(
    "POST",
    `/proposals/${encodeURIComponent(proposalId)}/claim`,
  );
}

export async function releaseProposal(proposalId: string): Promise<ClaimResultData> {
  return apiRequest<ClaimResultData>(
    "POST",
    `/proposals/${encodeURIComponent(proposalId)}/release`,
  );
}

export async function forceClaimProposal(
  proposalId: string,
  reason: string,
  assigneeId?: string,
): Promise<ForceClaimResultData> {
  return apiRequest<ForceClaimResultData>(
    "POST",
    `/proposals/${encodeURIComponent(proposalId)}/force-claim`,
    { reason, newAssigneeId: assigneeId },
  );
}

export async function getProposal(id: string): Promise<ProposalDetail> {
  const proposal = await apiRequest<ProposalSummary>("GET", `/proposals/${encodeURIComponent(id)}`);

  // Fetch comments and work items in parallel
  const [comments, workItems] = await Promise.all([
    apiRequest<CommentData[]>("GET", `/proposals/${encodeURIComponent(id)}/comments`),
    apiRequest<{ epics: unknown[]; tasks: unknown[] }>(
      "GET",
      `/proposals/${encodeURIComponent(id)}/work-items`,
    ),
  ]);

  return {
    ...proposal,
    comments,
    workItems,
  };
}

export async function addProposalComment(
  proposalId: string,
  body: string,
  commentType?: string,
): Promise<{ comment: CommentData; proposal: ProposalSummary }> {
  const comment = await apiRequest<CommentData>(
    "POST",
    `/proposals/${encodeURIComponent(proposalId)}/comments`,
    {
      body,
      ...(commentType ? { commentType } : {}),
    },
  );

  // Re-fetch proposal to get updated status
  const proposal = await apiRequest<ProposalSummary>(
    "GET",
    `/proposals/${encodeURIComponent(proposalId)}`,
  );

  return { comment, proposal };
}

// ---------------------------------------------------------------------------
// Typed API functions — Tasks
// ---------------------------------------------------------------------------

export interface TaskSummary {
  id: string;
  projectId: string;
  proposalId: string | null;
  epicId: string | null;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  type: string;
  assigneeId: string | null;
  reporterId: string;
  estimatedEffort: string | null;
  dueDate: string | null;
  sortOrder: number;
  context: unknown;
  gitBranch: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  // Server-enriched display names for foreign-key references.
  epicName: string | null;
  projectName: string | null;
  parentTaskTitle: string | null;
  assigneeName: string | null;
  assigneeType: string | null;
  reporterName: string | null;
  reporterType: string | null;
  // Identity-masked liveness view of the claim (C3): unclaimed/live/stale/yours.
  claimState?: ClaimState;
}

export interface TaskFilters {
  project_id?: string;
  epic_id?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  type?: string;
  is_blocked?: boolean;
  search?: string;
  label?: string;
  label_name?: string;
  claim?: ClaimFilterValue;
  sort?: string;
  limit?: number;
}

export async function listTasks(filters: TaskFilters): Promise<TaskSummary[]> {
  if (!filters.project_id) {
    // Without project_id, list all projects and aggregate tasks
    const projects = await listProjects();
    const all: TaskSummary[] = [];
    for (const project of projects) {
      const tasks = await listTasks({ ...filters, project_id: project.id });
      all.push(...tasks);
      if (filters.limit && all.length >= filters.limit) {
        return all.slice(0, filters.limit);
      }
    }
    return all;
  }

  const params: Record<string, string | number | boolean | undefined> = {};
  if (filters.epic_id) params.epic = filters.epic_id;
  if (filters.status) params.status = filters.status;
  if (filters.priority) params.priority = filters.priority;
  if (filters.assignee) params.assignee = filters.assignee;
  if (filters.type) params.type = filters.type;
  if (filters.is_blocked !== undefined) params.is_blocked = String(filters.is_blocked);
  if (filters.search) params.search = filters.search;
  if (filters.label) params.label = filters.label;
  if (filters.label_name) params.label_name = filters.label_name;
  if (filters.claim) params.claim = filters.claim;
  if (filters.sort) params.sortBy = filters.sort;
  if (filters.limit) params.perPage = filters.limit;

  return apiRequest<TaskSummary[]>(
    "GET",
    `/projects/${encodeURIComponent(filters.project_id)}/tasks${qs(params)}`,
  );
}

export async function getTask(id: string): Promise<TaskSummary> {
  return apiRequest<TaskSummary>("GET", `/tasks/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Typed API functions — Search
// ---------------------------------------------------------------------------

export interface SearchResult {
  entityType: string;
  entityId: string;
  title: string;
  excerpt: string;
  rank: number;
  projectId: string | null;
}

export interface SearchOptions {
  project_id?: string;
  entity_type?: string;
  limit?: number;
}

export async function search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
  const params: Record<string, string | number | boolean | undefined> = {
    q: query,
  };
  if (options?.project_id) params.project_id = options.project_id;
  if (options?.entity_type) params.entity_type = options.entity_type;
  if (options?.limit) params.limit = options.limit;

  return apiRequest<SearchResult[]>("GET", `/search${qs(params)}`);
}

// ---------------------------------------------------------------------------
// Typed API functions — Implement Proposal
// ---------------------------------------------------------------------------

export interface ImplementProposalData {
  epics?: Array<{
    name: string;
    description?: string | null;
    priority?: string;
    status?: string;
  }>;
  tasks?: Array<{
    title: string;
    description?: string | null;
    priority?: string;
    type?: string;
    epicIndex?: number;
  }>;
}

export async function implementProposal(
  proposalId: string,
  data: ImplementProposalData,
): Promise<ProposalSummary> {
  return apiRequest<ProposalSummary>(
    "POST",
    `/proposals/${encodeURIComponent(proposalId)}/implement`,
    data,
  );
}

export async function transitionProposal(
  proposalId: string,
  toStatus: string,
): Promise<ProposalSummary> {
  return apiRequest<ProposalSummary>(
    "POST",
    `/proposals/${encodeURIComponent(proposalId)}/transitions`,
    { toStatus },
  );
}

// ---------------------------------------------------------------------------
// Typed API functions — Task Workflow
// ---------------------------------------------------------------------------

export async function transitionTask(
  taskId: string,
  toStatus: string,
  comment?: string,
): Promise<TaskSummary> {
  return apiRequest<TaskSummary>(
    "POST",
    `/tasks/${encodeURIComponent(taskId)}/transitions`,
    {
      to_status: toStatus,
      ...(comment ? { comment } : {}),
    },
  );
}

export interface PickNextOptions {
  project_id?: string;
  epic_id?: string;
  task_types?: string[];
  max_effort?: string;
}

export async function pickNextTask(options?: PickNextOptions): Promise<TaskSummary | null> {
  try {
    return await apiRequest<TaskSummary>("POST", `/tasks/pick-next`, options ?? {});
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Typed API functions — Task Comments
// ---------------------------------------------------------------------------

export async function addTaskComment(
  taskId: string,
  body: string,
  commentType?: string,
  metadata?: Record<string, unknown> | null,
): Promise<CommentData> {
  return apiRequest<CommentData>(
    "POST",
    `/tasks/${encodeURIComponent(taskId)}/comments`,
    {
      body,
      ...(commentType ? { commentType } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// Typed API functions — Task Dependencies
// ---------------------------------------------------------------------------

export interface DependencyData {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  dependencyType: string;
  createdAt: string;
}

export async function addTaskDependency(
  taskId: string,
  dependsOnTaskId: string,
  type?: string,
): Promise<DependencyData> {
  return apiRequest<DependencyData>(
    "POST",
    `/tasks/${encodeURIComponent(taskId)}/dependencies`,
    {
      dependsOnTaskId,
      ...(type ? { type } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// Typed API functions — Epic Dependencies
// ---------------------------------------------------------------------------

export interface EpicDependencyData {
  id: string;
  projectId: string;
  epicId: string;
  dependsOnEpicId: string;
  dependencyType: string;
  createdAt: string;
  createdBy: string | null;
}

export async function addEpicDependency(
  epicId: string,
  dependsOnEpicId: string,
  projectId: string,
  type?: string,
): Promise<EpicDependencyData> {
  return apiRequest<EpicDependencyData>(
    "POST",
    `/projects/${encodeURIComponent(projectId)}/epics/${encodeURIComponent(epicId)}/dependencies`,
    {
      dependsOnEpicId,
      ...(type ? { dependencyType: type } : {}),
    },
  );
}

export async function removeEpicDependency(
  epicId: string,
  depId: string,
  projectId: string,
): Promise<EpicDependencyData> {
  return apiRequest<EpicDependencyData>(
    "DELETE",
    `/projects/${encodeURIComponent(projectId)}/epics/${encodeURIComponent(epicId)}/dependencies/${encodeURIComponent(depId)}`,
  );
}

// ---------------------------------------------------------------------------
// Typed API functions — Create / Update Tasks
// ---------------------------------------------------------------------------

export interface CreateTaskData {
  title: string;
  description?: string | null;
  epicId?: string | null;
  parentTaskId?: string | null;
  priority?: string;
  type?: string;
  estimatedEffort?: string | null;
  context?: Record<string, unknown> | null;
}

export async function createTask(
  projectId: string,
  data: CreateTaskData,
): Promise<TaskSummary> {
  return apiRequest<TaskSummary>(
    "POST",
    `/projects/${encodeURIComponent(projectId)}/tasks`,
    data,
  );
}

export interface UpdateTaskData {
  title?: string;
  description?: string | null;
  priority?: string;
  type?: string;
  estimatedEffort?: string | null;
  context?: Record<string, unknown> | null;
  dueDate?: string | null;
}

export async function updateTask(
  taskId: string,
  data: UpdateTaskData,
): Promise<TaskSummary> {
  return apiRequest<TaskSummary>(
    "PATCH",
    `/tasks/${encodeURIComponent(taskId)}`,
    data,
  );
}

// ---------------------------------------------------------------------------
// Typed API functions — Git Refs
// ---------------------------------------------------------------------------

export interface GitRefData {
  id: string;
  taskId: string;
  refType: string;
  refValue: string;
  url: string | null;
  title: string | null;
  status: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface CreateGitRefData {
  refType: string;
  refValue: string;
  url?: string | null;
  title?: string | null;
}

export async function createGitRef(
  taskId: string,
  data: CreateGitRefData,
): Promise<GitRefData> {
  return apiRequest<GitRefData>(
    "POST",
    `/tasks/${encodeURIComponent(taskId)}/git-refs`,
    data,
  );
}

// ---------------------------------------------------------------------------
// Typed API functions — Project Tasks (for board resource)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Typed API functions — Activity Updates
// ---------------------------------------------------------------------------

export interface ActivityEntry {
  id: string;
  entityType: string;
  entityId: string;
  projectId: string | null;
  actorId: string | null;
  action: string;
  changes: unknown;
  createdAt: string;
}

export interface UpdatesResponse {
  has_updates: boolean;
  count: number;
  data: ActivityEntry[];
}

export async function checkUpdates(
  since: string,
  projectId?: string,
): Promise<UpdatesResponse> {
  const params: Record<string, string | number | boolean | undefined> = {
    since,
  };
  if (projectId) params.project_id = projectId;

  // The /activity/updates endpoint returns { has_updates, count, data } directly (not wrapped in { data })
  const url = `${getBaseUrl()}/api/v1/activity/updates${qs(params)}`;
  const token = getToken();

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const json = await res.json().catch(() => null);
    const err = json?.error;
    throw new ApiError(
      res.status,
      err?.code ?? "UNKNOWN_ERROR",
      err?.message ?? `HTTP ${res.status}`,
    );
  }

  return (await res.json()) as UpdatesResponse;
}

// ---------------------------------------------------------------------------
// Typed API functions — Project Tasks (for board resource)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Typed API functions — Agent Pool
// ---------------------------------------------------------------------------

export interface AgentClaimResponse {
  user: {
    id: string;
    username: string;
    displayName: string;
    role: string;
    type: string;
  };
  token: string;
  /**
   * Opaque server-issued handle for a keyed binding (present only when a
   * workerKey was supplied). Carried on the wire for honesty; unconsumed by
   * the client — rebind keys on workerKey, so a stable workerKey suffices.
   */
  bindHandle?: string;
}

/**
 * Claim an agent from a named pool using the pool secret.
 * This is an unauthenticated call (authenticated by pool secret in body).
 *
 * When `workerKey` is supplied, the server re-binds the SAME agent identity
 * across reconnect/restart for a given (pool, workerKey); omitting it is the
 * legacy behavior (grab any free agent). The request body is byte-identical to
 * the keyless form when `workerKey` is absent.
 */
export async function claimAgent(
  poolName: string,
  poolSecret: string,
  workerKey?: string,
): Promise<AgentClaimResponse> {
  const url = `${getBaseUrl()}/api/v1/auth/agent-claim`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ poolName, poolSecret, ...(workerKey ? { workerKey } : {}) }),
  });

  const json = await res.json();

  if (!res.ok) {
    const err = json?.error;
    throw new ApiError(
      res.status,
      err?.code ?? "UNKNOWN_ERROR",
      err?.message ?? `HTTP ${res.status}`,
    );
  }

  const result = json.data as AgentClaimResponse;

  // Store the claimed identity and token
  _claimedToken = result.token;
  _claimedUserId = result.user.id;
  _claimedUsername = result.user.username;
  _claimedDisplayName = result.user.displayName;

  return result;
}

/**
 * Release the current agent's claim.
 */
export async function releaseAgent(): Promise<void> {
  await apiRequest<{ message: string }>("POST", "/auth/agent-release");
  _claimedToken = null;
  _claimedUserId = null;
  _claimedUsername = null;
  _claimedDisplayName = null;
}

/**
 * Decide whether to release the pool claim on process shutdown.
 *
 * Release only a keyless pool claim (legacy behavior). When PM_WORKER_KEY is
 * set the binding is durable by design — the server's releaseAgent deletes the
 * claim with NO worker_key filter, so releasing on shutdown would strand the
 * keyed binding and force the next respawn to first-bind a NEW identity,
 * defeating stable-identity (C1). Returns false for a static token (never a
 * pool claim) and when no identity was claimed.
 */
export function shouldReleaseOnShutdown(): boolean {
  const workerKey = process.env.PM_WORKER_KEY?.trim() || undefined;
  return Boolean(
    !process.env.PM_API_TOKEN &&
      process.env.PM_POOL_SECRET &&
      !workerKey &&
      getAgentIdentity(),
  );
}

/**
 * Send a heartbeat to extend the current agent's claim TTL.
 */
export async function agentHeartbeat(): Promise<void> {
  await apiRequest<{ message: string }>("POST", "/auth/agent-heartbeat");
}

// ---------------------------------------------------------------------------
// Typed API functions — Epic Claim/Release
// ---------------------------------------------------------------------------

export interface EpicSummary {
  id: string;
  projectId: string;
  proposalId: string | null;
  milestoneId: string | null;
  assigneeId: string | null;
  claimStatus?: ClaimStatusValue;
  claimState?: ClaimState;
  name: string;
  description: string | null;
  status: string;
  priority: string;
  targetDate: string | null;
  category?: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  taskSummary: {
    total: number;
    done: number;
    byStatus: Record<string, number>;
  };
}

export interface CreateEpicData {
  name: string;
  description?: string | null;
  status?: string;
  priority?: string;
  proposalId?: string | null;
  milestoneId?: string | null;
  targetDate?: string | null;
  category?: string | null;
}

export async function listEpics(
  projectId?: string,
  filters?: { status?: string; milestone?: string; claim?: ClaimFilterValue },
): Promise<EpicSummary[]> {
  const params = {
    status: filters?.status,
    milestone: filters?.milestone,
    claim: filters?.claim,
  };
  if (projectId) {
    return apiRequest<EpicSummary[]>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/epics${qs(params)}`,
    );
  }
  // Without projectId, aggregate across all projects
  const projects = await listProjects();
  const all: EpicSummary[] = [];
  for (const project of projects) {
    const epics = await apiRequest<EpicSummary[]>(
      "GET",
      `/projects/${encodeURIComponent(project.id)}/epics${qs(params)}`,
    );
    all.push(...epics);
  }
  return all;
}

export async function getEpic(epicId: string): Promise<EpicSummary> {
  return apiRequest<EpicSummary>(
    "GET",
    `/epics/${encodeURIComponent(epicId)}`,
  );
}

export async function createEpic(
  projectId: string,
  data: CreateEpicData,
): Promise<EpicSummary> {
  return apiRequest<EpicSummary>(
    "POST",
    `/projects/${encodeURIComponent(projectId)}/epics`,
    data,
  );
}

export async function claimEpic(epicId: string): Promise<ClaimResultData> {
  return apiRequest<ClaimResultData>(
    "POST",
    `/epics/${encodeURIComponent(epicId)}/claim`,
  );
}

export async function releaseEpic(epicId: string): Promise<ClaimResultData> {
  return apiRequest<ClaimResultData>(
    "POST",
    `/epics/${encodeURIComponent(epicId)}/release`,
  );
}

export async function forceClaimEpic(
  epicId: string,
  reason: string,
  assigneeId?: string,
): Promise<ForceClaimResultData> {
  return apiRequest<ForceClaimResultData>(
    "POST",
    `/epics/${encodeURIComponent(epicId)}/force-claim`,
    { reason, newAssigneeId: assigneeId },
  );
}

// ---------------------------------------------------------------------------
// Typed API functions — Project Tasks (for board resource)
// ---------------------------------------------------------------------------

export async function getProjectTasks(
  projectId: string,
  status?: string,
): Promise<TaskSummary[]> {
  const params: Record<string, string | number | boolean | undefined> = {};
  if (status) params.status = status;

  return apiRequest<TaskSummary[]>(
    "GET",
    `/projects/${encodeURIComponent(projectId)}/tasks${qs(params)}`,
  );
}

// ---------------------------------------------------------------------------
// Typed API functions — Task Claim/Release/Awareness
// ---------------------------------------------------------------------------

export async function claimTask(taskId: string): Promise<ClaimResultData> {
  return apiRequest<ClaimResultData>(
    "POST",
    `/tasks/${encodeURIComponent(taskId)}/claim`,
  );
}

export async function releaseTask(taskId: string): Promise<ClaimResultData> {
  return apiRequest<ClaimResultData>(
    "POST",
    `/tasks/${encodeURIComponent(taskId)}/release`,
  );
}

export async function forceClaimTask(
  taskId: string,
  reason: string,
  assigneeId?: string,
): Promise<ForceClaimResultData> {
  return apiRequest<ForceClaimResultData>(
    "POST",
    `/tasks/${encodeURIComponent(taskId)}/force-claim`,
    { reason, newAssigneeId: assigneeId },
  );
}

export interface AwarenessAssignee {
  id: string;
  name: string | null;
  type: string | null;
}

export interface AwarenessInFlightEntry {
  taskId: string;
  title: string;
  assignee: AwarenessAssignee | null;
  claimState?: ClaimState;
  gitBranch: string | null;
  startedAt: string | null;
}

export interface AwarenessData {
  label: string | null;
  inFlight: AwarenessInFlightEntry[];
  total: number;
}

export async function awareness(
  projectId: string,
  label?: string,
): Promise<AwarenessData> {
  return apiRequest<AwarenessData>(
    "GET",
    `/projects/${encodeURIComponent(projectId)}/awareness${qs({ label })}`,
  );
}

// ---------------------------------------------------------------------------
// Typed API functions — Merge Locks
// ---------------------------------------------------------------------------

export type MergeLockAcquireStatusValue = "held" | "queued" | "already_held";
export type MergeLockHeartbeatStatusValue = "refreshed" | "not_holder";
export type MergeLockReleaseStatusValue = "released" | "not_held" | "not_holder";

export interface MergeLockAcquireData {
  ok: boolean;
  status: MergeLockAcquireStatusValue;
  position?: number | null;
  expiresAt?: string | null;
}

export interface MergeLockHeartbeatData {
  ok: boolean;
  status: MergeLockHeartbeatStatusValue;
  expiresAt?: string | null;
}

export interface MergeLockReleaseData {
  ok: boolean;
  status: MergeLockReleaseStatusValue;
  grantedTo?: string | null;
}

export interface MergeLockLandingIntent {
  taskId?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  verifyCmd?: string | null;
  worktreePath?: string | null;
}

export interface MergeLockView {
  id: string;
  projectId: string;
  resource: string;
  holder: "you" | "someone_else" | "none";
  holderId: string | null;
  acquiredAt: string | null;
  heartbeatAt: string | null;
  expiresAt: string | null;
  landedSha: string | null;
  landedAt: string | null;
  taskId: string | null;
  branch: string | null;
  commitSha: string | null;
  verifyCmd: string | null;
  worktreePath: string | null;
  abandonReason: string | null;
  queueLength: number;
  yourPosition: number | null;
  createdAt: string;
  updatedAt: string;
}

export async function acquireMergeLock(
  projectId: string,
  resource: string,
  intent?: MergeLockLandingIntent,
): Promise<MergeLockAcquireData> {
  return apiRequest<MergeLockAcquireData>(
    "POST",
    `/projects/${encodeURIComponent(projectId)}/merge-locks/${encodeURIComponent(resource)}/acquire`,
    intent ?? {},
  );
}

export async function heartbeatMergeLock(
  projectId: string,
  resource: string,
): Promise<MergeLockHeartbeatData> {
  return apiRequest<MergeLockHeartbeatData>(
    "POST",
    `/projects/${encodeURIComponent(projectId)}/merge-locks/${encodeURIComponent(resource)}/heartbeat`,
  );
}

export async function releaseMergeLock(
  projectId: string,
  resource: string,
  opts?: { landedSha?: string; reason?: string },
): Promise<MergeLockReleaseData> {
  const body: Record<string, string> = {};
  if (opts?.landedSha) body.landedSha = opts.landedSha;
  if (opts?.reason) body.reason = opts.reason;
  return apiRequest<MergeLockReleaseData>(
    "POST",
    `/projects/${encodeURIComponent(projectId)}/merge-locks/${encodeURIComponent(resource)}/release`,
    body,
  );
}

export async function getMergeLock(
  projectId: string,
  resource: string,
): Promise<MergeLockView> {
  return apiRequest<MergeLockView>(
    "GET",
    `/projects/${encodeURIComponent(projectId)}/merge-locks/${encodeURIComponent(resource)}`,
  );
}

export async function listMergeLocks(
  projectId: string,
): Promise<MergeLockView[]> {
  return apiRequest<MergeLockView[]>(
    "GET",
    `/projects/${encodeURIComponent(projectId)}/merge-locks`,
  );
}

// ---------------------------------------------------------------------------
// Typed API functions — Merge Requests (Stage 2)
// ---------------------------------------------------------------------------
//
// Single source of truth for status/category value-spaces lives in
// @pm/shared (MERGE_REQUEST_STATUSES, MERGE_ATTEMPT_STATUSES,
// MERGE_REJECT_CATEGORIES). We import the view types from there too so
// the api-client never re-declares those unions.

import type {
  MergeRequestView,
  MergeAttemptView,
  MergeRequestStatus,
  MergeRequestGroupView,
  MergeIncidentView,
  ClaimState,
} from "@pm/shared";

// Re-export so MCP tool files can pull types from one place.
export type {
  MergeRequestView,
  MergeAttemptView,
  MergeRequestStatus,
  MergeRejectCategory,
  ClaimState,
} from "@pm/shared";

export interface MergeRequestDetailView extends MergeRequestView {
  attempts: MergeAttemptView[];
}

export interface MergeRequestSubmitBody {
  resource?: string;
  taskId?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  verifyCmd?: string | null;
  worktreePath?: string | null;
}

export interface MergeRequestListFilters {
  resource?: string;
  status?: MergeRequestStatus;
  taskId?: string;
  page?: number;
  perPage?: number;
}

/**
 * Submit a new merge request — worker-facing. Returns the queued row.
 */
export async function submitMergeRequest(
  projectId: string,
  body: MergeRequestSubmitBody,
): Promise<MergeRequestView> {
  return apiRequest<MergeRequestView>(
    "POST",
    `/projects/${encodeURIComponent(projectId)}/merge-requests`,
    body,
  );
}

/**
 * List merge requests for a project. apiRequest extracts .data; pagination is dropped.
 */
export async function listMergeRequests(
  projectId: string,
  filters?: MergeRequestListFilters,
): Promise<MergeRequestView[]> {
  const params: Record<string, string | number | boolean | undefined> = {};
  if (filters?.resource) params.resource = filters.resource;
  if (filters?.status) params.status = filters.status;
  if (filters?.taskId) params.taskId = filters.taskId;
  if (filters?.page) params.page = filters.page;
  if (filters?.perPage) params.perPage = filters.perPage;
  return apiRequest<MergeRequestView[]>(
    "GET",
    `/projects/${encodeURIComponent(projectId)}/merge-requests${qs(params)}`,
  );
}

/**
 * Get a single merge request with its attempts (most-recent first).
 */
export async function getMergeRequest(
  requestId: string,
): Promise<MergeRequestDetailView> {
  return apiRequest<MergeRequestDetailView>(
    "GET",
    `/merge-requests/${encodeURIComponent(requestId)}`,
  );
}

/**
 * Cancel a merge request from queued OR integrating. Any authenticated user
 * (collaborative env). Pass an optional `reason` (recorded on the audit log for
 * an integrating-cancel). A grouped member returns 409 GROUPED_MEMBER.
 */
export async function cancelMergeRequest(
  requestId: string,
  reason?: string,
): Promise<MergeRequestView> {
  return apiRequest<MergeRequestView>(
    "POST",
    `/merge-requests/${encodeURIComponent(requestId)}/cancel`,
    reason !== undefined ? { reason } : undefined,
  );
}

/**
 * Integrator picks up a queued request — queued → integrating.
 */
export async function pickupMergeRequest(
  requestId: string,
): Promise<MergeRequestView> {
  return apiRequest<MergeRequestView>(
    "POST",
    `/merge-requests/${encodeURIComponent(requestId)}/pickup`,
  );
}

// ---------------------------------------------------------------------------
// Typed API functions — Merge Groups + Incidents (Phase 7.3, worker-facing)
// ---------------------------------------------------------------------------
//
// Single source of truth for the view shapes lives in @pm/shared
// (MergeRequestGroupView, MergeIncidentView). Only the WORKER-facing
// operations live here — the integrator ops (pickup/land/reject/orphan/
// partially-land/resolve) are HTTP-only.

// Re-export so MCP tool files can pull types from one place.
export type { MergeRequestGroupView, MergeIncidentView } from "@pm/shared";

export interface MergeRequestGroupDetailView extends MergeRequestGroupView {
  members: MergeRequestView[];
}

/**
 * One member of the atomic submit-and-group form. camelCase on the wire (matches
 * the merge-request submit body); at least one of branch / commitSha.
 */
export interface MergeGroupMemberSpecBody {
  branch?: string;
  commitSha?: string;
  verifyCmd?: string;
  taskId?: string;
}

/**
 * Exactly one of `memberRequestIds` (bind existing) | `members` (atomic
 * submit-and-group). The server enforces the exactly-one-of; this client just
 * carries whichever the caller set.
 */
export interface MergeGroupRequestBody {
  resource?: string;
  memberRequestIds?: string[];
  members?: MergeGroupMemberSpecBody[];
}

export interface MergeIncidentListFilters {
  state?: string;
  type?: string;
  groupId?: string;
}

/**
 * Request a merge group — worker-facing. Submits >=2 already-queued,
 * ungrouped requests as one atomic unit. Returns the forming group + members.
 */
export async function requestMergeGroup(
  projectId: string,
  body: MergeGroupRequestBody,
): Promise<MergeRequestGroupDetailView> {
  return apiRequest<MergeRequestGroupDetailView>(
    "POST",
    `/projects/${encodeURIComponent(projectId)}/merge-groups`,
    body,
  );
}

/**
 * Get a single merge group with its members.
 */
export async function getMergeGroup(
  groupId: string,
): Promise<MergeRequestGroupDetailView> {
  return apiRequest<MergeRequestGroupDetailView>(
    "GET",
    `/merge-groups/${encodeURIComponent(groupId)}`,
  );
}

/**
 * List merge incidents for a project. apiRequest extracts the .data array.
 */
export async function listMergeIncidents(
  projectId: string,
  filters?: MergeIncidentListFilters,
): Promise<MergeIncidentView[]> {
  const params: Record<string, string | number | boolean | undefined> = {};
  if (filters?.state) params.state = filters.state;
  if (filters?.type) params.type = filters.type;
  if (filters?.groupId) params.groupId = filters.groupId;
  return apiRequest<MergeIncidentView[]>(
    "GET",
    `/projects/${encodeURIComponent(projectId)}/merge-incidents${qs(params)}`,
  );
}

/**
 * Get a single merge incident.
 */
export async function getMergeIncident(
  incidentId: string,
): Promise<MergeIncidentView> {
  return apiRequest<MergeIncidentView>(
    "GET",
    `/merge-incidents/${encodeURIComponent(incidentId)}`,
  );
}
