import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getProjectClaims,
  releaseClaim,
  releaseClaimTo,
  requestClaimTakeover,
  type ClaimEntityType,
} from "@/lib/api";
import { taskKeys } from "./use-tasks";
import { epicKeys } from "./use-epics";
import { proposalKeys } from "./use-proposals";

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

// ─── Handoff mutations (Campaign C3 — release-to / request-takeover) ──

// The entity family whose lists/details must refresh after a holder change.
const ENTITY_KEYS: Record<ClaimEntityType, readonly unknown[]> = {
  task: taskKeys.all,
  epic: epicKeys.all,
  proposal: proposalKeys.all,
};

/**
 * Hand a claim to a named worker. Result-driven toast: `force_claimed` is the
 * only success shape release-to returns.
 */
export function useReleaseClaimTo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      entityType,
      id,
      reason,
      targetId,
    }: {
      entityType: ClaimEntityType;
      id: string;
      reason: string;
      targetId: string;
    }) => releaseClaimTo(entityType, id, { reason, targetId }),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: claimKeys.all });
      queryClient.invalidateQueries({
        queryKey: ENTITY_KEYS[variables.entityType],
      });
      toast.success("Claim transferred");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

/**
 * Plainly release a claim (clear the holder + tear down the lease). The
 * operator action for a dead/abandoned claim. Result-driven toast: `released`
 * confirms the clear; `not_held` means it was already free.
 */
export function useReleaseClaim() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ entityType, id }: { entityType: ClaimEntityType; id: string }) =>
      releaseClaim(entityType, id),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: claimKeys.all });
      queryClient.invalidateQueries({
        queryKey: ENTITY_KEYS[variables.entityType],
      });
      if (result.status === "released") {
        toast.success("Claim released");
      } else {
        toast.info("This item was already unclaimed");
      }
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

/**
 * Ask to take over a claim, stomp-safely. Result-driven toasts:
 *   - `force_claimed` → the stale claim was auto-granted ("Claim transferred")
 *   - `notified_holder` → the claim is LIVE; nothing was mutated — the holder
 *     was only notified (the cardinal invariant, surfaced verbatim)
 *   - `already_claimed_by_you` / `not_held` → informational no-ops.
 */
export function useRequestClaimTakeover() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      entityType,
      id,
      reason,
    }: {
      entityType: ClaimEntityType;
      id: string;
      reason: string;
    }) => requestClaimTakeover(entityType, id, { reason }),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: claimKeys.all });
      queryClient.invalidateQueries({
        queryKey: ENTITY_KEYS[variables.entityType],
      });
      if (result.status === "force_claimed") {
        toast.success("Claim transferred", {
          description: "The stale claim was granted to you.",
        });
      } else if (result.status === "notified_holder") {
        toast.info("Holder notified — live claims are never taken over; the claim was not changed");
      } else if (result.status === "already_claimed_by_you") {
        toast.info("You already hold this claim");
      } else if (result.status === "not_held") {
        toast.info("This item is unclaimed — claim it directly instead");
      }
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}
