import { useQuery } from "@tanstack/react-query";
import { getProjectClaims } from "@/lib/api";

// ─── Query keys (Campaign C3 — claims operations surface) ─────────

export const claimKeys = {
  all: ["claims"] as const,
  list: (projectId: string) => [...claimKeys.all, "list", projectId] as const,
};

/**
 * The claims-panel aggregate: every active claim in the project with its
 * identity-masked claim_state, resolved holder, and lease-layer claimedAt.
 *
 * Polls every 30s (liveness derives from the clock, so a stale flip can happen
 * without any entity write); task/epic/proposal SSE events also invalidate
 * claimKeys.all (use-sse.ts) so claim/release/handoff changes land live.
 */
export function useProjectClaims(projectId: string | undefined) {
  return useQuery({
    queryKey: claimKeys.list(projectId!),
    queryFn: () => getProjectClaims(projectId!),
    enabled: !!projectId,
    refetchInterval: 30_000,
  });
}
