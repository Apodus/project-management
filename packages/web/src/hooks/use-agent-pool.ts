import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAgentPoolStatus,
  getPoolSecretStatus,
  setPoolSecret,
  createAgentPool,
  forceReleaseAgent,
} from "@/lib/api";
import { userKeys } from "@/hooks/use-users";

export const agentPoolKeys = {
  all: ["agent-pool"] as const,
  status: () => [...agentPoolKeys.all, "status"] as const,
  secretStatus: () => [...agentPoolKeys.all, "secret-status"] as const,
};

export function useAgentPoolStatus() {
  return useQuery({
    queryKey: agentPoolKeys.status(),
    queryFn: getAgentPoolStatus,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });
}

export function usePoolSecretStatus() {
  return useQuery({
    queryKey: agentPoolKeys.secretStatus(),
    queryFn: getPoolSecretStatus,
  });
}

export function useSetPoolSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (secret: string) => setPoolSecret(secret),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentPoolKeys.secretStatus() });
    },
  });
}

export function useCreateAgentPool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ count, namePrefix }: { count: number; namePrefix?: string }) =>
      createAgentPool(count, namePrefix),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentPoolKeys.status() });
      queryClient.invalidateQueries({ queryKey: userKeys.list() });
    },
  });
}

export function useForceReleaseAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => forceReleaseAgent(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentPoolKeys.status() });
    },
  });
}
