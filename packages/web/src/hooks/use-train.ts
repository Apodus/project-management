import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getTrainMetrics,
  getTrainInFlight,
  getIntegratorHealth,
  getClaimsHealth,
  getTrainState,
  getMergeRequestTimeline,
  getMergeRequestPhases,
  getTrainTrace,
  getAuditLog,
  pauseTrain,
  resumeTrain,
  forceReleaseLock,
  forceLand,
  forceReject,
  forceCancel,
  getMergeRequests,
  type AuditFilters,
} from "@/lib/api";

const TRAIN_ROOT = ["train"] as const;

export const trainKeys = {
  all: TRAIN_ROOT,
  // The three FAMILY prefixes a phase-boundary event invalidates (§P5). Named
  // constants rather than `[...all, "metrics"]` spelled at each call site: a
  // prefix key that drifts from the key it is meant to prefix invalidates
  // nothing, silently.
  metricsAll: [...TRAIN_ROOT, "metrics"] as const,
  phasesAll: [...TRAIN_ROOT, "phases"] as const,
  traceAll: [...TRAIN_ROOT, "trace"] as const,
  metrics: (projectId: string, resource?: string) =>
    [...trainKeys.metricsAll, projectId, { resource }] as const,
  inFlight: (projectId: string, resource?: string) =>
    [...trainKeys.all, "in-flight", projectId, { resource }] as const,
  health: (projectId: string, resource?: string) =>
    [...trainKeys.all, "health", projectId, { resource }] as const,
  state: (projectId: string) => [...trainKeys.all, "state", projectId] as const,
  claimsHealth: (projectId: string) => [...trainKeys.all, "claims-health", projectId] as const,
  timeline: (requestId: string) => [...trainKeys.all, "timeline", requestId] as const,
  // Under trainKeys.all like the rest, so a lifecycle event (or a force-*
  // mutation) refreshes the trace along with everything else on the page.
  phases: (requestId: string) => [...trainKeys.phasesAll, requestId] as const,
  trace: (projectId: string, resource?: string, limit?: number) =>
    [...trainKeys.traceAll, projectId, { resource, limit }] as const,
  // Lives UNDER trainKeys.all so the shipped useSSE audit.recorded / train.* /
  // merge.* invalidation refreshes the audit log live.
  audit: (projectId: string, filters?: AuditFilters) =>
    [...trainKeys.all, "audit", projectId, { ...filters }] as const,
  // Lives UNDER trainKeys.all so a force-* mutation (which invalidates
  // trainKeys.all) refreshes the break-glass request pickers live.
  mergeRequests: (projectId: string, statuses: readonly string[]) =>
    [...trainKeys.all, "merge-requests", projectId, [...statuses]] as const,
};

export function useTrainMetrics(projectId: string | undefined, resource?: string) {
  return useQuery({
    queryKey: trainKeys.metrics(projectId!, resource),
    queryFn: () => getTrainMetrics(projectId!, resource),
    enabled: !!projectId,
    // Poll floor so "last heard Ns ago" stays live between SSE pushes.
    refetchInterval: 10_000,
  });
}

export function useTrainInFlight(projectId: string | undefined, resource?: string) {
  return useQuery({
    queryKey: trainKeys.inFlight(projectId!, resource),
    queryFn: () => getTrainInFlight(projectId!, resource),
    enabled: !!projectId,
  });
}

export function useTrainHealth(projectId: string | undefined, resource?: string) {
  return useQuery({
    queryKey: trainKeys.health(projectId!, resource),
    queryFn: () => getIntegratorHealth(projectId!, resource),
    enabled: !!projectId,
    // Poll floor so the freshness counter has fresh staleness to tick from.
    refetchInterval: 10_000,
  });
}

/**
 * Polls the project's stale-claim health (Campaign C3 §P5a). The READ itself is
 * the detection trigger: the server's computeClaimsHealth fires the edge-
 * triggered claim.stale_alert (SSE banner + Discord) once per stale episode. We
 * mount this on the always-open app-layout (NOT a rarely-visited tab) so the
 * edge fires whenever any project view is open. The returned data is incidental
 * — the side effect (the on-read alert) is the point.
 */
export function useClaimsHealth(projectId: string | undefined) {
  return useQuery({
    queryKey: trainKeys.claimsHealth(projectId!),
    queryFn: () => getClaimsHealth(projectId!),
    enabled: !!projectId,
    // Poll so the on-read edge keeps firing/re-arming while a project is open.
    refetchInterval: 30_000,
  });
}

export function useTrainState(projectId: string | undefined) {
  return useQuery({
    queryKey: trainKeys.state(projectId!),
    queryFn: () => getTrainState(projectId!),
    enabled: !!projectId,
  });
}

export function useMergeRequestTimeline(requestId: string | undefined) {
  return useQuery({
    queryKey: trainKeys.timeline(requestId!),
    queryFn: () => getMergeRequestTimeline(requestId!),
    enabled: !!requestId,
    // The key lives under trainKeys.all, so the shipped useSSE merge.* / train.*
    // invalidation refreshes the timeline live as attempts/lands/rejects fire.
  });
}

/**
 * The completed-phase trace for one merge request (campaign 2026-08-03 §P4).
 *
 * SSE is now the primary path: §P5 subscribed `merge.phase.recorded` and mapped
 * it to the three phase-bearing key prefixes, so a phase completing mid-flight
 * reaches the screen immediately. The 10s poll stays as the DROPPED-CONNECTION
 * FLOOR — an EventSource that is reconnecting delivers nothing, and a request
 * still integrating is exactly when an operator is watching. Cadence matches
 * useTrainMetrics / useTrainHealth so the page refreshes on one beat.
 */
export function useMergeRequestPhases(requestId: string | undefined) {
  return useQuery({
    queryKey: trainKeys.phases(requestId!),
    queryFn: () => getMergeRequestPhases(requestId!),
    enabled: !!requestId,
    refetchInterval: 10_000,
  });
}

/**
 * The lane's recent-event trace (campaign 2026-08-03 §P5) — what happened
 * lately and what took how long.
 *
 * Live via SSE like the phase trace above: `merge.phase.recorded` refreshes it
 * directly, and every merge/train lifecycle event already invalidates
 * trainKeys.all, which contains this key. The poll is the same reconnect floor.
 */
export function useTrainTrace(projectId: string | undefined, resource?: string, limit?: number) {
  return useQuery({
    queryKey: trainKeys.trace(projectId!, resource, limit),
    queryFn: () => getTrainTrace(projectId!, { resource, limit }),
    enabled: !!projectId,
    refetchInterval: 10_000,
  });
}

// ─── Break-glass / Audit (admin R1-override surface) ──────────────

export function useAuditLog(projectId: string | undefined, filters?: AuditFilters) {
  return useQuery({
    queryKey: trainKeys.audit(projectId!, filters),
    queryFn: () => getAuditLog(projectId!, filters),
    enabled: !!projectId,
  });
}

export function usePauseTrain() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      resource,
      reason,
    }: {
      projectId: string;
      resource?: string;
      reason?: string | null;
    }) => pauseTrain(projectId, { resource, reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trainKeys.all });
      toast.success("Merge train paused");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export function useResumeTrain() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      resource,
      reason,
    }: {
      projectId: string;
      resource?: string;
      reason?: string | null;
    }) => resumeTrain(projectId, { resource, reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trainKeys.all });
      toast.success("Merge train resumed");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export function useForceReleaseLock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      resource,
      reason,
    }: {
      projectId: string;
      resource: string;
      reason?: string | null;
    }) => forceReleaseLock(projectId, resource, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trainKeys.all });
      toast.success("Merge lock force-released");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export function useForceLand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      requestId,
      landedSha,
      reason,
    }: {
      requestId: string;
      landedSha: string;
      reason: string;
    }) => forceLand(requestId, { landedSha, reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trainKeys.all });
      toast.success("Merge request force-landed");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export function useForceReject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, reason }: { requestId: string; reason: string }) =>
      forceReject(requestId, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trainKeys.all });
      toast.success("Merge request force-rejected");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export function useForceCancel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, reason }: { requestId: string; reason: string }) =>
      forceCancel(requestId, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trainKeys.all });
      toast.success("Merge request force-cancelled");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

/**
 * Merge requests in the given lifecycle states — backs the break-glass request
 * pickers. Fetches each status and merges (one query), so a force dialog can
 * offer exactly the requests its operation is valid for. `enabled` lets a
 * dialog defer the fetch until it opens.
 */
export function useMergeRequests(
  projectId: string | undefined,
  statuses: readonly string[],
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: trainKeys.mergeRequests(projectId!, statuses),
    queryFn: async () => {
      const lists = await Promise.all(
        statuses.map((status) => getMergeRequests(projectId!, { status })),
      );
      return lists.flat();
    },
    enabled: (options?.enabled ?? true) && !!projectId,
  });
}
