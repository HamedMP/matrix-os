import { OrganizationDriveSnapshotSchema } from "@matrix-os/contracts";
import {
  resolveOrganizationDriveNavigation, OrganizationDriveBrowser, createRefreshGuard,
  driveBasePath,
  ensureOrganizationContributorGrant,
  loadOrganizationDriveOptions,
  type OrganizationDriveOption,
  type OrganizationDrivePageCounts,
} from "@matrix-os/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/operator";
import { createDesktopCollaborationApi, releaseDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";

const button = "rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50";
const buttonStyle = { borderColor: "var(--border-default)", color: "var(--text-primary)" };

function message(error: unknown): string {
  if (error instanceof Error && error.message === "invalid_file") return "Choose a regular file of 100 MiB or less with a valid name.";
  if (error instanceof Error && error.message === "conflict") return "Another transfer is in progress. Try again.";
  console.warn("[organization-drive] Electron view failed", error instanceof Error ? error.name : "UnknownError");
  return "Organization drive is unavailable. Try again.";
}

export function DesktopOrganizationDrivesView({ isActive = true, requestedScopeId, requestedIntentId }: { isActive?: boolean; requestedScopeId?: string; requestedIntentId?: string }) {
  const platformHost = useConnection((state) => state.platformHost);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const [api, setApi] = useState<ReturnType<typeof createDesktopCollaborationApi>>(null);
  const [options, setOptions] = useState<OrganizationDriveOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const [folder, setFolder] = useState("");
  const appliedRequest = useRef<string | undefined>(undefined);
  useEffect(() => {
    if ((requestedIntentId ?? requestedScopeId) !== appliedRequest.current && requestedScopeId && options.some(option => option.scopeId === requestedScopeId)) {
      appliedRequest.current = requestedIntentId ?? requestedScopeId; setSelected(requestedScopeId); setFolder("");
    }
  }, [requestedScopeId, requestedIntentId, options]);
  const [error, setError] = useState<string | null>(null);
  const pageCounts = useRef<OrganizationDrivePageCounts>({});
  const [guard] = useState(createRefreshGuard);

  useEffect(() => {
    const created = createDesktopCollaborationApi(platformHost);
    setApi(created);
    return () => { if (created) releaseDesktopCollaborationApi(created); };
  }, [platformHost, runtimeSlot, authGeneration]);

  const load = useCallback(async () => {
    if (!api || !isActive) return;
    const token = guard.begin();
    try {
      const next = await loadOrganizationDriveOptions(api, pageCounts.current);
      if (!guard.isCurrent(token)) return;
      pageCounts.current = Object.fromEntries(next.filter((item) => item.pages)
        .map((item) => [item.scopeId, item.pages ?? 1]));
      setOptions(next);
      setSelected((current) => current ?? next[0]?.scopeId ?? null);
      setError(null);
    } catch (failure: unknown) {
      if (guard.isCurrent(token)) setError(message(failure));
    } finally { guard.finish(token); setLoading(false); }
  }, [isActive, api, guard]);

  useEffect(() => {
    if (!isActive) { guard.invalidate(); return; }
    void load();
    return () => { guard.invalidate(); };
  }, [isActive, api, guard, load]);
  useEffect(() => {
    if (!isActive || !api || !selected) return;
    const unsubscribe = api.subscribe?.(selected, () => load(), () => setError("Organization drive is unavailable. Try again."));
    const timer = setInterval(() => { void load(); }, 30_000);
    return () => { unsubscribe?.(); clearInterval(timer); };
  }, [isActive, api, selected, load]);

  const navigation = resolveOrganizationDriveNavigation(options.map(option => option.scopeId), selected,
    requestedScopeId ? {scopeId: requestedScopeId, intentId: requestedIntentId} : undefined, appliedRequest.current);
  const active = options.find(option => option.scopeId === navigation.scopeId);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); await load(); }
    catch (failure: unknown) { setError(message(failure)); }
    finally { setBusy(false); }
  };
  const activate = (option: OrganizationDriveOption) => run(async () => {
    if (!api || !option.grantId) return;
    await api.direct.request(option.scopeId, "POST",
      `/api/collaboration/scopes/${option.scopeId}/grants/${option.grantId}/accept`, {});
  });
  const enable = (option: OrganizationDriveOption) => run(async () => {
    if (!api) return;
    await api.direct.request(option.scopeId, "PUT", driveBasePath(option.scopeId), {});
    await ensureOrganizationContributorGrant(api, option.scopeId);
  });
  const share = (option: OrganizationDriveOption) => run(async () => {
    if (api) await ensureOrganizationContributorGrant(api, option.scopeId);
  });
  const upload = (option: OrganizationDriveOption) => run(async () => {
    setTransferBusy(true);
    try {
      const result = await invoke("runtime:organization-drive-upload", { scopeId: option.scopeId,
        organizationId: option.organizationId, folder, runtimeSlot, authGeneration });
      if (result.status === "error") throw new Error(result.code);
    } finally { setTransferBusy(false); }
  });
  const download = (option: OrganizationDriveOption, fileId: string) => run(async () => {
    setTransferBusy(true);
    try {
      const result = await invoke("runtime:organization-drive-download", { scopeId: option.scopeId,
        organizationId: option.organizationId, fileId, runtimeSlot, authGeneration });
      if (result.status === "error") throw new Error(result.code);
    } finally { setTransferBusy(false); }
  });
  const loadMore = async (option: OrganizationDriveOption) => {
    const cursor = option.snapshot?.nextCursor;
    if (!api || !cursor || busy || (option.pages ?? 1) >= 20) return;
    setBusy(true); setError(null);
    try {
      const page = OrganizationDriveSnapshotSchema.parse(await api.direct.request(option.scopeId, "GET",
        `${driveBasePath(option.scopeId)}?after=${encodeURIComponent(cursor)}`));
      const pages = (option.pages ?? 1) + 1;
      pageCounts.current = { ...pageCounts.current, [option.scopeId]: pages };
      const pending = guard.inFlight();
      guard.invalidate();
      setOptions((current) => current.map((item) => item.scopeId === option.scopeId && item.snapshot
        ? { ...item, pages, snapshot: { ...page, files: [...item.snapshot.files, ...page.files] } } : item));
      if (pending) void load();
    } catch (failure: unknown) { setError(message(failure)); }
    finally { setBusy(false); }
  };

  return <div className="flex min-h-0 flex-1 flex-col p-5 text-sm" style={{ color: "var(--text-primary)" }}>
    <div className="mb-4 flex items-center justify-between">
      <h2 className="text-base font-semibold">Organization drives</h2>
      <div className="flex gap-2">
        {transferBusy && <button type="button" className={button} style={buttonStyle}
          onClick={() => void invoke("runtime:organization-drive-cancel", {})}>Cancel transfer</button>}
        <button type="button" className={button} style={buttonStyle} disabled={busy} onClick={() => void load()}>Refresh</button>
      </div>
    </div>
    {!loading && navigation.unavailable ? <p role="alert" className="mb-3 text-xs">This drive is unavailable. Choose another drive or refresh.</p> : null}
    {error && <p role="alert" className="mb-3 text-xs" style={{ color: "var(--danger)" }}>{error}</p>}
    {loading ? <p style={{ color: "var(--text-tertiary)" }}>Loading drives…</p> : options.length === 0
      ? <p style={{ color: "var(--text-tertiary)" }}>Share a folder with your organization to make a drive available here.</p>
      : <div className="flex min-h-0 flex-1 gap-5">
        <nav aria-label="Organization drives" className="w-48 shrink-0 space-y-1 border-r pr-3" style={{ borderColor: "var(--border-subtle)" }}>
          {options.map((option) => <button key={option.scopeId} type="button" aria-current={navigation.scopeId === option.scopeId ? "page" : undefined}
            disabled={busy} onClick={() => { appliedRequest.current = requestedIntentId ?? requestedScopeId; setSelected(option.scopeId); setFolder(""); }} className="w-full rounded-md px-3 py-2 text-left text-xs hover:bg-[var(--bg-hover)]"
            style={{ background: navigation.scopeId === option.scopeId ? "var(--bg-hover)" : undefined }}>{option.name}</button>)}
        </nav>
        {active && <div className="min-w-0 flex-1 overflow-auto">

          {active.state === "pending" && <button type="button" className={button} style={buttonStyle} disabled={busy}
            onClick={() => void activate(active)}>Open organization share</button>}
          {active.state === "enable" && <button type="button" className={button} style={buttonStyle} disabled={busy}
            onClick={() => void enable(active)}>Enable drive for organization</button>}
          {active.snapshot && <>
            {active.canManage && <button type="button" className={`${button} mb-3`} style={buttonStyle} disabled={busy}
              onClick={() => void share(active)}>Allow organization uploads</button>}
            <OrganizationDriveBrowser key={active.scopeId} name={active.name} files={active.snapshot.files}
              usedBytes={active.snapshot.usedBytes} reservedBytes={active.snapshot.reservedBytes} quotaBytes={active.snapshot.quotaBytes}
              busy={busy} canUpload={Boolean(active.canUpload)} folder={folder} onFolderChange={setFolder}
              onDownload={file => void download(active, file.id)} hasMore={Boolean(active.snapshot.nextCursor)}
              pageLimitReached={(active.pages ?? 1) >= 20} onLoadMore={() => void loadMore(active)}
              uploadControl={<button type="button" className={button} style={buttonStyle} disabled={busy}
                onClick={() => void upload(active)}>{busy ? "Transferring…" : "Upload file"}</button>} />
          </>}
        </div>}
      </div>}
  </div>;
}
