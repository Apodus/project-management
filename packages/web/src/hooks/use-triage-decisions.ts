import { useQuery } from "@tanstack/react-query";
import { getTriageDecisions, type TriageDecisionFilters } from "@/lib/api";

// ─── Triage-decision query keys (T3) ──────────────────────────────
// The append-only auto-decision side-log, read per-note for the audit feed.
export const triageDecisionKeys = {
  all: ["triage-decisions"] as const,
  lists: () => [...triageDecisionKeys.all, "list"] as const,
  list: (projectId: string, filters?: TriageDecisionFilters) =>
    [...triageDecisionKeys.lists(), { projectId, ...filters }] as const,
  byNote: (projectId: string, noteId: string) =>
    [...triageDecisionKeys.lists(), { projectId, noteId }] as const,
};

/**
 * Read a project's triage decisions (optionally filtered to one note). The
 * caller gates fetching via `enabled` (default true) so the per-note audit feed
 * only fires when its detail dialog is open — never N requests across cards.
 */
export function useTriageDecisions(
  projectId: string | undefined,
  filters?: TriageDecisionFilters,
  options?: { enabled?: boolean },
) {
  const enabled = (options?.enabled ?? true) && !!projectId;
  return useQuery({
    queryKey: triageDecisionKeys.list(projectId!, filters),
    queryFn: () => getTriageDecisions(projectId!, filters),
    enabled,
  });
}
