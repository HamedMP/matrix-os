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
  const confirmed = {
    // A status read still in flight was sent before this request. Opening the
    // screen starts one while the cached state already enables the buttons, so
    // without this its older answer could replace the confirmed one.
    onMutate: () => queryClient.cancelQueries({ queryKey }),
    // Both requests answer with the new state; storing it means the screen
    // changes only after the server has confirmed the request.
    onSuccess: (next: AccountDeletionStatus) => {
      queryClient.setQueryData(queryKey, next);
    },
    // Read again either way: a refusal means the state on screen was out of
    // date. Not awaited, so the button is released as soon as the request is.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  };
  const schedule = useMutation({
    mutationFn: async () => scheduleAccountDeletion(await requireToken()),
    ...confirmed,
  });
  const cancel = useMutation({
    mutationFn: async () => cancelAccountDeletion(await requireToken()),
    ...confirmed,
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

// The server lists several storage locations in turn, so a page can be empty
// while a later one holds the backups. One tap follows the cursor past empty
// pages, up to this many requests; beyond that the screen offers "Load more".
const MAX_EXPORT_PAGE_REQUESTS = 5;

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
    mutationFn: async (cursor: string | undefined) => {
      let next = await fetchAccountExportFiles(await requireToken(), cursor);
      for (
        let requests = 1;
        next.files.length === 0 && next.nextCursor && requests < MAX_EXPORT_PAGE_REQUESTS;
        requests += 1
      ) {
        next = await fetchAccountExportFiles(await requireToken(), next.nextCursor);
      }
      return next;
    },
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
