import { useState } from "react";
import { useAuth } from "@clerk/clerk-expo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  AccountDeletionRequestError,
  cancelAccountDeletion,
  fetchAccountDeletionStatus,
  fetchAccountExportFiles,
  fetchAccountRecords,
  mobileQueryKeys,
  scheduleAccountDeletion,
  type AccountDeletionStatus,
  type AccountExportPage,
} from "@/lib/requests";

/**
 * Deletion state for the signed-in Matrix OS account. Disabled without a Clerk
 * session (a self-hosted computer login has no Matrix OS account to delete).
 */
export function useAccountDeletion() {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const queryClient = useQueryClient();
  const enabled = Boolean(isLoaded && isSignedIn && userId);
  const queryKey = mobileQueryKeys.accountDeletion(userId ?? "signed-out");

  async function requireToken(): Promise<string> {
    const token = await getToken();
    if (!token) throw new AccountDeletionRequestError("unavailable");
    return token;
  }

  const status = useQuery({
    queryKey,
    enabled,
    // The deadline and billing state decide which actions are offered, so a
    // remembered answer is never treated as current.
    staleTime: 0,
    queryFn: async () => fetchAccountDeletionStatus(await requireToken()),
  });
  // Both mutations answer with the new state; storing it means the screen
  // changes only after the server has confirmed the request.
  const remember = (next: AccountDeletionStatus) => {
    queryClient.setQueryData(queryKey, next);
  };
  const schedule = useMutation({
    mutationFn: async () => scheduleAccountDeletion(await requireToken()),
    onSuccess: remember,
  });
  const cancel = useMutation({
    mutationFn: async () => cancelAccountDeletion(await requireToken()),
    onSuccess: remember,
  });

  return {
    enabled,
    status: status.data,
    isPending: enabled && status.isPending,
    isError: status.isError,
    reload: () => void status.refetch(),
    schedule: schedule.mutateAsync,
    isScheduling: schedule.isPending,
    cancel: cancel.mutateAsync,
    isCancelling: cancel.isPending,
  };
}

/**
 * Export actions for the deletion screen. Download links are short-lived, so
 * the list is fetched on demand and kept only while the screen is mounted.
 */
export function useAccountExport() {
  const { getToken } = useAuth();
  const [page, setPage] = useState<AccountExportPage | null>(null);

  async function requireToken(): Promise<string> {
    const token = await getToken();
    if (!token) throw new AccountDeletionRequestError("unavailable");
    return token;
  }

  const files = useMutation({
    mutationFn: async (cursor: string | undefined) => fetchAccountExportFiles(await requireToken(), cursor),
    onSuccess: (next, cursor) => {
      setPage((current) => cursor && current
        ? { ...next, files: [...current.files, ...next.files] }
        : next);
    },
  });
  const records = useMutation({
    mutationFn: async () => fetchAccountRecords(await requireToken()),
  });

  return {
    files: page?.files ?? null,
    instructions: page?.instructions ?? [],
    hasMoreFiles: Boolean(page?.nextCursor),
    loadFiles: () => files.mutateAsync(undefined),
    loadMoreFiles: () => files.mutateAsync(page?.nextCursor ?? undefined),
    isLoadingFiles: files.isPending,
    fetchRecords: records.mutateAsync,
    isFetchingRecords: records.isPending,
  };
}
