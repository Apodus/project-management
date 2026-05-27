import { useQuery } from "@tanstack/react-query";
import { getAgentPoolStatus } from "@/lib/api";

export const agentPoolKeys = {
  all: ["agent-pool"] as const,
  status: () => [...agentPoolKeys.all, "status"] as const,
};

export function useAgentPoolStatus() {
  return useQuery({
    queryKey: agentPoolKeys.status(),
    queryFn: getAgentPoolStatus,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });
}
