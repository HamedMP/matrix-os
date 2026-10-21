"use client";
import {COMPANY_DRIVE_MOBILE_CHAT_EVENT,useCompanyDriveChatDraft} from "@/stores/company-drive-chat-draft";
import {useWindowManager} from "@/hooks/useWindowManager";

import {
  OrganizationDriveDownloadSchema,
  OrganizationDriveSnapshotSchema,
  OrganizationDriveUploadReservationSchema,
  type OrganizationDriveFile,
} from "@matrix-os/contracts";
import { companyDriveChatReference, resolveOrganizationDriveNavigation, OrganizationDriveBrowser, createRefreshGuard, driveBasePath as base, ensureOrganizationContributorGrant, loadOrganizationDriveOptions, type OrganizationDriveOption, type OrganizationDrivePageCounts } from "@matrix-os/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod/v4";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { useShellCollaborationApi } from "@/lib/collaboration-organization";

function safeError(error: unknown): string {
  if (error instanceof Error && error.message === "FileTooLarge") return "Files must be 100 MiB or smaller.";
  return "Organization drive is unavailable. Try again.";
}

export function OrganizationDrivesView({ requestedScopeId, requestedIntentId, draftIdentity, mobile=false }: { requestedScopeId?: string; requestedIntentId?: string; draftIdentity?:string; mobile?:boolean }) {
  const origin = useBrowserOrigin();
  const api = useShellCollaborationApi(origin, Boolean(origin));
  const [options, setOptions] = useState<OrganizationDriveOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState("");
  const appliedRequest = useRef<string | undefined>(undefined);
  useEffect(() => {
    if ((requestedIntentId ?? requestedScopeId) !== appliedRequest.current && requestedScopeId && options.some(option => option.scopeId === requestedScopeId)) {
      appliedRequest.current = requestedIntentId ?? requestedScopeId; setSelected(requestedScopeId); setFolder("");
    }
  }, [requestedScopeId, requestedIntentId, options]);
  const [error, setError] = useState<string | null>(null);
  // Pages loaded per drive, so refreshes keep files the member already paged in.
  const pageCounts = useRef<OrganizationDrivePageCounts>({});
  const [refreshGuard] = useState(createRefreshGuard);
  const load = useCallback(async () => {
    if (!api) return;
    const token = refreshGuard.begin();
    try {
      const next = await loadOrganizationDriveOptions(api, pageCounts.current);
      if (!refreshGuard.isCurrent(token)) return;
      pageCounts.current = Object.fromEntries(next.filter((option) => option.pages)
        .map((option) => [option.scopeId, option.pages ?? 1]));
      setOptions(next);
      setSelected((current) => current ?? next[0]?.scopeId ?? null);
      setError(null);
    } catch (failure: unknown) {
      console.warn("[organization-drive] listing unavailable", failure instanceof Error ? failure.name : "UnknownError");
      if (refreshGuard.isCurrent(token)) setError(safeError(failure));
    } finally { refreshGuard.finish(token); setLoading(false); }
  }, [api, refreshGuard]);
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- current organization shares and scope sessions are browser identity state.
  useEffect(() => { void load(); }, [load]);
  const navigation = resolveOrganizationDriveNavigation(options.map(option => option.scopeId), selected,
    requestedScopeId ? {scopeId: requestedScopeId, intentId: requestedIntentId} : undefined, appliedRequest.current);
  const active = options.find(option => option.scopeId === navigation.scopeId);
  useEffect(() => {
    if (!api || !navigation.scopeId) return;
    let live = true;
    const unsubscribe = api.subscribe?.(navigation.scopeId, () => {if (live) return load();}, () => {if (live) setError("Organization drive is unavailable. Try again.");});
    const timer = setInterval(() => { void load(); }, 30_000);
    return () => { live = false; unsubscribe?.(); clearInterval(timer); };
  }, [api, navigation.scopeId, load]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); await load(); }
    catch (failure: unknown) {
      console.warn("[organization-drive] action failed", failure instanceof Error ? failure.name : "UnknownError");
      setError(safeError(failure));
    } finally { setBusy(false); }
  };

  const activate = (option: OrganizationDriveOption) => run(async () => {
    if (!api || !option.grantId) return;
    await api.direct.request(option.scopeId, "POST",
      `/api/collaboration/scopes/${option.scopeId}/grants/${option.grantId}/accept`, {});
  });

  const enable = (option: OrganizationDriveOption) => run(async () => {
    if (!api) return;
    const path = base(option.scopeId);
    await api.direct.request(option.scopeId, "PUT", path, {});
    await ensureOrganizationContributorGrant(api, option.scopeId);
  });

  const share = (option: OrganizationDriveOption) => run(async () => {
    if (!api) return;
    await ensureOrganizationContributorGrant(api, option.scopeId);
  });

  const upload = (option: OrganizationDriveOption, file: File) => run(async () => {
    if (!api) return;
    if (file.size > 100 * 1024 * 1024) throw new Error("FileTooLarge");
    const bytes = await file.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((value) => value.toString(16).padStart(2, "0")).join("");
    const path = folder.trim() ? `${folder.trim().replace(/\/$/, "")}/${file.name}` : file.name;
    const version = z.object({ baseVersion: z.number().int().nonnegative() }).strict().parse(
      await api.direct.request(option.scopeId, "POST", `${base(option.scopeId)}/files/lookup`, { path }));
    const reservation = OrganizationDriveUploadReservationSchema.parse(await api.direct.request(option.scopeId,
      "POST", `${base(option.scopeId)}/uploads`, { path, size: file.size, sha256: digest,
        requestId: crypto.randomUUID(), baseVersion: version.baseVersion }));
    try {
      const response = await fetch(reservation.putUrl, { method: "PUT", body: bytes,
        redirect: "error", signal: AbortSignal.timeout(15 * 60_000) });
      if (!response.ok) throw new Error("UploadFailed");
      await api.direct.request(option.scopeId, "POST", `${base(option.scopeId)}/uploads/${reservation.uploadId}/commit`, {});
    } catch (failure: unknown) {
      await api.direct.request(option.scopeId, "DELETE", `${base(option.scopeId)}/uploads/${reservation.uploadId}`)
        .catch((cleanupError: unknown) => console.warn("[organization-drive] upload cleanup failed", cleanupError instanceof Error ? cleanupError.name : "UnknownError"));
      throw failure;
    }
  });

  const download = (option: OrganizationDriveOption, file: OrganizationDriveFile) => run(async () => {
    if (!api) return;
    const result = OrganizationDriveDownloadSchema.parse(await api.direct.request(option.scopeId, "GET",
      `${base(option.scopeId)}/files/${file.id}`));
    const response = await fetch(result.getUrl, { redirect: "error", signal: AbortSignal.timeout(5 * 60_000) });
    if (!response.ok) throw new Error("DownloadFailed");
    const objectUrl = URL.createObjectURL(await response.blob());
    try {
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = file.path.split("/").at(-1) ?? "download";
      document.body.append(link);
      link.click();
      link.remove();
    } finally { setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000); }
  });

  const loadMore = async (option: OrganizationDriveOption) => {
    const cursor = option.snapshot?.nextCursor;
    if (!api || !cursor || busy || (option.pages ?? 1) >= 20) return;
    setBusy(true); setError(null);
    try {
      const page = OrganizationDriveSnapshotSchema.parse(await api.direct.request(option.scopeId, "GET",
        `${base(option.scopeId)}?after=${encodeURIComponent(cursor)}`));
      const pages = (option.pages ?? 1) + 1;
      pageCounts.current = { ...pageCounts.current, [option.scopeId]: pages };
      // A refresh started before this page arrived would restore the shorter list.
      const refreshPending = refreshGuard.inFlight();
      refreshGuard.invalidate();
      setOptions((current) => current.map((item) => item.scopeId === option.scopeId && item.snapshot
        ? { ...item, pages, snapshot: { ...page, files: [...item.snapshot.files, ...page.files] } } : item));
      if (refreshPending) void load();
    } catch (failure: unknown) {
      console.warn("[organization-drive] next page unavailable", failure instanceof Error ? failure.name : "UnknownError");
      setError(safeError(failure));
    } finally { setBusy(false); }
  };

  return <div className="flex h-full min-h-0 flex-col p-4 text-sm">
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-base font-semibold">Organization drives</h2>
      <button type="button" onClick={() => void load()} disabled={busy} className="rounded border px-3 py-1.5">Refresh</button>
    </div>
    {!loading && navigation.unavailable ? <p role="alert" className="mb-3 text-xs">This drive is unavailable. Choose another drive or refresh.</p> : null}
    {error && <p role="alert" className="mb-3 text-destructive">{error}</p>}
    {loading ? <p>Loading drives…</p> : options.length === 0
      ? <p className="text-muted-foreground">Share a folder with your organization to make a drive available here.</p>
      : <div className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row">
        <nav aria-label="Organization drives" className="w-full shrink-0 space-y-1 border-b pb-2 sm:w-48 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-3">
          {options.map((option) => <button type="button" key={option.scopeId}
            aria-current={navigation.scopeId === option.scopeId ? "page" : undefined}
            disabled={busy} onClick={() => { appliedRequest.current = requestedIntentId ?? requestedScopeId; setSelected(option.scopeId); setFolder(""); }}
            className="w-full rounded px-2 py-2 text-left hover:bg-accent aria-[current=page]:bg-accent">
            {option.name}
          </button>)}
        </nav>
        {active && <div className="min-w-0 flex-1 overflow-auto">

          {active.state === "pending" && <button type="button" disabled={busy} onClick={() => void activate(active)}
            className="rounded border px-3 py-1.5">Open organization share</button>}
          {active.state === "enable" && <button type="button" disabled={busy} onClick={() => void enable(active)}
            className="rounded border px-3 py-1.5">Enable drive for organization</button>}
          {active.snapshot && <>
            {active.canManage && <button type="button" disabled={busy} onClick={() => void share(active)}
              className="mb-3 rounded border px-3 py-1.5">Allow organization uploads</button>}
            <OrganizationDriveBrowser key={active.scopeId} name={active.name} files={active.snapshot.files}
              usedBytes={active.snapshot.usedBytes} reservedBytes={active.snapshot.reservedBytes} quotaBytes={active.snapshot.quotaBytes}
              busy={busy} canUpload={Boolean(active.canUpload)} folder={folder} onFolderChange={setFolder}
              onChatContext={draftIdentity?selection=>{
                const reference=companyDriveChatReference(active,selection.kind==="file"?{kind:"file",fileId:selection.file.id,version:selection.file.version,path:selection.file.path}:selection.kind==="folder"?selection:undefined);
                useCompanyDriveChatDraft.getState().open(reference,draftIdentity);
                if(mobile){window.dispatchEvent(new Event(COMPANY_DRIVE_MOBILE_CHAT_EVENT));return;}
                const manager=useWindowManager.getState(),existing=manager.windows.find(window=>window.path==="__chat__");
                if(existing){manager.restoreWindow(existing.id);manager.focusWindow(existing.id);}else manager.openWindow("Chat","__chat__",0);
              }:undefined}
              onDownload={file => void download(active, file)} hasMore={Boolean(active.snapshot.nextCursor)}
              pageLimitReached={(active.pages ?? 1) >= 20} onLoadMore={() => void loadMore(active)}
              uploadControl={<label className="inline-flex min-h-9 cursor-pointer items-center rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent">
                {busy ? "Transferring…" : "Upload file"}
                <input type="file" aria-label="Upload files" className="sr-only" disabled={busy} onChange={(event) => {
                  const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(active, file);
                }} />
              </label>} />
          </>}
        </div>}
      </div>}
  </div>;
}
