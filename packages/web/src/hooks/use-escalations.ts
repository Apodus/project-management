import { useQuery } from "@tanstack/react-query";
import {
  getEscalations,
  getEscalation,
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
