import type { components } from "./api-types";

// ---- Types extracted from OpenAPI-generated definitions ----

export type Project = components["schemas"]["Project"];
export type CreateProject = components["schemas"]["CreateProject"];
export type UpdateProject = components["schemas"]["UpdateProject"];
export type ProjectStats = components["schemas"]["ProjectStats"];
export type Proposal = components["schemas"]["Proposal"];
export type CreateProposal = components["schemas"]["CreateProposal"];
export type UpdateProposal = components["schemas"]["UpdateProposal"];
export type ProposalDetail = components["schemas"]["ProposalDetail"];
export type ProposalTransition = components["schemas"]["ProposalTransition"];
export type Comment = components["schemas"]["Comment"];
export type AddProposalComment = components["schemas"]["AddProposalComment"];
export type ProposalEpic = components["schemas"]["ProposalEpic"];
export type ProposalTask = components["schemas"]["ProposalTask"];
export type Task = components["schemas"]["Task"];
export type CreateTask = components["schemas"]["CreateTask"];
export type UpdateTask = components["schemas"]["UpdateTask"];
export type TaskComment = components["schemas"]["TaskComment"];
export type CreateTaskComment = components["schemas"]["CreateTaskComment"];
export type Epic = components["schemas"]["Epic"];
export type CreateEpic = components["schemas"]["CreateEpic"];
export type UpdateEpic = components["schemas"]["UpdateEpic"];
export type TaskDependency = components["schemas"]["TaskDependency"];

// ---- API client ----

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit & { rawResponse?: boolean },
): Promise<T> {
  const url = `${BASE_URL}/api/v1${path}`;
  const { rawResponse, ...fetchOptions } = options ?? {};

  const headers: Record<string, string> = {
    ...(fetchOptions.headers as Record<string, string>),
  };

  // Only set Content-Type for requests with a body
  if (fetchOptions.body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    ...fetchOptions,
    headers,
    credentials: "include",
  });

  if (!response.ok) {
    let errorMessage = `API error: ${response.status}`;
    let errorCode = "UNKNOWN_ERROR";
    try {
      const errorBody = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      if (errorBody.error) {
        errorMessage = errorBody.error.message ?? errorMessage;
        errorCode = errorBody.error.code ?? errorCode;
      }
    } catch {
      // Failed to parse error body — use default message
    }
    throw new ApiError(response.status, errorCode, errorMessage);
  }

  const json = (await response.json()) as { data: T };

  // If rawResponse is set, return the full JSON (for paginated responses)
  if (rawResponse) {
    return json as unknown as T;
  }

  return json.data;
}

// ---- Project API ----

export async function getProjects(
  status?: string,
): Promise<Project[]> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  const query = params.toString();
  return apiFetch<Project[]>(`/projects${query ? `?${query}` : ""}`);
}

export async function createProject(data: CreateProject): Promise<Project> {
  return apiFetch<Project>("/projects", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getProject(id: string): Promise<Project> {
  return apiFetch<Project>(`/projects/${id}`);
}

export async function updateProject(
  id: string,
  data: UpdateProject,
): Promise<Project> {
  return apiFetch<Project>(`/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function getProjectStats(id: string): Promise<ProjectStats> {
  return apiFetch<ProjectStats>(`/projects/${id}/stats`);
}

// ---- Proposal API ----

export async function getProposals(
  projectId: string,
  status?: string,
): Promise<Proposal[]> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  const query = params.toString();
  return apiFetch<Proposal[]>(
    `/projects/${projectId}/proposals${query ? `?${query}` : ""}`,
  );
}

export async function createProposal(
  projectId: string,
  data: CreateProposal,
): Promise<Proposal> {
  return apiFetch<Proposal>(`/projects/${projectId}/proposals`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getProposal(id: string): Promise<ProposalDetail> {
  return apiFetch<ProposalDetail>(`/proposals/${id}`);
}

export async function updateProposal(
  id: string,
  data: UpdateProposal,
): Promise<Proposal> {
  return apiFetch<Proposal>(`/proposals/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function transitionProposal(
  id: string,
  toStatus: string,
  actorId: string = "human-director",
): Promise<Proposal> {
  return apiFetch<Proposal>(`/proposals/${id}/transitions`, {
    method: "POST",
    body: JSON.stringify({ toStatus, actorId }),
  });
}

export async function getProposalComments(id: string): Promise<Comment[]> {
  return apiFetch<Comment[]>(`/proposals/${id}/comments`);
}

export async function addProposalComment(
  id: string,
  body: string,
  type?: string,
): Promise<Comment> {
  return apiFetch<Comment>(`/proposals/${id}/comments`, {
    method: "POST",
    body: JSON.stringify({
      authorId: "human-director",
      body,
      ...(type ? { commentType: type } : {}),
    }),
  });
}

export async function getProposalWorkItems(
  id: string,
): Promise<{ epics: ProposalEpic[]; tasks: ProposalTask[] }> {
  return apiFetch<{ epics: ProposalEpic[]; tasks: ProposalTask[] }>(
    `/proposals/${id}/work-items`,
  );
}

// ---- Task API ----

export interface TaskFilters {
  status?: string;
  priority?: string;
  type?: string;
  assignee?: string;
  epic?: string;
  search?: string;
  sortBy?: string;
  order?: "asc" | "desc";
  page?: number;
  perPage?: number;
}

export interface PaginatedTasks {
  data: Task[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
  };
}

export async function getTasks(
  projectId: string,
  filters?: TaskFilters,
): Promise<PaginatedTasks> {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.priority) params.set("priority", filters.priority);
  if (filters?.type) params.set("type", filters.type);
  if (filters?.assignee) params.set("assignee", filters.assignee);
  if (filters?.epic) params.set("epic", filters.epic);
  if (filters?.search) params.set("search", filters.search);
  if (filters?.sortBy) params.set("sortBy", filters.sortBy);
  if (filters?.order) params.set("order", filters.order);
  if (filters?.page) params.set("page", String(filters.page));
  if (filters?.perPage) params.set("perPage", String(filters.perPage));
  const query = params.toString();
  return apiFetch<PaginatedTasks>(
    `/projects/${projectId}/tasks${query ? `?${query}` : ""}`,
    { rawResponse: true },
  );
}

export async function getTask(id: string): Promise<Task> {
  return apiFetch<Task>(`/tasks/${id}`);
}

export async function updateTask(
  id: string,
  data: UpdateTask,
): Promise<Task> {
  return apiFetch<Task>(`/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function getTaskComments(taskId: string): Promise<TaskComment[]> {
  return apiFetch<TaskComment[]>(`/tasks/${taskId}/comments`);
}

export async function addTaskComment(
  taskId: string,
  body: string,
  type?: string,
  metadata?: Record<string, unknown> | null,
): Promise<TaskComment> {
  return apiFetch<TaskComment>(`/tasks/${taskId}/comments`, {
    method: "POST",
    body: JSON.stringify({
      authorId: "human-director",
      body,
      ...(type ? { commentType: type } : {}),
      ...(metadata ? { metadata } : {}),
    }),
  });
}

export async function getTaskSubtasks(taskId: string): Promise<Task[]> {
  return apiFetch<Task[]>(`/tasks/${taskId}/subtasks`);
}

// ---- Epic API ----

export interface EpicFilters {
  status?: string;
  milestone?: string;
}

export async function getEpics(
  projectId: string,
  filters?: EpicFilters,
): Promise<Epic[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.milestone) params.set("milestone", filters.milestone);
  const query = params.toString();
  return apiFetch<Epic[]>(
    `/projects/${projectId}/epics${query ? `?${query}` : ""}`,
  );
}

export async function getEpic(id: string): Promise<Epic> {
  return apiFetch<Epic>(`/epics/${id}`);
}

// ---- Auth API ----

export interface SetupStatus {
  needsSetup: boolean;
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: string;
  type: string;
  avatarUrl: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SetupData {
  username: string;
  displayName: string;
  password: string;
}

export interface LoginData {
  username: string;
  password: string;
}

export async function getSetupStatus(): Promise<SetupStatus> {
  return apiFetch<SetupStatus>("/auth/setup/status");
}

export async function setup(data: SetupData): Promise<AuthUser> {
  return apiFetch<AuthUser>("/auth/setup", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function login(data: LoginData): Promise<AuthUser> {
  return apiFetch<AuthUser>("/auth/login", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function logout(): Promise<void> {
  await apiFetch<{ message: string }>("/auth/logout", {
    method: "POST",
  });
}

export async function getCurrentUser(): Promise<AuthUser> {
  return apiFetch<AuthUser>("/auth/me");
}

// ---- User Management API ----

export interface UserWithToken extends AuthUser {
  apiToken?: string;
}

export interface CreateUserData {
  username: string;
  displayName: string;
  email?: string | null;
  password?: string;
  role: string;
  type: string;
}

export interface UpdateUserData {
  username?: string;
  displayName?: string;
  email?: string | null;
  role?: string;
}

export async function getUsers(): Promise<AuthUser[]> {
  return apiFetch<AuthUser[]>("/users");
}

export async function createUser(data: CreateUserData): Promise<UserWithToken> {
  return apiFetch<UserWithToken>("/users", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateUser(
  id: string,
  data: UpdateUserData,
): Promise<AuthUser> {
  return apiFetch<AuthUser>(`/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function rotateToken(
  id: string,
): Promise<{ apiToken: string }> {
  return apiFetch<{ apiToken: string }>(`/users/${id}/rotate-token`, {
    method: "POST",
  });
}

export async function deactivateUser(id: string): Promise<AuthUser> {
  return apiFetch<AuthUser>(`/users/${id}/deactivate`, {
    method: "POST",
  });
}

export async function activateUser(id: string): Promise<AuthUser> {
  return apiFetch<AuthUser>(`/users/${id}/activate`, {
    method: "POST",
  });
}
