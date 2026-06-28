import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getNotes,
  getNote,
  getNotesHealth,
  createNote,
  updateNote,
  dismissNote,
  reopenNote,
  promoteNoteToProposal,
  promoteNoteToTask,
  type CreateNote,
  type NoteFilters,
  type PatchNote,
} from "@/lib/api";
import { proposalKeys } from "./use-proposals";
import { taskKeys } from "./use-tasks";

export const noteKeys = {
  all: ["notes"] as const,
  lists: () => [...noteKeys.all, "list"] as const,
  list: (projectId: string, filters?: NoteFilters) =>
    [...noteKeys.lists(), { projectId, ...filters }] as const,
  details: () => [...noteKeys.all, "detail"] as const,
  detail: (id: string) => [...noteKeys.details(), id] as const,
  health: (projectId: string) => [...noteKeys.all, "health", projectId] as const,
};

export function useNotes(projectId: string | undefined, filters?: NoteFilters) {
  return useQuery({
    queryKey: noteKeys.list(projectId!, filters),
    queryFn: () => getNotes(projectId!, filters),
    enabled: !!projectId,
  });
}

export function useNote(noteId: string | undefined) {
  return useQuery({
    queryKey: noteKeys.detail(noteId!),
    queryFn: () => getNote(noteId!),
    enabled: !!noteId,
  });
}

/**
 * Polls the project's notes-backlog health (Campaign C3). Like useClaimsHealth,
 * the READ itself is the detection trigger: the server's computeNotesHealth fires
 * the edge-triggered `note.backlog_alert` (SSE banner + Discord) once per backlog
 * episode. The returned data is incidental — the on-read side effect is the point.
 */
export function useNotesHealth(projectId: string | undefined) {
  return useQuery({
    queryKey: noteKeys.health(projectId!),
    queryFn: () => getNotesHealth(projectId!),
    enabled: !!projectId,
    refetchInterval: 30_000,
  });
}

export function useCreateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, data }: { projectId: string; data: CreateNote }) =>
      createNote(projectId, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: noteKeys.lists() });
      queryClient.invalidateQueries({
        queryKey: noteKeys.health(variables.projectId),
      });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export function useUpdateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; projectId: string; data: PatchNote }) =>
      updateNote(id, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: noteKeys.lists() });
      queryClient.invalidateQueries({ queryKey: noteKeys.detail(variables.id) });
      queryClient.invalidateQueries({
        queryKey: noteKeys.health(variables.projectId),
      });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export function useDismissNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; projectId: string; reason: string }) =>
      dismissNote(id, reason),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: noteKeys.lists() });
      queryClient.invalidateQueries({ queryKey: noteKeys.detail(variables.id) });
      queryClient.invalidateQueries({
        queryKey: noteKeys.health(variables.projectId),
      });
      toast.success("Note dismissed");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

/**
 * Reopen a needs_human|triaged note back to open (T3 — undo-triage). HUMAN-ONLY
 * on the server (403 surfaces via onError toast). Clears the note's triage
 * metadata but never deletes a prior promote's proposal/task.
 */
export function useReopenNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; projectId: string }) => reopenNote(id),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: noteKeys.lists() });
      queryClient.invalidateQueries({ queryKey: noteKeys.detail(variables.id) });
      queryClient.invalidateQueries({
        queryKey: noteKeys.health(variables.projectId),
      });
      toast.success("Note reopened");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export function usePromoteNoteToProposal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      title,
      description,
    }: {
      id: string;
      projectId: string;
      title?: string;
      description?: string;
    }) => promoteNoteToProposal(id, { title, description }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: noteKeys.lists() });
      queryClient.invalidateQueries({ queryKey: noteKeys.detail(variables.id) });
      queryClient.invalidateQueries({
        queryKey: noteKeys.health(variables.projectId),
      });
      // Project-scoped (C3 P5): only the promoted-into project's proposal
      // lists refresh — not every project's.
      queryClient.invalidateQueries({
        queryKey: proposalKeys.listsFor(variables.projectId),
      });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export function usePromoteNoteToTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      title,
      description,
      epicId,
    }: {
      id: string;
      projectId: string;
      title?: string;
      description?: string;
      epicId?: string;
    }) => promoteNoteToTask(id, { title, description, epicId }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: noteKeys.lists() });
      queryClient.invalidateQueries({ queryKey: noteKeys.detail(variables.id) });
      queryClient.invalidateQueries({
        queryKey: noteKeys.health(variables.projectId),
      });
      // Project-scoped (C3 P5): only the promoted-into project's task lists
      // refresh — not every project's.
      queryClient.invalidateQueries({
        queryKey: taskKeys.listsFor(variables.projectId),
      });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}
