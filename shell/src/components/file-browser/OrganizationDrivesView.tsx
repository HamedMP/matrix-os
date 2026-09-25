"use client";

import {
  CollaborationGrantSchema,
  CollaborationScopeSchema,
  OrganizationDriveDownloadSchema,
  OrganizationDriveSnapshotSchema,
  OrganizationDriveUploadReservationSchema,
  type OrganizationDriveFile,
} from "@matrix-os/contracts";
import type { CollaborationDirectApi } from "@matrix-os/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod/v4";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { createShellCollaborationApi } from "@/lib/collaboration";
import { createRefreshGuard, driveBasePath as base, loadDiscoveryItems, loadDriveSnapshotPages } from "./organization-drive-paging";

const OrganizationsSchema = z.object({ organizations: z.array(z.object({
  organizationId: z.string(), name: z.string(),
}).passthrough()).max(100) }).passthrough();
const GrantsSchema = z.array(CollaborationGrantSchema).max(100);

type DriveOption = { scopeId: string; organizationId: string; name: string;
  state: "ready" | "enable" | "pending"; canManage?: boolean; grantId?: string;
  snapshot?: z.infer<typeof OrganizationDriveSnapshotSchema>; pages?: number };
type PageCounts = Record<string, number>;

async function inspectScope(api: CollaborationDirectApi, scopeId: string, organizationId: string, name: string,
  pages: number): Promise<DriveOption | null> {
  const scope = CollaborationScopeSchema.parse(await api.direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`));
  if (scope.kind !== "folder" || scope.organizationId !== organizationId) return null;
  try {
    const loaded = await loadDriveSnapshotPages((path) => api.direct.request(scopeId, "GET", path), scopeId, pages);
    return { scopeId, organizationId, name, state: "ready", canManage: scope.role === "owner", ...loaded };
  } catch (error: unknown) {
    // An existing folder share can be selected as the drive by its owner.
    if (scope.role === "owner") return { scopeId, organizationId, name, state: "enable", canManage: true };
    console.warn("[organization-drive] scope inspection unavailable", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

async function loadOptions(api: CollaborationDirectApi, pageCounts: PageCounts): Promise<DriveOption[]> {
  const get = (path: string) => api.get(path);
  const [inbox, shared, organizations] = await Promise.all([
    loadDiscoveryItems(get, "inbox"), loadDiscoveryItems(get, "shared"), api.get("/api/organizations"),
  ]);
  const names = new Map(OrganizationsSchema.parse(organizations).organizations.map((org) => [org.organizationId, org.name]));
  const items = [...inbox, ...shared];
  const seen = new Set<string>();
  const options: DriveOption[] = [];
  const accepted: Array<{ scopeId: string; organizationId: string; name: string }> = [];
  for (const item of items) {
    if (item.kind !== "folder" || seen.has(item.scopeId) || !item.organizationId) continue;
    seen.add(item.scopeId);
    const name = names.get(item.organizationId) ?? "Organization";
    if (item.status === "organization_pending") {
      options.push({ scopeId: item.scopeId, organizationId: item.organizationId, name,
        state: "pending", grantId: item.grantId });
      continue;
    }
    if (item.status !== "accepted") continue;
    accepted.push({ scopeId: item.scopeId, organizationId: item.organizationId, name });
  }
  for (let offset = 0; offset < accepted.length; offset += 4) {
    const batch = await Promise.all(accepted.slice(offset, offset + 4).map(async (item) => {
      try { return await inspectScope(api, item.scopeId, item.organizationId, item.name, pageCounts[item.scopeId] ?? 1); }
      catch (error: unknown) {
        console.warn("[organization-drive] share unavailable", error instanceof Error ? error.name : "UnknownError");
        return null;
      }
    }));
    for (const option of batch) if (option) options.push(option);
  }
  return options;
}

function safeError(error: unknown): string {
  if (error instanceof Error && error.message === "FileTooLarge") return "Files must be 100 MiB or smaller.";
  return "Organization drive is unavailable. Try again.";
}

export function OrganizationDrivesView() {
  const origin = useBrowserOrigin();
  const api = useMemo(() => origin ? createShellCollaborationApi(origin) : null, [origin]);
  const [options, setOptions] = useState<DriveOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Pages loaded per drive, so refreshes keep files the member already paged in.
  const pageCounts = useRef<PageCounts>({});
  const [refreshGuard] = useState(createRefreshGuard);
  const load = useCallback(async () => {
    if (!api) return;
    const token = refreshGuard.begin();
    try {
      const next = await loadOptions(api, pageCounts.current);
      if (!refreshGuard.isCurrent(token)) return;
      pageCounts.current = Object.fromEntries(next.filter((option) => option.pages)
        .map((option) => [option.scopeId, option.pages ?? 1]));
      setOptions(next);
      setSelected((current) => current && next.some((option) => option.scopeId === current)
        ? current : next[0]?.scopeId ?? null);
      setError(null);
    } catch (failure: unknown) {
      console.warn("[organization-drive] listing unavailable", failure instanceof Error ? failure.name : "UnknownError");
      if (refreshGuard.isCurrent(token)) setError(safeError(failure));
    } finally { refreshGuard.finish(token); setLoading(false); }
  }, [api, refreshGuard]);
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- current organization shares and scope sessions are browser identity state.
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!api || !selected) return;
    const unsubscribe = api.subscribe?.(selected, () => load(), () => setError("Organization drive is unavailable. Try again."));
    const timer = setInterval(() => { void load(); }, 30_000);
    return () => { unsubscribe?.(); clearInterval(timer); };
  }, [api, selected, load]);
  const active = options.find((option) => option.scopeId === selected);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); await load(); }
    catch (failure: unknown) {
      console.warn("[organization-drive] action failed", failure instanceof Error ? failure.name : "UnknownError");
      setError(safeError(failure));
    } finally { setBusy(false); }
  };

  const activate = (option: DriveOption) => run(async () => {
    if (!api || !option.grantId) return;
    await api.direct.request(option.scopeId, "POST",
      `/api/collaboration/scopes/${option.scopeId}/grants/${option.grantId}/accept`, {});
  });

  const enable = (option: DriveOption) => run(async () => {
    if (!api) return;
    const path = base(option.scopeId);
    await api.direct.request(option.scopeId, "PUT", path, {});
    await ensureContributorGrant(api, option.scopeId);
  });

  const share = (option: DriveOption) => run(async () => {
    if (!api) return;
    await ensureContributorGrant(api, option.scopeId);
  });

  async function ensureContributorGrant(api: CollaborationDirectApi, scopeId: string) {
    const scope = CollaborationScopeSchema.parse(await api.direct.request(scopeId, "GET",
      `/api/collaboration/scopes/${scopeId}`));
    const grants = GrantsSchema.parse(await api.direct.request(scopeId, "GET",
      `/api/collaboration/scopes/${scopeId}/grants`));
    const activeGrant = grants.find((grant) => grant.audience.kind === "organization"
      && grant.state !== "revoked" && grant.state !== "expired");
    if (activeGrant?.preset === "viewer") {
      await api.direct.request(scopeId, "PATCH", `/api/collaboration/scopes/${scopeId}/grants/${activeGrant.id}`, {
        clientRequestId: crypto.randomUUID(), expectedRevision: scope.revision,
        expectedGrantRevision: activeGrant.revision, preset: "contributor",
      });
    } else if (!activeGrant) {
      await api.direct.request(scopeId, "POST", `/api/collaboration/scopes/${scopeId}/grants`, {
        clientRequestId: crypto.randomUUID(), expectedRevision: scope.revision,
        audience: { kind: "organization" }, preset: "contributor",
      });
    }
  }

  const upload = (option: DriveOption, file: File) => run(async () => {
    if (!api) return;
    if (file.size > 100 * 1024 * 1024) throw new Error("FileTooLarge");
    const bytes = await file.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((value) => value.toString(16).padStart(2, "0")).join("");
    const path = folder.trim() ? `${folder.trim().replace(/\/$/, "")}/${file.name}` : file.name;
    const baseVersion = option.snapshot?.files.find((entry) => entry.path === path)?.version ?? 0;
    const reservation = OrganizationDriveUploadReservationSchema.parse(await api.direct.request(option.scopeId,
      "POST", `${base(option.scopeId)}/uploads`, { path, size: file.size, sha256: digest,
        requestId: crypto.randomUUID(), baseVersion }));
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

  const download = (option: DriveOption, file: OrganizationDriveFile) => run(async () => {
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

  const loadMore = async (option: DriveOption) => {
    const cursor = option.snapshot?.nextCursor;
    if (!api || !cursor || busy) return;
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
    {error && <p role="alert" className="mb-3 text-destructive">{error}</p>}
    {loading ? <p>Loading drives…</p> : options.length === 0
      ? <p className="text-muted-foreground">Share a folder with your organization to make a drive available here.</p>
      : <div className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row">
        <nav aria-label="Organization drives" className="w-full shrink-0 space-y-1 border-b pb-2 sm:w-48 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-3">
          {options.map((option) => <button type="button" key={option.scopeId}
            aria-current={selected === option.scopeId ? "page" : undefined}
            onClick={() => setSelected(option.scopeId)}
            className="w-full rounded px-2 py-2 text-left hover:bg-accent aria-[current=page]:bg-accent">
            {option.name}
          </button>)}
        </nav>
        {active && <div className="min-w-0 flex-1 overflow-auto">
          <h3 className="mb-2 font-medium">{active.name}</h3>
          {active.state === "pending" && <button type="button" disabled={busy} onClick={() => void activate(active)}
            className="rounded border px-3 py-1.5">Open organization share</button>}
          {active.state === "enable" && <button type="button" disabled={busy} onClick={() => void enable(active)}
            className="rounded border px-3 py-1.5">Enable drive for organization</button>}
          {active.snapshot && <>
            {active.canManage && <button type="button" disabled={busy} onClick={() => void share(active)}
              className="mb-3 rounded border px-3 py-1.5">Ensure organization can upload</button>}
            <p className="mb-3 text-xs text-muted-foreground">
              {(active.snapshot.usedBytes / 1_000_000_000).toFixed(2)} GB of {(active.snapshot.quotaBytes / 1_000_000_000_000).toFixed(1)} TB used
            </p>
            <label className="mb-3 block text-xs">Folder path (optional)
              <input type="text" value={folder} onChange={(event) => setFolder(event.target.value)}
                maxLength={700} placeholder="reports/2026" disabled={busy}
                className="mt-1 block w-full max-w-xs rounded border bg-background px-2 py-1.5" />
            </label>
            <label className="mb-4 inline-flex cursor-pointer rounded border px-3 py-1.5">
              {busy ? "Transferring…" : "Upload file"}
              <input type="file" className="sr-only" disabled={busy} onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void upload(active, file);
              }} />
            </label>
            <ul className="divide-y">
              {active.snapshot.files.map((file) => <li key={file.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate">{file.path}</span>
                <button type="button" disabled={busy} onClick={() => void download(active, file)}
                  className="rounded border px-2 py-1">Download</button>
              </li>)}
            </ul>
            {active.snapshot.nextCursor && <button type="button" disabled={busy}
              onClick={() => void loadMore(active)} className="mt-3 rounded border px-3 py-1.5">Load more files</button>}
            {active.snapshot.files.length === 0 && <p className="text-muted-foreground">No files yet.</p>}
          </>}
        </div>}
      </div>}
  </div>;
}
