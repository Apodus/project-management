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
