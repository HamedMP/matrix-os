import { OrganizationDriveSnapshotSchema } from "@matrix-os/contracts";
import {
  createRefreshGuard,
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

export function DesktopOrganizationDrivesView({ isActive = true }: { isActive?: boolean }) {
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
      setSelected((current) => current && next.some((item) => item.scopeId === current)
        ? current : next[0]?.scopeId ?? null);
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
    return () => { unsubscribe?.(); clearInterval(timer); api.direct.close(selected); };
  }, [isActive, api, selected, load]);

  const active = options.find((item) => item.scopeId === selected);
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
    if (!api || !cursor || busy) return;
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
    {error && <p role="alert" className="mb-3 text-xs" style={{ color: "var(--danger)" }}>{error}</p>}
    {loading ? <p style={{ color: "var(--text-tertiary)" }}>Loading drives…</p> : options.length === 0
      ? <p style={{ color: "var(--text-tertiary)" }}>Share a folder with your organization to make a drive available here.</p>
      : <div className="flex min-h-0 flex-1 gap-5">
        <nav aria-label="Organization drives" className="w-48 shrink-0 space-y-1 border-r pr-3" style={{ borderColor: "var(--border-subtle)" }}>
          {options.map((option) => <button key={option.scopeId} type="button" aria-current={selected === option.scopeId ? "page" : undefined}
            onClick={() => setSelected(option.scopeId)} className="w-full rounded-md px-3 py-2 text-left text-xs hover:bg-[var(--bg-hover)]"
            style={{ background: selected === option.scopeId ? "var(--bg-hover)" : undefined }}>{option.name}</button>)}
        </nav>
        {active && <div className="min-w-0 flex-1 overflow-auto">
          <h3 className="mb-3 font-medium">{active.name}</h3>
          {active.state === "pending" && <button type="button" className={button} style={buttonStyle} disabled={busy}
            onClick={() => void activate(active)}>Open organization share</button>}
          {active.state === "enable" && <button type="button" className={button} style={buttonStyle} disabled={busy}
            onClick={() => void enable(active)}>Enable drive for organization</button>}
          {active.snapshot && <>
            {active.canManage && <button type="button" className={`${button} mb-3`} style={buttonStyle} disabled={busy}
              onClick={() => void share(active)}>Ensure organization can upload</button>}
            <p className="mb-3 text-xs" style={{ color: "var(--text-tertiary)" }}>
              {(active.snapshot.usedBytes / 1_000_000_000).toFixed(2)} GB of {(active.snapshot.quotaBytes / 1_000_000_000_000).toFixed(1)} TB used
            </p>
            <label className="mb-3 block text-xs">Folder path (optional)
              <input type="text" value={folder} maxLength={700} disabled={busy} placeholder="reports/2026"
                onChange={(event) => setFolder(event.target.value)} className="mt-1 block w-full max-w-xs rounded-md border px-2 py-1.5"
                style={{ borderColor: "var(--border-default)", background: "var(--bg-surface)" }} />
            </label>
            {active.canUpload && <button type="button" className={`${button} mb-4`} style={buttonStyle} disabled={busy}
              onClick={() => void upload(active)}>{busy ? "Transferring…" : "Upload file"}</button>}
            <ul className="divide-y" style={{ borderColor: "var(--border-subtle)" }}>
              {active.snapshot.files.map((file) => <li key={file.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate text-xs">{file.path}</span>
                <button type="button" className={button} style={buttonStyle} disabled={busy}
                  onClick={() => void download(active, file.id)}>Download</button>
              </li>)}
            </ul>
            {active.snapshot.nextCursor && <button type="button" className={`${button} mt-3`} style={buttonStyle} disabled={busy}
              onClick={() => void loadMore(active)}>Load more files</button>}
            {active.snapshot.files.length === 0 && <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>No files yet.</p>}
          </>}
        </div>}
      </div>}
  </div>;
}
