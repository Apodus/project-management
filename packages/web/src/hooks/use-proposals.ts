import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getProposals,
  getProposal,
  getProposalComments,
  getProposalWorkItems,
  createProposal,
  updateProposal,
  transitionProposal,
  addProposalComment,
  type CreateProposal,
  type UpdateProposal,
} from "@/lib/api";

export const proposalKeys = {
  all: ["proposals"] as const,
  lists: () => [...proposalKeys.all, "list"] as const,
  // Project-scoped list prefix (Campaign C3 P5): TanStack v5 partial object
  // matching — invalidating [..., "list", {projectId}] matches every list()
  // key whose trailing object contains that projectId, and no other project's.
  listsFor: (projectId: string) => [...proposalKeys.lists(), { projectId }] as const,
  list: (projectId: string, status?: string) =>
    [...proposalKeys.lists(), { projectId, status }] as const,
  details: () => [...proposalKeys.all, "detail"] as const,
  detail: (id: string) => [...proposalKeys.details(), id] as const,
  comments: (id: string) => [...proposalKeys.all, "comments", id] as const,
  workItems: (id: string) => [...proposalKeys.all, "workItems", id] as const,
};

export function useProposals(projectId: string | undefined, status?: string) {
  return useQuery({
    queryKey: proposalKeys.list(projectId!, status),
    queryFn: () => getProposals(projectId!, status),
    enabled: !!projectId,
  });
}

export function useProposal(id: string | undefined) {
  return useQuery({
    queryKey: proposalKeys.detail(id!),
    queryFn: () => getProposal(id!),
    enabled: !!id,
  });
}

export function useProposalComments(id: string | undefined) {
  return useQuery({
    queryKey: proposalKeys.comments(id!),
    queryFn: () => getProposalComments(id!),
    enabled: !!id,
  });
}

export function useProposalWorkItems(id: string | undefined) {
  return useQuery({
    queryKey: proposalKeys.workItems(id!),
    queryFn: () => getProposalWorkItems(id!),
    enabled: !!id,
  });
}

export function useCreateProposal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, data }: { projectId: string; data: CreateProposal }) =>
      createProposal(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: proposalKeys.lists() });
    },
  });
}

export function useUpdateProposal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateProposal }) => updateProposal(id, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: proposalKeys.lists() });
      queryClient.invalidateQueries({
        queryKey: proposalKeys.detail(variables.id),
      });
    },
  });
}

export function useTransitionProposal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, toStatus, actorId }: { id: string; toStatus: string; actorId?: string }) =>
      transitionProposal(id, toStatus, actorId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: proposalKeys.lists() });
      queryClient.invalidateQueries({
        queryKey: proposalKeys.detail(variables.id),
      });
    },
  });
}

export function useAddProposalComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body, type }: { id: string; body: string; type?: string }) =>
      addProposalComment(id, body, type),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: proposalKeys.comments(variables.id),
      });
      queryClient.invalidateQueries({
        queryKey: proposalKeys.detail(variables.id),
      });
    },
  });
}
