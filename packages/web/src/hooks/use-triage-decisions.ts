import { useQuery } from "@tanstack/react-query";
import { getTriageDecisions, getTriageMetrics, type TriageDecisionFilters } from "@/lib/api";

// ─── Triage-decision query keys (T3) ──────────────────────────────
// The append-only auto-decision side-log, read per-note for the audit feed.
// The `metrics` key lives UNDER triageDecisionKeys.all so the shipped useSSE
// triage_decision.* invalidation (→ triageDecisionKeys.all) refreshes the
// dashboard live.
export const triageDecisionKeys = {
  all: ["triage-decisions"] as const,
  lists: () => [...triageDecisionKeys.all, "list"] as const,
  list: (projectId: string, filters?: TriageDecisionFilters) =>
    [...triageDecisionKeys.lists(), { projectId, ...filters }] as const,
  byNote: (projectId: string, noteId: string) =>
    [...triageDecisionKeys.lists(), { projectId, noteId }] as const,
  metrics: (projectId: string, opts?: { since?: string }) =>
    [...triageDecisionKeys.all, "metrics", projectId, { ...opts }] as const,
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

/**
 * Read a project's on-read triage metric bundle (T3·P3 dashboard). The key
 * lives under triageDecisionKeys.all, so the shipped useSSE triage_decision.*
 * invalidation refreshes it live; a 30s poll floor keeps last-decision
 * freshness advancing between SSE pushes.
 */
export function useTriageMetrics(projectId: string | undefined, since?: string) {
  return useQuery({
    queryKey: triageDecisionKeys.metrics(projectId!, { since }),
    queryFn: () => getTriageMetrics(projectId!, since),
    enabled: !!projectId,
    refetchInterval: 30_000,
  });
}
