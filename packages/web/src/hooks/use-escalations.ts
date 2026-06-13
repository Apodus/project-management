import { useQuery } from "@tanstack/react-query";
import {
  getEscalations,
  getEscalation,
  getEscalationMetrics,
  getMergeRequests,
  type EscalationFilters,
} from "@/lib/api";

// ─── Query keys (Campaign C4 — agent escalation channel, read-only web) ───
//
// Mirrors noteKeys: `all` is the prefix of lists()/detail(), so a single
// `escalationKeys.all` invalidation refreshes the dashboard list and any open
// escalation timeline together (used by the SSE escalation.* invalidation map).

export const escalationKeys = {
  all: ["escalations"] as const,
  lists: () => [...escalationKeys.all, "list"] as const,
  list: (projectId: string, filters?: EscalationFilters) =>
    [...escalationKeys.lists(), { projectId, ...filters }] as const,
  details: () => [...escalationKeys.all, "detail"] as const,
  detail: (id: string) => [...escalationKeys.details(), id] as const,
  // Under escalationKeys.all so the escalation.* SSE invalidation refreshes
  // the metrics panel along with the list + any open timeline.
  metrics: (projectId: string) =>
    [...escalationKeys.all, "metrics", projectId] as const,
};

export function useEscalations(
  projectId: string | undefined,
  filters?: EscalationFilters,
) {
  return useQuery({
    queryKey: escalationKeys.list(projectId!, filters),
    queryFn: () => getEscalations(projectId!, filters),
    enabled: !!projectId,
  });
}

export function useEscalation(escalationId: string | undefined) {
  return useQuery({
    queryKey: escalationKeys.detail(escalationId!),
    queryFn: () => getEscalation(escalationId!),
    enabled: !!escalationId,
  });
}

export function useEscalationMetrics(projectId: string | undefined) {
  return useQuery({
    queryKey: escalationKeys.metrics(projectId!),
    queryFn: () => getEscalationMetrics(projectId!),
    enabled: !!projectId,
    // Poll floor so the panel stays live between SSE pushes (mirrors
    // useTrainMetrics).
    refetchInterval: 10_000,
  });
}

// The escalation-linked merge requests powering the A5 audit-chain card on the
// timeline page. Keyed UNDER escalationKeys.detail(id) (a `["merge-requests"]`
// suffix) so the existing escalation.* SSE invalidation — which targets
// escalationKeys.all / detail(id) — refreshes the MR rows along with the thread.
// `projectId` is derived from the loaded escalation.projectId (the MR route is
// project-scoped); the enabled gate keeps it from firing for an escalation that
// has not loaded yet.
export function useEscalationMergeRequests(
  projectId: string | undefined,
  escalationId: string | undefined,
) {
  return useQuery({
    queryKey: [...escalationKeys.detail(escalationId!), "merge-requests"] as const,
    queryFn: () => getMergeRequests(projectId!, { escalationId: escalationId! }),
    enabled: !!projectId && !!escalationId,
  });
}
