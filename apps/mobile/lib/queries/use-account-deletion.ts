import { useLayoutEffect, useRef, useState } from "react";
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
  const { getToken, userId } = useAuth();
  const currentOwner = useRef(userId);
  const pendingRecords = useRef<{ owner: string | null | undefined; json: string; cursor?: string } | null>(null);
  const [recordsProgress, setRecordsProgress] = useState<{ owner: string | null | undefined; cursor: string | null; page: number; complete: boolean } | null>(null);
  const progress = recordsProgress?.owner === userId ? recordsProgress : null;
  useLayoutEffect(() => {
    currentOwner.current = userId;
    pendingRecords.current = null;
    return () => { currentOwner.current = undefined; pendingRecords.current = null; };
  }, [userId]);
  const [fileState, setFileState] = useState<{
    owner: string | null | undefined;
    page: AccountExportPage;
  } | null>(null);
  // Signed download URLs are bearer capabilities. Never project one owner's
  // cached links into another owner's render, even for the render before an
  // account-change effect can run.
  const page = fileState !== null && fileState.owner === userId ? fileState.page : null;

  async function requireToken(): Promise<string> {
    const token = await getToken();
    if (!token) throw new AccountDeletionRequestError("unavailable");
    return token;
  }

  const files = useMutation({
    mutationFn: async (cursor: string | undefined) => {
      const owner = userId;
      const token = await requireToken();
      let next = await fetchAccountExportFiles(token, cursor);
      for (
        let requests = 1;
        next.files.length === 0 && next.nextCursor && requests < MAX_EXPORT_PAGE_REQUESTS;
        requests += 1
      ) {
        next = await fetchAccountExportFiles(token, next.nextCursor);
      }
      if (currentOwner.current !== owner) throw new AccountDeletionRequestError("unavailable");
      return { owner, page: next };
    },
    onSuccess: (next, cursor) => {
      if (currentOwner.current !== next.owner) return;
      setFileState((current) => cursor && current !== null && current.owner === next.owner
        ? { owner: next.owner, page: { ...next.page, files: [...current.page.files, ...next.page.files] } }
        : next);
    },
  });
  const records = useMutation({
    mutationFn: async (cursor: string | undefined) => {
      const owner = userId;
      const token = await requireToken();
      const json = cursor ? await fetchAccountRecords(token, cursor) : await fetchAccountRecords(token);
      if (currentOwner.current !== owner) throw new AccountDeletionRequestError("unavailable");
      pendingRecords.current = { owner, json, cursor };
      return json;
    },
  });

  return {
    files: page?.files ?? null,
    instructions: page?.instructions ?? [],
    hasMoreFiles: Boolean(page?.nextCursor),
    loadFiles: () => files.mutateAsync(undefined),
    loadMoreFiles: () => files.mutateAsync(page?.nextCursor ?? undefined),
    isLoadingFiles: files.isPending,
    fetchRecords: () => records.mutateAsync(undefined),
    fetchMoreRecords: () => progress?.cursor
      ? records.mutateAsync(progress.cursor) : Promise.reject(new AccountDeletionRequestError("unavailable")),
    confirmRecordsSaved: (json: string) => {
      const pending = pendingRecords.current;
      if (!pending || pending.owner !== currentOwner.current || pending.json !== json) return;
      const value: unknown = JSON.parse(json);
      const cursor = value && typeof value === "object" && "nextCursor" in value ? value.nextCursor : null;
      if (cursor !== null && cursor !== undefined && (typeof cursor !== "string" || cursor.length > 4096)) throw new AccountDeletionRequestError("unavailable");
      setRecordsProgress(current => ({ owner: pending.owner, cursor: typeof cursor === "string" ? cursor : null,
        page: pending.cursor && current && current.owner === pending.owner ? current.page + 1 : 1, complete: !cursor }));
      pendingRecords.current = null;
    },
    recordsPage: progress?.page ?? 0,
    hasMoreRecords: Boolean(progress?.cursor),
    recordsComplete: progress?.complete ?? false,
    isFetchingRecords: records.isPending,
  };
}
