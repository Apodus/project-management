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
  is_blocked?: "true" | "false";
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
  if (filters?.is_blocked) params.set("is_blocked", filters.is_blocked);
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

export async function transitionTask(
  taskId: string,
  toStatus: string,
  comment?: string,
): Promise<Task> {
  return apiFetch<Task>(`/tasks/${taskId}/transitions`, {
    method: "POST",
    body: JSON.stringify({
      to_status: toStatus,
      ...(comment ? { comment } : {}),
    }),
  });
}

// ---- Activity API ----

export type ActivityLogEntry = components["schemas"]["ActivityLogEntry"];

export interface ActivityFilters {
  entity_type?: string;
  actor_id?: string;
  page?: number;
  per_page?: number;
}

export interface PaginatedActivity {
  data: ActivityLogEntry[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
  };
}

export async function getProjectActivity(
  projectId: string,
  filters?: ActivityFilters,
): Promise<PaginatedActivity> {
  const params = new URLSearchParams();
  if (filters?.entity_type) params.set("entity_type", filters.entity_type);
  if (filters?.actor_id) params.set("actor_id", filters.actor_id);
  if (filters?.page) params.set("page", String(filters.page));
  if (filters?.per_page) params.set("per_page", String(filters.per_page));
  const query = params.toString();
  return apiFetch<PaginatedActivity>(
    `/projects/${projectId}/activity${query ? `?${query}` : ""}`,
    { rawResponse: true },
  );
}

export async function getTaskActivity(
  taskId: string,
  page?: number,
  perPage?: number,
): Promise<PaginatedActivity> {
  const params = new URLSearchParams();
  if (page) params.set("page", String(page));
  if (perPage) params.set("per_page", String(perPage));
  const query = params.toString();
  return apiFetch<PaginatedActivity>(
    `/tasks/${taskId}/activity${query ? `?${query}` : ""}`,
    { rawResponse: true },
  );
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

export async function updateEpic(
  id: string,
  data: UpdateEpic,
): Promise<Epic> {
  return apiFetch<Epic>(`/epics/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

// ---- Milestone API ----

export type Milestone = components["schemas"]["Milestone"];
export type CreateMilestone = components["schemas"]["CreateMilestone"];
export type UpdateMilestone = components["schemas"]["UpdateMilestone"];

export async function getMilestones(
  projectId: string,
): Promise<Milestone[]> {
  return apiFetch<Milestone[]>(
    `/projects/${projectId}/milestones`,
  );
}

export async function createMilestone(
  projectId: string,
  data: CreateMilestone,
): Promise<Milestone> {
  return apiFetch<Milestone>(`/projects/${projectId}/milestones`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateMilestone(
  id: string,
  data: UpdateMilestone,
): Promise<Milestone> {
  return apiFetch<Milestone>(`/milestones/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteMilestone(id: string): Promise<Milestone> {
  return apiFetch<Milestone>(`/milestones/${id}`, {
    method: "DELETE",
  });
}

// ---- Export/Import API ----

export async function exportProject(
  projectId: string,
  includeActivity?: boolean,
): Promise<Blob> {
  const params = new URLSearchParams();
  if (includeActivity) params.set("include_activity", "true");
  const query = params.toString();
  const url = `${BASE_URL}/api/v1/projects/${projectId}/export${query ? `?${query}` : ""}`;

  const response = await fetch(url, {
    credentials: "include",
  });

  if (!response.ok) {
    throw new ApiError(response.status, "EXPORT_ERROR", "Failed to export project");
  }

  return response.blob();
}

export async function importProject(data: unknown): Promise<Project> {
  return apiFetch<Project>("/projects/import", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export interface BackupResult {
  path: string;
  size: number;
  timestamp: string;
}

export async function backupDatabase(): Promise<BackupResult> {
  return apiFetch<BackupResult>("/backup", {
    method: "POST",
  });
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
  poolId: string | null;
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

// ---- Templates API ----

export interface Template {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  templateType: string;
  templateData: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export interface CreateTemplateData {
  name: string;
  description?: string | null;
  project_id?: string | null;
  template_type: "task" | "project";
  template_data: Record<string, unknown>;
  created_by?: string | null;
}

export interface UpdateTemplateData {
  name?: string;
  description?: string | null;
  template_data?: Record<string, unknown>;
}

export interface InstantiateTemplateData {
  project_id?: string;
  workspace_id?: string;
  name?: string;
  overrides?: Record<string, unknown>;
}

export interface CreateTemplateFromTaskData {
  name: string;
  description?: string;
}

export async function getTemplates(
  projectId?: string,
  type?: string,
): Promise<Template[]> {
  const params = new URLSearchParams();
  if (projectId) params.set("project_id", projectId);
  if (type) params.set("template_type", type);
  const query = params.toString();
  return apiFetch<Template[]>(`/templates${query ? `?${query}` : ""}`);
}

export async function createTemplate(
  data: CreateTemplateData,
): Promise<Template> {
  return apiFetch<Template>("/templates", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateTemplate(
  id: string,
  data: UpdateTemplateData,
): Promise<Template> {
  return apiFetch<Template>(`/templates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteTemplate(id: string): Promise<Template> {
  return apiFetch<Template>(`/templates/${id}`, {
    method: "DELETE",
  });
}

export async function instantiateTemplate(
  id: string,
  data: InstantiateTemplateData,
): Promise<unknown> {
  return apiFetch<unknown>(`/templates/${id}/instantiate`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function createTemplateFromTask(
  taskId: string,
  data: CreateTemplateFromTaskData,
): Promise<Template> {
  return apiFetch<Template>(`/tasks/${taskId}/create-template`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// ---- Agent Pool API ----

export interface AgentPoolInfo {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export interface AgentPoolSummary extends AgentPoolInfo {
  agentCount: number;
  claimedCount: number;
  availableCount: number;
}

export interface PoolAgentStatus {
  user: {
    id: string;
    username: string;
    displayName: string;
    type: string;
    isActive: boolean;
    poolId: string | null;
  };
  claimed: boolean;
  claimedAt: string | null;
  expiresAt: string | null;
  heartbeatAt: string | null;
}

export interface PoolDetailResponse {
  pool: AgentPoolInfo;
  agents: PoolAgentStatus[];
}

export interface PoolAgent {
  id: string;
  username: string;
  displayName: string;
  role: string;
  type: string;
  poolId: string;
}

export async function listAgentPools(): Promise<AgentPoolSummary[]> {
  return apiFetch<AgentPoolSummary[]>("/auth/agent-pools");
}

export async function getAgentPool(poolId: string): Promise<PoolDetailResponse> {
  return apiFetch<PoolDetailResponse>(`/auth/agent-pools/${poolId}`);
}

export async function createAgentPool(
  name: string,
  secret: string,
  description?: string,
): Promise<AgentPoolInfo> {
  return apiFetch<AgentPoolInfo>("/auth/agent-pools", {
    method: "POST",
    body: JSON.stringify({ name, secret, ...(description ? { description } : {}) }),
  });
}

export async function updateAgentPool(
  poolId: string,
  data: { name?: string; description?: string },
): Promise<AgentPoolInfo> {
  return apiFetch<AgentPoolInfo>(`/auth/agent-pools/${poolId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteAgentPool(poolId: string): Promise<void> {
  await apiFetch<{ message: string }>(`/auth/agent-pools/${poolId}`, {
    method: "DELETE",
  });
}

export async function updateAgentPoolSecret(
  poolId: string,
  secret: string,
): Promise<void> {
  await apiFetch<{ message: string }>(`/auth/agent-pools/${poolId}/secret`, {
    method: "POST",
    body: JSON.stringify({ secret }),
  });
}

export async function createPoolAgents(
  poolId: string,
  count: number,
  namePrefix?: string,
): Promise<PoolAgent[]> {
  return apiFetch<PoolAgent[]>(`/auth/agent-pools/${poolId}/agents`, {
    method: "POST",
    body: JSON.stringify({ count, ...(namePrefix ? { namePrefix } : {}) }),
  });
}

export async function forceReleaseAgent(userId: string): Promise<void> {
  await apiFetch<{ message: string }>(`/auth/agent-pool/force-release`, {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
}

// ---- Automation Rules API ----

export interface AutomationCondition {
  field: string;
  operator: "eq" | "neq" | "in" | "not_in" | "contains";
  value: unknown;
}

export interface AutomationRule {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  triggerEvent: string;
  conditions: AutomationCondition[] | null;
  actionType: string;
  actionConfig: Record<string, unknown> | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export interface CreateAutomationRuleData {
  name: string;
  description?: string | null;
  triggerEvent: string;
  conditions?: AutomationCondition[] | null;
  actionType: string;
  actionConfig?: Record<string, unknown> | null;
  isActive?: boolean;
}

export interface UpdateAutomationRuleData {
  name?: string;
  description?: string | null;
  triggerEvent?: string;
  conditions?: AutomationCondition[] | null;
  actionType?: string;
  actionConfig?: Record<string, unknown> | null;
  isActive?: boolean;
}

export async function getAutomationRules(
  projectId: string,
): Promise<AutomationRule[]> {
  return apiFetch<AutomationRule[]>(
    `/projects/${projectId}/automation-rules`,
  );
}

export async function createAutomationRule(
  projectId: string,
  data: CreateAutomationRuleData,
): Promise<AutomationRule> {
  return apiFetch<AutomationRule>(
    `/projects/${projectId}/automation-rules`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
}

export async function updateAutomationRule(
  id: string,
  data: UpdateAutomationRuleData,
): Promise<AutomationRule> {
  return apiFetch<AutomationRule>(`/automation-rules/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteAutomationRule(
  id: string,
): Promise<{ deleted: boolean }> {
  return apiFetch<{ deleted: boolean }>(`/automation-rules/${id}`, {
    method: "DELETE",
  });
}

export async function toggleAutomationRule(
  id: string,
  active: boolean,
): Promise<AutomationRule> {
  return apiFetch<AutomationRule>(`/automation-rules/${id}/toggle`, {
    method: "POST",
    body: JSON.stringify({ active }),
  });
}
