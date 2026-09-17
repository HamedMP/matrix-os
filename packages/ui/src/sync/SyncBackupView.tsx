import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DesktopSyncMappingSetupRequestSchema,
  DesktopSyncSnapshot,
} from "@matrix-os/contracts";
import type { z } from "zod/v4";
import { Badge } from "../Badge.js";
import { Button } from "../Button.js";
import { Dialog } from "../Dialog.js";
import { DialogFooter } from "../DialogFooter.js";
import { DialogTitle } from "../DialogTitle.js";
import { Input } from "../Input.js";

type MappingSetup = z.infer<typeof DesktopSyncMappingSetupRequestSchema>;

export interface SyncBackupTransport {
  localFolderSync: boolean;
  getSnapshot(): Promise<DesktopSyncSnapshot>;
  reauthorize?(): Promise<DesktopSyncSnapshot>;
  chooseFolder?(suggestedName?: string): Promise<{ selectionId: string; displayPath: string } | null>;
  enable?(request: MappingSetup): Promise<DesktopSyncSnapshot>;
  addMapping?(request: MappingSetup): Promise<DesktopSyncSnapshot>;
  pauseMapping?(mappingId: string): Promise<DesktopSyncSnapshot>;
  resumeMapping?(mappingId: string): Promise<DesktopSyncSnapshot>;
  removeMapping?(mappingId: string): Promise<DesktopSyncSnapshot>;
  rescan?(mappingId?: string): Promise<DesktopSyncSnapshot>;
  setEnabled?(enabled: boolean): Promise<DesktopSyncSnapshot>;
  openDesktop?(): void;
}

export interface SyncBackupViewProps {
  transport: SyncBackupTransport;
  title?: string;
  description?: string;
}

const STATUS_LABEL: Record<DesktopSyncSnapshot["status"], string> = {
  not_configured: "Not configured",
  paused: "Paused",
  offline: "Offline",
  syncing: "Syncing",
  synced: "Up to date",
  conflict: "Needs attention",
  error: "Error",
  unavailable: "Unavailable",
};

const CONNECTION_LABEL: Record<DesktopSyncSnapshot["connection"], string> = {
  connecting: "Connecting",
  online: "Online",
  offline: "Offline",
  unknown: "Unknown",
};

const ISSUE_LABEL = {
  permission: "Matrix cannot read or write part of this folder. Review its file permissions.",
  disk_full: "This disk does not have enough free space to continue syncing.",
  oversized: "At least one file is larger than the current sync limit.",
  network: "The last folder operation could not reach Matrix. Sync will retry.",
  unknown: "The last folder operation failed. Rescan after checking the folder.",
} as const;

function capabilityMessage(snapshot: DesktopSyncSnapshot, localFolderSync: boolean): string {
  if (!localFolderSync || snapshot.capability === "unsupported_platform") {
    return "Folder sync on this computer requires Matrix Desktop. Backup health remains available here.";
  }
  if (snapshot.capability === "helper_incompatible") {
    return "This sync helper is not compatible with this Matrix Desktop version. Update Matrix Desktop to continue.";
  }
  if (snapshot.capability === "helper_invalid") {
    return "The packaged sync helper could not be verified. Reinstall Matrix Desktop before enabling folder sync.";
  }
  return "The sync helper is unavailable. Update or reinstall Matrix Desktop, then try again.";
}

function statusVariant(status: DesktopSyncSnapshot["status"]): "default" | "success" | "warning" | "error" {
  if (status === "synced") return "success";
  if (status === "conflict" || status === "offline" || status === "paused") return "warning";
  if (status === "error" || status === "unavailable") return "error";
  return "default";
}

function formatTime(value: number | null): string {
  if (!value) return "Not yet";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function suggestedRemotePrefix(displayPath: string): string {
  const leaf = displayPath.split(/[\\/]+/).filter(Boolean).at(-1)?.trim();
  if (!leaf || leaf === "." || leaf === "..") return "projects/";
  return `projects/${leaf}`;
}

function SyncGlyph({ kind }: { kind: "computer" | "folder" | "database" }) {
  if (kind === "folder") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-15v-13Z" /></svg>;
  }
  if (kind === "database") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>;
}

function SetupDialog({
  open,
  selection,
  initialRemotePrefix,
  runtimeSlot,
  busy,
  onChoose,
  onClose,
  onSubmit,
}: {
  open: boolean;
  selection: { selectionId: string; displayPath: string } | null;
  initialRemotePrefix: string;
  runtimeSlot: string | null;
  busy: boolean;
  onChoose: () => Promise<unknown>;
  onClose: () => void;
  onSubmit: (values: Omit<MappingSetup, "selectionId">) => Promise<void>;
}) {
  const [remotePrefix, setRemotePrefix] = useState(initialRemotePrefix);
  const [direction, setDirection] = useState<MappingSetup["direction"]>("two_way");
  const [propagateDeletes, setPropagateDeletes] = useState(false);

  useEffect(() => {
    if (open) {
      setRemotePrefix(initialRemotePrefix);
      setDirection("two_way");
      setPropagateDeletes(false);
    }
  }, [initialRemotePrefix, open]);

  return (
    <Dialog open={open} onClose={onClose} aria-label="Set up synced folder">
      <DialogTitle>Set up synced folder</DialogTitle>
      <div className="matrix-sync-form">
        <div>
          <span className="matrix-sync-label">Folder on this computer</span>
          <button type="button" className="matrix-sync-folder-choice" onClick={() => void onChoose()} disabled={busy}>
            <SyncGlyph kind="folder" />
            <span>{selection?.displayPath ?? "Choose a folder"}</span>
          </button>
        </div>
        <Input
          label="Folder on Matrix"
          value={remotePrefix}
          placeholder="Matrix Home"
          onChange={(event) => setRemotePrefix(event.target.value.replace(/^\/+/, ""))}
        />
        <label className="matrix-sync-field">
          <span className="matrix-sync-label">Direction</span>
          <select value={direction} onChange={(event) => setDirection(event.target.value as MappingSetup["direction"])}>
            <option value="two_way">Two-way</option>
            <option value="to_matrix">To Matrix</option>
            <option value="to_local">To this computer</option>
          </select>
        </label>
        <label className="matrix-sync-check">
          <input type="checkbox" checked={propagateDeletes} onChange={(event) => setPropagateDeletes(event.target.checked)} />
          <span>Propagate confirmed deletions</span>
        </label>
        <p className="matrix-sync-hint">Deletion propagation is off by default. Removing this mapping never deletes either folder.</p>
        <div className="matrix-sync-preview" aria-label="Sync preview">
          <strong>Preview</strong>
          <span>{selection?.displayPath ?? "Choose a local folder"}</span>
          <span>↔ Matrix {remotePrefix ? `/${remotePrefix.replace(/^\/+|\/+$/g, "")}` : "Home"}</span>
          <span>{runtimeSlot ?? "Selected Matrix computer"} · {direction.replaceAll("_", " ")}</span>
          <small>Eligible files only. Credentials, sync internals, symlinks, and configured exclusions are not copied.</small>
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button
          onClick={() => void onSubmit({
            remotePrefix: remotePrefix.replace(/^\/+|\/+$/g, ""),
            direction,
            propagateDeletes,
            excludes: [],
          })}
          disabled={busy || !selection}
        >
          {busy ? "Saving…" : "Enable sync"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export function SyncBackupView({
  transport,
  title = "Sync & backup",
  description = "Keep eligible Matrix Home files in sync and monitor database recovery copies.",
}: SyncBackupViewProps) {
  const [snapshot, setSnapshot] = useState<DesktopSyncSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupMode, setSetupMode] = useState<"enable" | "add">("enable");
  const [selection, setSelection] = useState<{ selectionId: string; displayPath: string } | null>(null);
  const [remotePrefix, setRemotePrefix] = useState("");
  const setupTriggerRef = useRef<HTMLButtonElement | null>(null);
  const setupWasOpenRef = useRef(false);

  const refresh = useCallback(async (preserveError = false) => {
    try {
      setSnapshot(await transport.getSnapshot());
      if (!preserveError) setError(null);
    } catch {
      if (!preserveError) setError("Sync status could not be refreshed. Try again.");
    } finally {
      setLoading(false);
    }
  }, [transport]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (setupOpen) {
      setupWasOpenRef.current = true;
      return;
    }
    if (setupWasOpenRef.current) {
      setupWasOpenRef.current = false;
      setupTriggerRef.current?.focus();
    }
  }, [setupOpen]);

  const chooseFolder = async () => {
    if (!transport.chooseFolder) return null;
    const chosen = await transport.chooseFolder("Matrix");
    if (chosen) setSelection(chosen);
    return chosen;
  };

  const beginLocalFirst = async (
    mode: "enable" | "add",
    trigger: HTMLButtonElement,
  ) => {
    setupTriggerRef.current = trigger;
    setSetupMode(mode);
    setRemotePrefix("");
    setSelection(null);
    setError(null);
    setSetupOpen(true);
    try {
      const chosen = await chooseFolder();
      if (mode === "add" && chosen) setRemotePrefix(suggestedRemotePrefix(chosen.displayPath));
    } catch {
      setError("That folder could not be selected. Choose another folder.");
    }
  };

  const beginMatrixFirst = (trigger: HTMLButtonElement) => {
    setupTriggerRef.current = trigger;
    setSetupMode("add");
    setRemotePrefix("projects/");
    setSelection(null);
    setError(null);
    setSetupOpen(true);
  };

  const submitSetup = async (values: Omit<MappingSetup, "selectionId">) => {
    if (!selection) return;
    const action = setupMode === "enable" ? transport.enable : transport.addMapping;
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      const next = await action({ ...values, selectionId: selection.selectionId });
      setSnapshot(next);
      setSetupOpen(false);
      setSelection(null);
    } catch {
      setError("The synced folder was not changed. Review the paths and try again.");
      await refresh(true);
    } finally {
      setBusy(false);
    }
  };

  const mutate = async (action: () => Promise<DesktopSyncSnapshot>) => {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await action());
    } catch {
      setError("The sync change did not complete. Your folders were left unchanged.");
      await refresh(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="matrix-sync-view" aria-labelledby="matrix-sync-title" aria-busy={loading}>
      <header className="matrix-sync-heading">
        <h2 id="matrix-sync-title">{title}</h2>
        <p>{description}</p>
      </header>
      {error ? <p className="matrix-sync-error" role="alert">{error}</p> : null}
      {loading && !snapshot ? <div className="matrix-sync-loading" role="status">Loading sync status…</div> : null}

      {snapshot ? (
        <>
          <div className="matrix-sync-panel">
            <div className="matrix-sync-panel-title">
              <span className="matrix-sync-glyph"><SyncGlyph kind="computer" /></span>
              <div><h3>This computer</h3><p>Sync runs in the background after Matrix Desktop closes.</p></div>
              <Badge variant={statusVariant(snapshot.status)}>{STATUS_LABEL[snapshot.status]}</Badge>
            </div>
            {!transport.localFolderSync || snapshot.capability !== "available" ? (
              <div className="matrix-sync-callout">
                <p>{capabilityMessage(snapshot, transport.localFolderSync)}</p>
                {transport.openDesktop ? <Button onClick={transport.openDesktop}>Open Matrix Desktop</Button> : null}
              </div>
            ) : snapshot.auth === "needs_sign_in" ? (
              <div className="matrix-sync-callout">
                <p><strong>Reconnect required</strong><br />Your background sync credential expired or was revoked. Reconnect it from this signed-in Desktop session.</p>
                <Button
                  disabled={busy || !transport.reauthorize}
                  onClick={() => transport.reauthorize && void mutate(transport.reauthorize)}
                >Reconnect sync</Button>
              </div>
            ) : snapshot.mappings.length === 0 ? (
              <div className="matrix-sync-empty">
                <p><strong>No folders are synced yet.</strong><br />Start with Matrix Home and choose where its eligible files live on this computer.</p>
                <Button onClick={(event) => void beginLocalFirst("enable", event.currentTarget)}>Enable sync</Button>
              </div>
            ) : (
              <div className="matrix-sync-master-row">
                <div><strong>{snapshot.enabled && !snapshot.paused ? "Sync is on" : "Sync is paused"}</strong><span>{snapshot.runtimeSlot ?? "Selected Matrix computer"}</span></div>
                <Button
                  variant="secondary"
                  disabled={busy || !transport.setEnabled}
                  onClick={() => transport.setEnabled && void mutate(() => transport.setEnabled!(!snapshot.enabled || snapshot.paused))}
                >
                  {snapshot.enabled && !snapshot.paused ? "Pause" : "Resume"}
                </Button>
              </div>
            )}
            <dl className="matrix-sync-runtime-facts">
              <div><dt>Connection</dt><dd>{CONNECTION_LABEL[snapshot.connection]}</dd></div>
              <div><dt>Activity</dt><dd>{snapshot.activeTransferCount} active {snapshot.activeTransferCount === 1 ? "transfer" : "transfers"}</dd></div>
              <div><dt>Conflicts</dt><dd>{snapshot.conflictCount} {snapshot.conflictCount === 1 ? "conflict" : "conflicts"}</dd></div>
              <div><dt>Last sync</dt><dd>{formatTime(snapshot.lastSyncAt)}</dd></div>
            </dl>
          </div>

          {snapshot.remoteStatus !== undefined ? (
            <div className="matrix-sync-panel">
              <div className="matrix-sync-panel-title">
                <span className="matrix-sync-glyph"><SyncGlyph kind="folder" /></span>
                <div><h3>Matrix computer</h3><p>Remote file-sync health for the selected Matrix runtime.</p></div>
                <Badge variant={snapshot.remoteStatus
                  ? snapshot.remoteStatus.pendingConflicts > 0 ? "warning" : "success"
                  : "warning"}
                >{snapshot.remoteStatus ? "Available" : "Unavailable"}</Badge>
              </div>
              {snapshot.remoteStatus ? (
                <dl className="matrix-sync-facts">
                  <div><dt>Eligible files</dt><dd>{snapshot.remoteStatus.fileCount.toLocaleString()}</dd></div>
                  <div><dt>Pending conflicts</dt><dd>{snapshot.remoteStatus.pendingConflicts.toLocaleString()}</dd></div>
                  <div><dt>Connected sync clients</dt><dd>{snapshot.remoteStatus.connectedPeerCount.toLocaleString()}</dd></div>
                  <div><dt>Last remote sync</dt><dd>{formatTime(snapshot.remoteStatus.lastSyncAt)}</dd></div>
                </dl>
              ) : <p className="matrix-sync-hint">Remote file-sync health could not be loaded.</p>}
            </div>
          ) : null}

          <div className="matrix-sync-panel">
            <div className="matrix-sync-panel-title">
              <span className="matrix-sync-glyph"><SyncGlyph kind="folder" /></span>
              <div><h3>Synced folders</h3><p>Each association keeps both folders and can be paused or removed safely.</p></div>
            </div>
            {snapshot.mappings.length > 0 ? (
              <div className="matrix-sync-list">
                {snapshot.mappings.map((mapping) => (
                  <div className="matrix-sync-row" key={mapping.id}>
                    <div className="matrix-sync-row-main">
                      <strong>{mapping.label}</strong>
                      <span title={mapping.localRoot}>{mapping.localRoot}</span>
                      <span>Matrix {mapping.remotePrefix ? `/${mapping.remotePrefix}` : "Home"} · {mapping.direction.replaceAll("_", " ")}</span>
                      <span>{mapping.excludes.length === 0
                        ? "No configured exclusions"
                        : `${mapping.excludes.length} configured ${mapping.excludes.length === 1 ? "exclusion" : "exclusions"}`}</span>
                      {mapping.lastIssue ? <span className="matrix-sync-row-issue">{ISSUE_LABEL[mapping.lastIssue]}</span> : null}
                    </div>
                    <div className="matrix-sync-row-meta">
                      <Badge variant={mapping.conflictCount ? "warning" : mapping.state === "error" || mapping.lastIssue ? "error" : "default"}>
                        {mapping.conflictCount ? `${mapping.conflictCount} conflicts` : mapping.state}
                      </Badge>
                      <span>{formatTime(mapping.lastSuccessfulReconcileAt)}</span>
                    </div>
                    <div className="matrix-sync-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || !transport.rescan}
                        onClick={() => transport.rescan && void mutate(() => transport.rescan!(mapping.id))}
                      >Rescan</Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy || (mapping.enabled ? !transport.pauseMapping : !transport.resumeMapping)}
                        onClick={() => {
                          const action = mapping.enabled ? transport.pauseMapping : transport.resumeMapping;
                          if (action) void mutate(() => action(mapping.id));
                        }}
                      >{mapping.enabled ? "Pause" : "Resume"}</Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || !transport.removeMapping}
                        onClick={() => transport.removeMapping && void mutate(() => transport.removeMapping!(mapping.id))}
                      >Remove</Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : <p className="matrix-sync-hint">No local folder associations on this computer.</p>}
            {transport.localFolderSync && snapshot.mappings.length > 0 ? (
              <div className="matrix-sync-add-actions">
                <Button variant="secondary" onClick={(event) => void beginLocalFirst("add", event.currentTarget)}>Folder on this computer</Button>
                <Button variant="ghost" onClick={(event) => beginMatrixFirst(event.currentTarget)}>Folder on Matrix</Button>
              </div>
            ) : null}
          </div>

          <div className="matrix-sync-panel">
            <div className="matrix-sync-panel-title">
              <span className="matrix-sync-glyph"><SyncGlyph kind="database" /></span>
              <div><h3>Database backup</h3><p>Database recovery copies are separate from file sync and continue independently.</p></div>
              <Badge variant={snapshot.backup?.freshness === "healthy" ? "success" : snapshot.backup?.freshness === "critical" ? "error" : "warning"}>
                {snapshot.backup?.freshness ?? snapshot.backupState}
              </Badge>
            </div>
            <dl className="matrix-sync-facts">
              <div><dt>Latest verified backup</dt><dd>{formatTime(snapshot.backup?.lastSuccess?.completedAt ?? null)}</dd></div>
              <div><dt>Next scheduled run</dt><dd>{formatTime(snapshot.backup?.scheduler.nextDueAt ?? null)}</dd></div>
              <div><dt>Last restore test</dt><dd>{formatTime(snapshot.backup?.lastSuccess?.restoreVerifiedAt ?? null)}</dd></div>
              <div><dt>Scheduler</dt><dd>{snapshot.backup?.scheduler.active === true ? "Active" : snapshot.backup?.scheduler.active === false ? "Inactive" : "Unknown"}</dd></div>
              <div><dt>Last attempt</dt><dd>{snapshot.backup?.lastAttempt
                ? `${snapshot.backup.lastAttempt.outcome} · ${formatTime(snapshot.backup.lastAttempt.attemptedAt)}`
                : "Not yet"}</dd></div>
              <div><dt>Storage</dt><dd>{snapshot.backup?.storageReachability ?? "unknown"}</dd></div>
            </dl>
          </div>
        </>
      ) : null}

      <SetupDialog
        open={setupOpen}
        selection={selection}
        initialRemotePrefix={remotePrefix}
        runtimeSlot={snapshot?.runtimeSlot ?? null}
        busy={busy}
        onChoose={chooseFolder}
        onClose={() => { if (!busy) setSetupOpen(false); }}
        onSubmit={submitSetup}
      />
      <span className="matrix-sync-live" aria-live="polite">{busy ? "Applying sync change" : snapshot ? STATUS_LABEL[snapshot.status] : ""}</span>
    </section>
  );
}
