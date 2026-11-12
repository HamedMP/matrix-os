/**
 * Matrix Core repo sync job (spec 2691, layer 6): resolve the protected ref,
 * download and validate the commit tarball, store it, then move the pin. Any
 * failure leaves the last good pin in place. Runs hourly on the background
 * worker class, on a verified webhook, and on an admin "sync now".
 *
 * Concurrency: one in-flight sync per org per process. Two platform instances
 * may race; the later write wins and the next sync converges on the ref head
 * (a stale pin lasts at most until then). No network call runs inside a
 * database transaction.
 */
import type { CoreRepoSyncResult } from "@matrix-os/contracts";
import { CoreRepoArchiveError, inspectCoreRepoArchive, sha256Hex } from "@finnaai/matrix/core-repo-archive";
import type { CoreRepoConfig, CoreRepoSource } from "./config.js";
import type { CoreRepoFailure, CoreRepoRepository } from "./database.js";
import { CoreRepoUpstreamError, type GitHubCoreRepoClient } from "./github.js";

export const CORE_REPO_SYNC_INTERVAL_MS = 60 * 60_000;
const STORE_TIMEOUT_MS = 30_000;

export interface CoreRepoObjectStore {
  putObject(key: string, body: Uint8Array, options?: { signal?: AbortSignal }): Promise<unknown>;
  getObject(key: string, options?: { signal?: AbortSignal }): Promise<{ body: ReadableStream | null; contentLength?: number }>;
}

export function coreRepoObjectKey(organizationId: string, commit: string): string {
  return `core-repo/${organizationId}/${commit}.tar.gz`;
}

function failureOf(error: unknown): CoreRepoFailure {
  if (error instanceof CoreRepoUpstreamError) return error.reason;
  if (error instanceof CoreRepoArchiveError) return "archive";
  return "download";
}

export function createCoreRepoSyncService(options: {
  config: Pick<CoreRepoConfig, "sources">;
  github: Pick<GitHubCoreRepoClient, "headCommit" | "downloadTarball">;
  store: CoreRepoObjectStore;
  repository: CoreRepoRepository;
}) {
  const sources = new Map<string, CoreRepoSource>(options.config.sources.map(source => [source.orgId, source]));
  // Keyed by configured org only, so it can never exceed the source count (<= 500).
  const inflight = new Map<string, Promise<CoreRepoSyncResult>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweep: Promise<void> | undefined;
  let stopped = false;

  async function fail(organizationId: string, failure: CoreRepoFailure, error: unknown): Promise<CoreRepoSyncResult> {
    console.warn("[core-repo] sync failed; last good commit kept", { organizationId, failure, error: error instanceof Error ? error.name : "UnknownError" });
    await options.repository.recordFailure(organizationId, failure);
    return { status: "failed" };
  }

  async function run(source: CoreRepoSource): Promise<CoreRepoSyncResult> {
    let head: { commit: string; token: string };
    try { head = await options.github.headCommit(source); }
    catch (error: unknown) { return fail(source.orgId, failureOf(error), error); }
    const current = await options.repository.getPin(source.orgId);
    if (current?.commit === head.commit) return { status: "unchanged", commit: head.commit };
    let bytes: Uint8Array;
    try {
      bytes = await options.github.downloadTarball(source, head.commit, head.token);
      await inspectCoreRepoArchive(bytes);
    } catch (error: unknown) { return fail(source.orgId, failureOf(error), error); }
    try {
      await options.store.putObject(coreRepoObjectKey(source.orgId, head.commit), bytes, { signal: AbortSignal.timeout(STORE_TIMEOUT_MS) });
    } catch (error: unknown) { return fail(source.orgId, "storage", error); }
    await options.repository.pin({ organizationId: source.orgId, commit: head.commit, sha256: sha256Hex(bytes), bytes: bytes.byteLength });
    return { status: "pinned", commit: head.commit };
  }

  const service = {
    sourceForOrg: (organizationId: string) => sources.get(organizationId),
    sourceForInstallation: (installationId: number, repository: string) => options.config.sources.find(source =>
      source.installationId === installationId && source.repository.toLowerCase() === repository.toLowerCase()),

    /** Null when the org has no configured repo. Concurrent calls share one run. */
    syncOrg(organizationId: string): Promise<CoreRepoSyncResult> | null {
      const source = sources.get(organizationId);
      if (!source) return null;
      const existing = inflight.get(organizationId);
      if (existing) return existing;
      const job = run(source).finally(() => inflight.delete(organizationId));
      inflight.set(organizationId, job);
      return job;
    },

    async syncAll(): Promise<void> {
      for (const source of sources.values()) {
        if (stopped) return;
        try { await service.syncOrg(source.orgId); }
        catch (error: unknown) { console.error("[core-repo] sync crashed", error instanceof Error ? error.name : "UnknownError"); }
      }
      await options.repository.pruneDeliveries().catch((error: unknown) => {
        console.warn("[core-repo] delivery prune failed", error instanceof Error ? error.name : "UnknownError");
      });
    },

    start(intervalMs = CORE_REPO_SYNC_INTERVAL_MS): void {
      if (timer || stopped) return;
      const tick = () => { sweep ??= service.syncAll().finally(() => { sweep = undefined; }); };
      timer = setInterval(tick, intervalMs);
      timer.unref();
      tick();
    },

    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await Promise.allSettled([sweep, ...inflight.values()]);
    },
  };
  return service;
}

export type CoreRepoSyncService = ReturnType<typeof createCoreRepoSyncService>;
