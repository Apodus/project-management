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

function getToken(): string {
  const token = process.env.PM_API_TOKEN;
  if (!token) {
    throw new Error(
      "PM_API_TOKEN environment variable is required. Set it to a valid API token.",
    );
  }
  return token;
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

export interface ProposalSummary {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  createdBy: string | null;
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
): Promise<ProposalSummary[]> {
  if (projectId) {
    return apiRequest<ProposalSummary[]>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/proposals${qs({ status })}`,
    );
  }
  // Without projectId, list all projects and aggregate proposals
  const projects = await listProjects();
  const all: ProposalSummary[] = [];
  for (const project of projects) {
    const proposals = await apiRequest<ProposalSummary[]>(
      "GET",
      `/projects/${encodeURIComponent(project.id)}/proposals${qs({ status })}`,
    );
    all.push(...proposals);
  }
  return all;
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
      authorId: "mcp-agent",
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
  epicId: string | null;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  type: string;
  assignee: string | null;
  estimatedEffort: string | null;
  dueDate: string | null;
  sortOrder: number;
  context: unknown;
  createdAt: string;
  updatedAt: string;
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
