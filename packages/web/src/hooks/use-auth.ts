import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  getCurrentUser,
  getSetupStatus,
  login,
  logout,
  setup,
  type LoginData,
  type SetupData,
  ApiError,
} from "@/lib/api";

export const authKeys = {
  currentUser: ["auth", "currentUser"] as const,
  setupStatus: ["auth", "setupStatus"] as const,
};

export function useCurrentUser() {
  return useQuery({
    queryKey: authKeys.currentUser,
    queryFn: getCurrentUser,
    retry: (failureCount, error) => {
      // Don't retry on 401 — the user is simply not authenticated
      if (error instanceof ApiError && error.status === 401) {
        return false;
      }
      return failureCount < 1;
    },
    staleTime: 60_000,
  });
}

export function useSetupStatus() {
  return useQuery({
    queryKey: authKeys.setupStatus,
    queryFn: getSetupStatus,
    staleTime: 60_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: LoginData) => login(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: authKeys.currentUser });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      queryClient.clear();
      navigate({ to: "/login" });
    },
  });
}

export function useSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SetupData) => setup(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: authKeys.currentUser });
      queryClient.invalidateQueries({ queryKey: authKeys.setupStatus });
    },
  });
}
