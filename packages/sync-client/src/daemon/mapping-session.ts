import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { SyncMapping, SyncMappingIssue } from "@matrix-os/contracts/sync";
import { isIgnored, loadSyncIgnore, type SyncIgnorePatterns } from "../lib/syncignore.js";
import { FileWatcher, type WatcherEvent } from "./watcher.js";
import { loadSyncState, saveSyncState } from "./manifest-cache.js";
import { createRemotePrefixMapper } from "./remote-prefix.js";
import {
  buildUnresolvedConflictCopyPathIndex,
  capLoadedSyncState,
  capSyncStateFiles,
  hasUnresolvedConflictCopyPath,
  reconcileMissingConflictCopies,
  reconcileRemoteDelete,
  reconcileRemoteFileChange,
  resolveConflictCopyPath,
  shouldCommitWatcherDelete,
  shouldSkipWatcherUpload,
  type ConflictCopyPathIndex,
} from "./reconciliation.js";
import {
  AuthRejectedError,
  VersionConflictError,
  commitFiles,
  downloadFile,
  requestPresignedUrls,
  uploadFile,
  type GatewayClient,
} from "./r2-client.js";
import type {
  ManifestEntry,
  SyncChangeEvent,
  SyncState,
} from "./types.js";

export interface ScopeRevision {
  value: number;
}

export interface MappingSessionLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface MappingSessionOptions {
  mapping: SyncMapping;
  stateFile: string;
  gatewayClient: GatewayClient;
  revision: ScopeRevision;
  logger: MappingSessionLogger;
  enqueue: <T>(fn: () => Promise<T>) => Promise<T>;
  onAuthRejected: (err: AuthRejectedError) => void;
}

export interface MappingSessionStatus {
  mappingId: string;
  state: "paused" | "idle" | "conflict" | "error";
  fileCount: number;
  conflictCount: number;
  lastSuccessfulReconcileAt: number | null;
  lastIssue: SyncMappingIssue | null;
}

export function classifyMappingIssue(err: unknown): SyncMappingIssue {
  const code = err instanceof Error && "code" in err
    ? String((err as NodeJS.ErrnoException).code ?? "").toUpperCase()
    : "";
  const message = err instanceof Error ? err.message.toLowerCase() : "";
  if (["EACCES", "EPERM", "EROFS"].includes(code)) return "permission";
  if (["ENOSPC", "EDQUOT"].includes(code)) return "disk_full";
  if (code === "EFBIG" || /(?:too large|exceeded .*bytes|failed: 413)/.test(message)) {
    return "oversized";
  }
  if (["ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT"].includes(code)) {
    return "network";
  }
  return "unknown";
}

export function mappingCapabilities(mapping: SyncMapping): {
  upload: boolean;
  download: boolean;
} {
  return {
    upload: mapping.direction === "two_way" || mapping.direction === "to_matrix",
    download: mapping.direction === "two_way" || mapping.direction === "to_local",
  };
}

export class MappingSession {
  private readonly mapper;
  private readonly capabilities;
  private readonly watcher: FileWatcher;
  private state: SyncState;
  private conflictCopyPathIndex: ConflictCopyPathIndex;
  private lastIssue: SyncMappingIssue | null = null;

  private constructor(
    private readonly options: MappingSessionOptions,
    state: SyncState,
    watcher: FileWatcher,
    private readonly ignorePatterns: SyncIgnorePatterns,
  ) {
    this.state = state;
    this.watcher = watcher;
    this.mapper = createRemotePrefixMapper(options.mapping.remotePrefix);
    this.capabilities = mappingCapabilities(options.mapping);
    this.conflictCopyPathIndex = buildUnresolvedConflictCopyPathIndex(state);
  }

  static async open(options: MappingSessionOptions): Promise<MappingSession> {
    const ignorePatterns = await loadSyncIgnore(options.mapping.localRoot);
    for (const exclusion of options.mapping.excludes) {
      if (!ignorePatterns.patterns.includes(exclusion)) {
        ignorePatterns.patterns.push(exclusion);
      }
    }
    const state = await loadSyncState(options.stateFile);
    if (capLoadedSyncState(state)) await saveSyncState(options.stateFile, state);
    let session!: MappingSession;
    const watcher = new FileWatcher({
      syncRoot: options.mapping.localRoot,
      ignorePatterns,
      onError: (err) => {
        session.recordWatcherError(err);
        options.logger.error({ err, mappingId: options.mapping.id }, "Watcher event handling failed");
      },
      onEvent: (event) => options.enqueue(() => session.handleWatcherEvent(event)),
    });
    session = new MappingSession(options, state, watcher, ignorePatterns);
    return session;
  }

  get mapping(): SyncMapping {
    return this.options.mapping;
  }

  get syncState(): SyncState {
    return this.state;
  }

  status(): MappingSessionStatus {
    const conflictCount = this.conflicts().length;
    return {
      mappingId: this.mapping.id,
      state: !this.mapping.enabled
        ? "paused"
        : this.lastIssue
          ? "error"
          : conflictCount > 0
            ? "conflict"
            : "idle",
      fileCount: Object.keys(this.state.files).length,
      conflictCount,
      lastSuccessfulReconcileAt: this.state.lastSyncAt || null,
      lastIssue: this.lastIssue,
    };
  }

  conflicts(): unknown[] {
    return Object.values(this.state.conflicts ?? {}).filter((conflict) => !conflict.resolved);
  }

  async start(remoteFiles: Record<string, ManifestEntry>): Promise<void> {
    if (!this.mapping.enabled) return;
    if (await reconcileMissingConflictCopies(this.state, {
      syncRoot: this.mapping.localRoot,
      toLocalPath: this.mapper.toLocal,
    })) {
      await this.save();
    }
    if (this.capabilities.download) await this.pull(remoteFiles);
    if (this.capabilities.upload) this.watcher.start();
  }

  async stop(): Promise<void> {
    await this.watcher.stop();
  }

  async rescan(remoteFiles: Record<string, ManifestEntry>): Promise<void> {
    if (this.capabilities.download) await this.pull(remoteFiles);
  }

  async applyRemoteEvent(event: SyncChangeEvent): Promise<boolean> {
    if (!this.mapping.enabled || !this.capabilities.download) return true;
    let complete = true;
    for (const file of event.files) {
      const localRel = this.mapper.toLocal(file.path);
      if (!localRel) continue;
      if (isIgnored(localRel, this.ignorePatterns)) continue;
      try {
        if (file.action === "delete") {
          if (!this.mapping.propagateDeletes) {
            const entry = this.state.files[file.path];
            if (entry) entry.retainedDeletion = "remote";
            await this.save();
            continue;
          }
          await reconcileRemoteDelete(this.state, {
            syncRoot: this.mapping.localRoot,
            localRel,
            remotePath: file.path,
            remoteHash: file.hash,
            remotePeerId: event.peerId,
            toRemotePath: this.mapper.toRemote,
          });
        } else {
          const entry = this.state.files[file.path];
          if (entry?.retainedDeletion === "local" && entry.lastSyncedHash === file.hash) {
            continue;
          }
          const urls = await requestPresignedUrls(this.options.gatewayClient, [{
            path: file.path,
            action: "get",
          }]);
          if (!urls[0]) {
            complete = false;
            continue;
          }
          await reconcileRemoteFileChange(this.state, {
            syncRoot: this.mapping.localRoot,
            localRel,
            remotePath: file.path,
            remoteHash: file.hash,
            remoteSize: file.size,
            remotePeerId: event.peerId,
            toRemotePath: this.mapper.toRemote,
            downloadRemote: (targetPath) => downloadFile(urls[0]!.url, targetPath, file.hash, {
              expectedSize: file.size,
              maxBytes: file.size,
            }),
          });
        }
        this.refreshConflictIndex();
        await this.save();
        this.lastIssue = null;
      } catch (err: unknown) {
        complete = false;
        this.handleError(err, file.path, "Remote mapping apply failed");
      }
    }
    if (complete && event.manifestVersion !== undefined) {
      this.options.revision.value = Math.max(this.options.revision.value, event.manifestVersion);
      this.state.manifestVersion = this.options.revision.value;
      await this.save();
      this.lastIssue = null;
    }
    return complete;
  }

  private async handleWatcherEvent(event: WatcherEvent): Promise<void> {
    if (!this.mapping.enabled || !this.capabilities.upload) return;
    const remotePath = this.mapper.toRemote(event.path);
    const conflictCopy = hasUnresolvedConflictCopyPath(this.conflictCopyPathIndex, remotePath);
    if (event.type === "unlink") {
      const entry = this.state.files[remotePath];
      if (!this.mapping.propagateDeletes) {
        if (entry) {
          entry.retainedDeletion = "local";
          await this.save();
        }
        return;
      }
      if (!shouldCommitWatcherDelete(entry, conflictCopy)) {
        if (entry?.localOnly || conflictCopy) {
          delete this.state.files[remotePath];
          if (conflictCopy) resolveConflictCopyPath(this.state, this.conflictCopyPathIndex, remotePath);
          await this.save();
        }
        return;
      }
      try {
        const result = await commitFiles(this.options.gatewayClient, [{
          path: remotePath,
          hash: entry.hash,
          size: 0,
          action: "delete",
        }], this.options.revision.value);
        delete this.state.files[remotePath];
        this.setRevision(result.manifestVersion);
        await this.save();
        this.lastIssue = null;
      } catch (err: unknown) {
        await this.adoptConflictRevision(err);
        this.handleError(err, remotePath, "Delete commit failed");
      }
      return;
    }

    const existing = this.state.files[remotePath];
    if (shouldSkipWatcherUpload(existing, event.hash, conflictCopy)) {
      if (existing) {
        existing.hash = event.hash;
        existing.mtime = event.mtime;
        existing.size = event.size;
        delete existing.retainedDeletion;
      } else if (conflictCopy) {
        this.state.files[remotePath] = {
          hash: event.hash,
          mtime: event.mtime,
          size: event.size,
          lastSyncedHash: event.hash,
          localOnly: true,
        };
      }
      capSyncStateFiles(this.state);
      await this.save();
      return;
    }
    const previous = existing ? { ...existing } : undefined;
    this.state.files[remotePath] = {
      hash: event.hash,
      mtime: event.mtime,
      size: event.size,
      lastSyncedHash: existing?.lastSyncedHash,
    };
    capSyncStateFiles(this.state);
    try {
      const urls = await requestPresignedUrls(this.options.gatewayClient, [{
        path: remotePath,
        action: "put",
        hash: event.hash,
        size: event.size,
      }]);
      if (!urls[0]) throw new Error("sync_presign_missing");
      await uploadFile(urls[0], join(this.mapping.localRoot, event.path), this.options.gatewayClient);
      const result = await commitFiles(this.options.gatewayClient, [{
        path: remotePath,
        hash: event.hash,
        size: event.size,
        stagingId: urls[0].stagingId,
      }], this.options.revision.value);
      this.state.files[remotePath]!.lastSyncedHash = event.hash;
      this.setRevision(result.manifestVersion);
      await this.save();
      this.lastIssue = null;
    } catch (err: unknown) {
      if (previous) this.state.files[remotePath] = previous;
      else delete this.state.files[remotePath];
      await this.adoptConflictRevision(err);
      this.handleError(err, remotePath, "Upload failed");
    }
  }

  private async pull(remoteFiles: Record<string, ManifestEntry>): Promise<void> {
    let hadError = false;
    for (const [remotePath, entry] of Object.entries(remoteFiles)) {
      if (entry.deleted || !entry.hash) continue;
      const localRel = this.mapper.toLocal(remotePath);
      if (!localRel) continue;
      if (isIgnored(localRel, this.ignorePatterns)) continue;
      const existing = this.state.files[remotePath];
      if (existing?.retainedDeletion === "local" && existing.lastSyncedHash === entry.hash) continue;
      if (existing?.lastSyncedHash === entry.hash) {
        try {
          if ((await stat(join(this.mapping.localRoot, localRel))).isFile()) continue;
        } catch (err: unknown) {
          if (!(err instanceof Error) || !("code" in err) || (err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
          }
        }
      }
      try {
        const urls = await requestPresignedUrls(this.options.gatewayClient, [{ path: remotePath, action: "get" }]);
        if (!urls[0]) continue;
        await reconcileRemoteFileChange(this.state, {
          syncRoot: this.mapping.localRoot,
          localRel,
          remotePath,
          remoteHash: entry.hash,
          remoteSize: entry.size,
          remotePeerId: entry.peerId,
          toRemotePath: this.mapper.toRemote,
          downloadRemote: (targetPath) => downloadFile(urls[0]!.url, targetPath, entry.hash, {
            expectedSize: entry.size,
            maxBytes: entry.size,
          }),
        });
        this.refreshConflictIndex();
      } catch (err: unknown) {
        hadError = true;
        this.handleError(err, remotePath, "Initial mapping pull failed");
      }
    }
    this.state.lastSyncAt = Date.now();
    await this.save();
    if (!hadError) this.lastIssue = null;
  }

  private setRevision(version: number): void {
    this.options.revision.value = Math.max(this.options.revision.value, version);
    this.state.manifestVersion = this.options.revision.value;
  }

  private async adoptConflictRevision(err: unknown): Promise<void> {
    if (err instanceof VersionConflictError) {
      this.setRevision(err.currentVersion);
      await this.save();
    }
  }

  private handleError(err: unknown, path: string, message: string): void {
    this.lastIssue = classifyMappingIssue(err);
    if (err instanceof AuthRejectedError) this.options.onAuthRejected(err);
    this.options.logger.error({ err, path, mappingId: this.mapping.id }, message);
  }

  private recordWatcherError(err: unknown): void {
    this.lastIssue = classifyMappingIssue(err);
  }

  private refreshConflictIndex(): void {
    this.conflictCopyPathIndex = buildUnresolvedConflictCopyPathIndex(this.state);
  }

  private async save(): Promise<void> {
    await saveSyncState(this.options.stateFile, this.state);
  }
}
