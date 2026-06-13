import type { components, paths } from "./api-types";

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
export type TrainMetrics = components["schemas"]["TrainMetrics"];
export type TrainInFlight = components["schemas"]["TrainInFlight"];
export type IntegratorHealth = components["schemas"]["IntegratorHealth"];
export type TrainState = components["schemas"]["TrainState"];
export type ClaimsHealth = components["schemas"]["ClaimsHealth"];
export type ProjectClaims = components["schemas"]["ProjectClaims"];
export type ClaimItem = ProjectClaims["items"][number];
export type MergeRequest = components["schemas"]["MergeRequest"];
export type MergeRequestTimeline = components["schemas"]["MergeRequestTimeline"];
export type MergeRequestTimelineEvent = components["schemas"]["MergeRequestTimelineEvent"];
export type ResolverDefaults = components["schemas"]["ResolverDefaults"];
export type Note = components["schemas"]["Note"];
export type NotesHealth = components["schemas"]["NotesHealth"];
export type CreateNote = components["schemas"]["CreateNote"];
export type PatchNote = components["schemas"]["PatchNote"];
export type PromotedProposal = components["schemas"]["PromotedProposal"];
export type PromotedTask = components["schemas"]["PromotedTask"];
export type Escalation = components["schemas"]["Escalation"];
export type EscalationMessage = components["schemas"]["EscalationMessage"];
export type EscalationWithThread = components["schemas"]["EscalationWithThread"];

/**
 * The persisted `settings.integrator.resolver` shape (Phase 7.6). `command` is
 * NOT surfaced in the UI but is preserved on round-trip. An absent
 * `token_budget` means unlimited; an absent `prompt` means the built-in default.
 */
export interface ResolverConfig {
  enabled: boolean;
  max_concurrent: number;
  time_budget_sec: number;
  token_budget?: number;
  command?: string;
  prompt?: string;
}

export interface LinkedRepo {
  name: string;
  path: string;
  role: "inner" | "outer";
  gitlink_parent?: string;
  gitlink_path?: string;
}

// The integrator config fields the admin UI edits. Every OTHER settings.integrator
// field (verify_steps, cache_*, heartbeat_interval_sec, slo, worktree_name, resolver)
// is preserved opaquely by useUpdateIntegratorConfig's merge and is intentionally NOT
// here — so a save can never reset a field the form doesn't show. Defaulted fields
// carry the schema defaults; verify_command/worktree_root stay absent when the server
// omitted them.
export interface IntegratorConfig {
  enabled: boolean;
  verify_timeout_sec: number;
  git_remote: string;
  git_main_branch: string;
  parallelism: number;
  linked_repos: LinkedRepo[];
  clean_keep: string[];
  verify_command?: string;
  worktree_root?: string;
}

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

export async function getProjects(status?: string): Promise<Project[]> {
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

export async function updateProject(id: string, data: UpdateProject): Promise<Project> {
  return apiFetch<Project>(`/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function getProjectStats(id: string): Promise<ProjectStats> {
  return apiFetch<ProjectStats>(`/projects/${id}/stats`);
}

// Built-in resolver defaults (Phase 7.6). Static — sources the default reconcile
// prompt + the "revert to defaults" values. Any authenticated user.
export async function getResolverDefaults(): Promise<ResolverDefaults> {
  return apiFetch<ResolverDefaults>("/resolver/defaults");
}

// ---- Proposal API ----

export async function getProposals(projectId: string, status?: string): Promise<Proposal[]> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  const query = params.toString();
  return apiFetch<Proposal[]>(`/projects/${projectId}/proposals${query ? `?${query}` : ""}`);
}

export async function createProposal(projectId: string, data: CreateProposal): Promise<Proposal> {
  return apiFetch<Proposal>(`/projects/${projectId}/proposals`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getProposal(id: string): Promise<ProposalDetail> {
  return apiFetch<ProposalDetail>(`/proposals/${id}`);
}

export async function updateProposal(id: string, data: UpdateProposal): Promise<Proposal> {
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
      body,
      ...(type ? { commentType: type } : {}),
    }),
  });
}

export async function getProposalWorkItems(
  id: string,
): Promise<{ epics: ProposalEpic[]; tasks: ProposalTask[] }> {
  return apiFetch<{ epics: ProposalEpic[]; tasks: ProposalTask[] }>(`/proposals/${id}/work-items`);
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

export async function getTasks(projectId: string, filters?: TaskFilters): Promise<PaginatedTasks> {
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
  return apiFetch<PaginatedTasks>(`/projects/${projectId}/tasks${query ? `?${query}` : ""}`, {
    rawResponse: true,
  });
}

export async function getTask(id: string): Promise<Task> {
  return apiFetch<Task>(`/tasks/${id}`);
}

export async function updateTask(id: string, data: UpdateTask): Promise<Task> {
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

// ---- Notes API ----

// The list envelope is an inline server shape (not a named schema), so type it
// locally — mirrors how getTasks types its {data,pagination}.
export interface NoteListResult {
  data: Note[];
  pagination: { total: number };
}

// POST /notes returns the created note plus advisory `similar` open-note candidates.
export interface CreateNoteResult {
  data: Note;
  similar: { id: string; title: string; kind: Note["kind"] }[];
}

export interface PromoteToProposalResult {
  data: Note;
  proposal: PromotedProposal;
}

export interface PromoteToTaskResult {
  data: Note;
  task: PromotedTask;
}

export interface NoteFilters {
  status?: Note["status"];
  kind?: Note["kind"];
  anchorType?: Note["anchorType"];
  anchorId?: string;
  severity?: Note["severity"];
}

export async function getNotes(
  projectId: string,
  filters?: NoteFilters,
): Promise<NoteListResult> {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.kind) params.set("kind", filters.kind);
  if (filters?.anchorType) params.set("anchorType", filters.anchorType);
  if (filters?.anchorId) params.set("anchorId", filters.anchorId);
  if (filters?.severity) params.set("severity", filters.severity);
  const query = params.toString();
  return apiFetch<NoteListResult>(
    `/projects/${projectId}/notes${query ? `?${query}` : ""}`,
    { rawResponse: true },
  );
}

export async function getNote(id: string): Promise<Note> {
  return apiFetch<Note>(`/notes/${id}`);
}

export async function getNotesHealth(projectId: string): Promise<NotesHealth> {
  return apiFetch<NotesHealth>(`/projects/${projectId}/notes/health`);
}

export async function createNote(
  projectId: string,
  data: CreateNote,
): Promise<CreateNoteResult> {
  return apiFetch<CreateNoteResult>(`/projects/${projectId}/notes`, {
    method: "POST",
    body: JSON.stringify(data),
    rawResponse: true,
  });
}

export async function updateNote(id: string, data: PatchNote): Promise<Note> {
  return apiFetch<Note>(`/notes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function dismissNote(id: string, reason: string): Promise<Note> {
  return apiFetch<Note>(`/notes/${id}/dismiss`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export async function promoteNoteToProposal(
  id: string,
  body?: { title?: string; description?: string },
): Promise<PromoteToProposalResult> {
  return apiFetch<PromoteToProposalResult>(`/notes/${id}/promote-to-proposal`, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
    rawResponse: true,
  });
}

export async function promoteNoteToTask(
  id: string,
  body?: { title?: string; description?: string; epicId?: string },
): Promise<PromoteToTaskResult> {
  return apiFetch<PromoteToTaskResult>(`/notes/${id}/promote-to-task`, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
    rawResponse: true,
  });
}

// ---- Escalations API (Campaign C4 — agent escalation channel, read-only web) ----

// The list envelope is an inline server shape (not a named schema), so type it
// locally — mirrors how getNotes types its {data,pagination}.
export interface EscalationListResult {
  data: Escalation[];
  pagination: { total: number };
}

export interface EscalationFilters {
  status?: Escalation["status"];
  kind?: Escalation["kind"];
  severity?: NonNullable<Escalation["severity"]>;
  originRepo?: string;
  originWorkerKey?: string;
  holderId?: string;
}

export async function getEscalations(
  projectId: string,
  filters?: EscalationFilters,
): Promise<EscalationListResult> {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.kind) params.set("kind", filters.kind);
  if (filters?.severity) params.set("severity", filters.severity);
  if (filters?.originRepo) params.set("originRepo", filters.originRepo);
  if (filters?.originWorkerKey) params.set("originWorkerKey", filters.originWorkerKey);
  if (filters?.holderId) params.set("holderId", filters.holderId);
  const query = params.toString();
  return apiFetch<EscalationListResult>(
    `/projects/${projectId}/escalations${query ? `?${query}` : ""}`,
    { rawResponse: true },
  );
}

export async function getEscalation(id: string): Promise<EscalationWithThread> {
  return apiFetch<EscalationWithThread>(`/escalations/${id}`);
}

// On-read escalation metrics (Campaign C4 §P2). Default apiFetch unwraps the
// {data} envelope — mirrors getTrainMetrics (NOT rawResponse).
export type EscalationMetrics = components["schemas"]["EscalationMetrics"];

export async function getEscalationMetrics(
  projectId: string,
): Promise<EscalationMetrics> {
  return apiFetch<EscalationMetrics>(`/projects/${projectId}/escalations/metrics`);
}

// ---- Search API (Campaign C4) ----

export type SearchResult = components["schemas"]["SearchResult"];

export interface SearchOptions {
  projectId?: string;
  entityType?: "proposal" | "task" | "comment" | "note";
  limit?: number;
}

/**
 * Server FTS5 search over GET /search. Appends a trailing `*` to the FINAL
 * token (type-ahead prefix match — the server's quoteFtsToken preserves a
 * trailing wildcard). Returns rank-ordered hits (best first).
 *
 * `limit` is passed EXPLICITLY, defaulting to 100 (the route's own default is
 * 20 — without the explicit param a documented "100-hit cap" would be a lie).
 */
export async function search(
  q: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const prefixed = trimmed.endsWith("*") ? trimmed : `${trimmed}*`;
  const params = new URLSearchParams({ q: prefixed });
  if (options?.projectId) params.set("project_id", options.projectId);
  if (options?.entityType) params.set("entity_type", options.entityType);
  params.set("limit", String(options?.limit ?? 100));
  return apiFetch<SearchResult[]>(`/search?${params.toString()}`);
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
  return apiFetch<PaginatedActivity>(`/projects/${projectId}/activity${query ? `?${query}` : ""}`, {
    rawResponse: true,
  });
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
  return apiFetch<PaginatedActivity>(`/tasks/${taskId}/activity${query ? `?${query}` : ""}`, {
    rawResponse: true,
  });
}

// ---- Epic API ----

export interface EpicFilters {
  status?: string;
  milestone?: string;
  claim?: "available" | "mine" | "all";
}

export interface EpicClaimResult {
  ok: boolean;
  status:
    | "claimed_by_you"
    | "already_claimed_by_you"
    | "claimed_by_another_agent"
    | "released"
    | "not_held"
    | "closed";
}

export async function getEpics(projectId: string, filters?: EpicFilters): Promise<Epic[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.milestone) params.set("milestone", filters.milestone);
  if (filters?.claim) params.set("claim", filters.claim);
  const query = params.toString();
  return apiFetch<Epic[]>(`/projects/${projectId}/epics${query ? `?${query}` : ""}`);
}

export async function getEpic(id: string): Promise<Epic> {
  return apiFetch<Epic>(`/epics/${id}`);
}

export async function updateEpic(id: string, data: UpdateEpic): Promise<Epic> {
  return apiFetch<Epic>(`/epics/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export type EpicGraph = components["schemas"]["EpicGraph"];
export type EpicGraphNode = components["schemas"]["EpicGraphNode"];
export type EpicGraphEdge = components["schemas"]["EpicGraphEdge"];

export async function getEpicGraph(projectId: string): Promise<EpicGraph> {
  return apiFetch<EpicGraph>(`/projects/${projectId}/epic-graph`);
}

export type TaskGraph = components["schemas"]["TaskGraph"];
export type TaskGraphNode = components["schemas"]["TaskGraphNode"];
export type TaskGraphEdge = components["schemas"]["TaskGraphEdge"];

export async function getTaskGraph(projectId: string, epicId: string): Promise<TaskGraph> {
  return apiFetch<TaskGraph>(`/projects/${projectId}/epics/${epicId}/task-graph`);
}

export async function claimEpic(id: string): Promise<EpicClaimResult> {
  return apiFetch<EpicClaimResult>(`/epics/${id}/claim`, {
    method: "POST",
  });
}

export async function releaseEpic(id: string): Promise<EpicClaimResult> {
  return apiFetch<EpicClaimResult>(`/epics/${id}/release`, {
    method: "POST",
  });
}

// ---- Milestone API ----

export type Milestone = components["schemas"]["Milestone"];
export type CreateMilestone = components["schemas"]["CreateMilestone"];
export type UpdateMilestone = components["schemas"]["UpdateMilestone"];

export async function getMilestones(projectId: string): Promise<Milestone[]> {
  return apiFetch<Milestone[]>(`/projects/${projectId}/milestones`);
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

export async function updateMilestone(id: string, data: UpdateMilestone): Promise<Milestone> {
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

export async function exportProject(projectId: string, includeActivity?: boolean): Promise<Blob> {
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

export async function updateUser(id: string, data: UpdateUserData): Promise<AuthUser> {
  return apiFetch<AuthUser>(`/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function rotateToken(id: string): Promise<{ apiToken: string }> {
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

export async function getTemplates(projectId?: string, type?: string): Promise<Template[]> {
  const params = new URLSearchParams();
  if (projectId) params.set("project_id", projectId);
  if (type) params.set("template_type", type);
  const query = params.toString();
  return apiFetch<Template[]>(`/templates${query ? `?${query}` : ""}`);
}

export async function createTemplate(data: CreateTemplateData): Promise<Template> {
  return apiFetch<Template>("/templates", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateTemplate(id: string, data: UpdateTemplateData): Promise<Template> {
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

export async function updateAgentPoolSecret(poolId: string, secret: string): Promise<void> {
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

export interface RemoveAgentResult {
  deleted: boolean;
  deactivated: boolean;
  reason?: string;
}

export async function removeAgentFromPool(
  poolId: string,
  userId: string,
): Promise<RemoveAgentResult> {
  return apiFetch<RemoveAgentResult>(`/auth/agent-pools/${poolId}/agents/${userId}`, {
    method: "DELETE",
  });
}

export async function forceReleaseAgent(userId: string): Promise<void> {
  await apiFetch<{ message: string }>(`/auth/agent-pool/force-release`, {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
}

// ---- Merge Train API (read-only observability) ----

export async function getTrainState(projectId: string): Promise<TrainState> {
  return apiFetch<TrainState>(`/projects/${projectId}/train/state`);
}

export async function getTrainMetrics(projectId: string, resource?: string): Promise<TrainMetrics> {
  const params = new URLSearchParams();
  if (resource) params.set("resource", resource);
  const query = params.toString();
  return apiFetch<TrainMetrics>(`/projects/${projectId}/train/metrics${query ? `?${query}` : ""}`);
}

/**
 * Stale-claim health for a project (Campaign C3 §P5a). Reading this fires the
 * edge-triggered claim.stale_alert once per stale episode (SSE banner +
 * Discord) — so the always-open app-layout poll keeps the alert live.
 * Identity-masked: no holder id is surfaced.
 */
export async function getClaimsHealth(projectId: string): Promise<ClaimsHealth> {
  return apiFetch<ClaimsHealth>(`/projects/${projectId}/claims-health`);
}

/**
 * Every ACTIVE claim in the project (tasks/epics/proposals with a holder and a
 * non-terminal status), each with its identity-masked claim_state relative to
 * the caller, the resolved holder {id, name, type}, and the nullable
 * lease-layer claimedAt (null for legacy pre-C2 claims). Pure read — no alert
 * side effect (that belongs to getClaimsHealth).
 */
export async function getProjectClaims(projectId: string): Promise<ProjectClaims> {
  return apiFetch<ProjectClaims>(`/projects/${projectId}/claims`);
}

// ---- Claim handoff API (Campaign C3 — release-to / request-takeover) ----

export type ClaimEntityType = ClaimItem["entityType"];

// Typed against the generated paths so api-types drift breaks the build. The
// three entity families share identical request/response shapes — the task
// path is the canonical source.
export type ReleaseClaimToResult =
  paths["/api/v1/tasks/{id}/release-to"]["post"]["responses"][200]["content"]["application/json"]["data"];
export type RequestClaimTakeoverResult =
  paths["/api/v1/tasks/{id}/request-takeover"]["post"]["responses"][200]["content"]["application/json"]["data"];

const CLAIM_ENTITY_SEGMENT: Record<ClaimEntityType, "tasks" | "epics" | "proposals"> = {
  task: "tasks",
  epic: "epics",
  proposal: "proposals",
};

/**
 * Hand a claim to a NAMED worker (reason required, audited). The current
 * holder, or any human, may release. Never stomps a live claim — it transfers
 * the holder's own claim.
 */
export async function releaseClaimTo(
  entityType: ClaimEntityType,
  id: string,
  body: { reason: string; targetId: string },
): Promise<ReleaseClaimToResult> {
  return apiFetch<ReleaseClaimToResult>(
    `/${CLAIM_ENTITY_SEGMENT[entityType]}/${id}/release-to`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/**
 * Ask to take over a claim, stomp-safely: a STALE (lease-lapsed) claim is
 * auto-granted to the caller (`force_claimed`); a LIVE claim is NEVER mutated —
 * the holder is notified and the result is `notified_holder`.
 */
export async function requestClaimTakeover(
  entityType: ClaimEntityType,
  id: string,
  body: { reason: string },
): Promise<RequestClaimTakeoverResult> {
  return apiFetch<RequestClaimTakeoverResult>(
    `/${CLAIM_ENTITY_SEGMENT[entityType]}/${id}/request-takeover`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function getTrainInFlight(
  projectId: string,
  resource?: string,
): Promise<TrainInFlight> {
  const params = new URLSearchParams();
  if (resource) params.set("resource", resource);
  const query = params.toString();
  return apiFetch<TrainInFlight>(
    `/projects/${projectId}/train/in-flight${query ? `?${query}` : ""}`,
  );
}

export async function getIntegratorHealth(
  projectId: string,
  resource?: string,
): Promise<IntegratorHealth> {
  const params = new URLSearchParams();
  if (resource) params.set("resource", resource);
  const query = params.toString();
  return apiFetch<IntegratorHealth>(
    `/projects/${projectId}/integrator/health${query ? `?${query}` : ""}`,
  );
}

export async function getMergeRequestTimeline(id: string): Promise<MergeRequestTimeline> {
  return apiFetch<MergeRequestTimeline>(`/merge-requests/${id}/timeline`);
}

// ---- Break-glass / Audit API (admin R1-override surface) ----

export type AuditLogEntry = components["schemas"]["AuditLogEntry"];
export type ForceMergeRequest = components["schemas"]["ForceMergeRequest"];
export type ForceReleaseResult = components["schemas"]["ForceReleaseResult"];
export type ForceLand = components["schemas"]["ForceLand"];
export type ForceReject = components["schemas"]["ForceReject"];

export interface AuditFilters {
  userId?: string;
  action?: AuditLogEntry["action"];
  targetType?: AuditLogEntry["targetType"];
  targetId?: string;
  from?: string;
  to?: string;
  page?: number;
  perPage?: number;
}

export interface PaginatedAudit {
  data: AuditLogEntry[];
  pagination: {
    total: number;
    page: number;
    perPage: number;
  };
}

export async function getAuditLog(
  projectId: string,
  filters?: AuditFilters,
): Promise<PaginatedAudit> {
  const params = new URLSearchParams();
  if (filters?.userId) params.set("userId", filters.userId);
  if (filters?.action) params.set("action", filters.action);
  if (filters?.targetType) params.set("targetType", filters.targetType);
  if (filters?.targetId) params.set("targetId", filters.targetId);
  if (filters?.from) params.set("from", filters.from);
  if (filters?.to) params.set("to", filters.to);
  if (filters?.page) params.set("page", String(filters.page));
  if (filters?.perPage) params.set("perPage", String(filters.perPage));
  const query = params.toString();
  return apiFetch<PaginatedAudit>(`/projects/${projectId}/audit-log${query ? `?${query}` : ""}`, {
    rawResponse: true,
  });
}

export async function pauseTrain(
  projectId: string,
  body?: { resource?: string; reason?: string | null },
): Promise<TrainState> {
  return apiFetch<TrainState>(`/projects/${projectId}/train/pause`, {
    method: "POST",
    body: JSON.stringify({ resource: "main", ...body }),
  });
}

export async function resumeTrain(
  projectId: string,
  body?: { resource?: string; reason?: string | null },
): Promise<TrainState> {
  return apiFetch<TrainState>(`/projects/${projectId}/train/resume`, {
    method: "POST",
    body: JSON.stringify({ resource: "main", ...body }),
  });
}

export async function forceReleaseLock(
  projectId: string,
  resource: string,
  body?: { reason?: string | null },
): Promise<ForceReleaseResult> {
  return apiFetch<ForceReleaseResult>(
    `/projects/${projectId}/merge-locks/${resource}/force-release`,
    {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    },
  );
}

export async function getMergeRequests(
  projectId: string,
  params?: { resource?: string; status?: string },
): Promise<MergeRequest[]> {
  const qs = new URLSearchParams();
  if (params?.resource) qs.set("resource", params.resource);
  if (params?.status) qs.set("status", params.status);
  const query = qs.toString();
  return apiFetch<MergeRequest[]>(
    `/projects/${projectId}/merge-requests${query ? `?${query}` : ""}`,
  );
}

export async function forceLand(
  requestId: string,
  body: { landedSha: string; reason: string },
): Promise<ForceMergeRequest> {
  return apiFetch<ForceMergeRequest>(`/merge-requests/${requestId}/force-land`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function forceReject(
  requestId: string,
  body: { reason: string },
): Promise<ForceMergeRequest> {
  return apiFetch<ForceMergeRequest>(`/merge-requests/${requestId}/force-reject`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function forceCancel(
  requestId: string,
  body: { reason: string },
): Promise<ForceMergeRequest> {
  return apiFetch<ForceMergeRequest>(`/merge-requests/${requestId}/force-cancel`, {
    method: "POST",
    body: JSON.stringify(body),
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

export async function getAutomationRules(projectId: string): Promise<AutomationRule[]> {
  return apiFetch<AutomationRule[]>(`/projects/${projectId}/automation-rules`);
}

export async function createAutomationRule(
  projectId: string,
  data: CreateAutomationRuleData,
): Promise<AutomationRule> {
  return apiFetch<AutomationRule>(`/projects/${projectId}/automation-rules`, {
    method: "POST",
    body: JSON.stringify(data),
  });
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

export async function deleteAutomationRule(id: string): Promise<{ deleted: boolean }> {
  return apiFetch<{ deleted: boolean }>(`/automation-rules/${id}`, {
    method: "DELETE",
  });
}

export async function toggleAutomationRule(id: string, active: boolean): Promise<AutomationRule> {
  return apiFetch<AutomationRule>(`/automation-rules/${id}/toggle`, {
    method: "POST",
    body: JSON.stringify({ active }),
  });
}
