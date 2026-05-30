import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getTrainMetrics,
  getTrainInFlight,
  getIntegratorHealth,
  getTrainState,
  getMergeRequestTimeline,
  getAuditLog,
  pauseTrain,
  resumeTrain,
  forceReleaseLock,
  forceLand,
  forceReject,
  type AuditFilters,
} from "@/lib/api";

export const trainKeys = {
  all: ["train"] as const,
  metrics: (projectId: string, resource?: string) =>
    [...trainKeys.all, "metrics", projectId, { resource }] as const,
  inFlight: (projectId: string, resource?: string) =>
    [...trainKeys.all, "in-flight", projectId, { resource }] as const,
  health: (projectId: string, resource?: string) =>
    [...trainKeys.all, "health", projectId, { resource }] as const,
  state: (projectId: string) => [...trainKeys.all, "state", projectId] as const,
  timeline: (requestId: string) =>
    [...trainKeys.all, "timeline", requestId] as const,
  // Lives UNDER trainKeys.all so the shipped useSSE audit.recorded / train.* /
  // merge.* invalidation refreshes the audit log live.
  audit: (projectId: string, filters?: AuditFilters) =>
    [...trainKeys.all, "audit", projectId, { ...filters }] as const,
};

export function useTrainMetrics(
  projectId: string | undefined,
  resource?: string,
) {
  return useQuery({
    queryKey: trainKeys.metrics(projectId!, resource),
    queryFn: () => getTrainMetrics(projectId!, resource),
    enabled: !!projectId,
    // Poll floor so "last heard Ns ago" stays live between SSE pushes.
    refetchInterval: 10_000,
  });
}

export function useTrainInFlight(
  projectId: string | undefined,
  resource?: string,
) {
  return useQuery({
    queryKey: trainKeys.inFlight(projectId!, resource),
    queryFn: () => getTrainInFlight(projectId!, resource),
    enabled: !!projectId,
  });
}

export function useTrainHealth(
  projectId: string | undefined,
  resource?: string,
) {
  return useQuery({
    queryKey: trainKeys.health(projectId!, resource),
    queryFn: () => getIntegratorHealth(projectId!, resource),
    enabled: !!projectId,
    // Poll floor so the freshness counter has fresh staleness to tick from.
    refetchInterval: 10_000,
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

// ─── Break-glass / Audit (admin R1-override surface) ──────────────

export function useAuditLog(
  projectId: string | undefined,
  filters?: AuditFilters,
) {
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
    mutationFn: ({
      requestId,
      reason,
    }: {
      requestId: string;
      reason: string;
    }) => forceReject(requestId, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trainKeys.all });
      toast.success("Merge request force-rejected");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}
