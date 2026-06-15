import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listAgentPools,
  getAgentPool,
  createAgentPool,
  updateAgentPool,
  deleteAgentPool,
  updateAgentPoolSecret,
  createPoolAgents,
  forceReleaseAgent,
  removeAgentFromPool,
} from "@/lib/api";
import { userKeys } from "@/hooks/use-users";

export const agentPoolKeys = {
  all: ["agent-pool"] as const,
  pools: () => [...agentPoolKeys.all, "pools"] as const,
  pool: (id: string) => [...agentPoolKeys.all, "pool", id] as const,
};

export function useAgentPools() {
  return useQuery({
    queryKey: agentPoolKeys.pools(),
    queryFn: listAgentPools,
    refetchInterval: 30_000,
  });
}

export function useAgentPool(poolId: string) {
  return useQuery({
    queryKey: agentPoolKeys.pool(poolId),
    queryFn: () => getAgentPool(poolId),
    refetchInterval: 30_000,
    enabled: !!poolId,
  });
}

export function useCreatePool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      name,
      secret,
      description,
    }: {
      name: string;
      secret: string;
      description?: string;
    }) => createAgentPool(name, secret, description),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentPoolKeys.pools() });
    },
  });
}

export function useUpdatePool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      poolId,
      data,
    }: {
      poolId: string;
      data: { name?: string; description?: string };
    }) => updateAgentPool(poolId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentPoolKeys.all });
    },
  });
}

export function useDeletePool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (poolId: string) => deleteAgentPool(poolId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentPoolKeys.pools() });
      queryClient.invalidateQueries({ queryKey: userKeys.list() });
    },
  });
}

export function useUpdatePoolSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ poolId, secret }: { poolId: string; secret: string }) =>
      updateAgentPoolSecret(poolId, secret),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentPoolKeys.all });
    },
  });
}

export function useCreatePoolAgents() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      poolId,
      count,
      namePrefix,
    }: {
      poolId: string;
      count: number;
      namePrefix?: string;
    }) => createPoolAgents(poolId, count, namePrefix),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentPoolKeys.all });
      queryClient.invalidateQueries({ queryKey: userKeys.list() });
    },
  });
}

export function useRemoveAgentFromPool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ poolId, userId }: { poolId: string; userId: string }) =>
      removeAgentFromPool(poolId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentPoolKeys.all });
      queryClient.invalidateQueries({ queryKey: userKeys.list() });
    },
  });
}

export function useForceReleaseAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => forceReleaseAgent(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentPoolKeys.all });
    },
  });
}
