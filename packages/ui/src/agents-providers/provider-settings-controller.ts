import { randomUUID } from "../random-uuid.js";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  CanonicalProviderCatalogSchema,
  ProviderSettingsMutationResponseSchema,
  ProviderSettingsMutationSchema,
  ProviderSettingsSnapshotSchema,
  type ProviderConnectionAttempt,
  type ProviderSettingsMutation,
  type ProviderSettingsSnapshot,
  type ProviderHarnessKind,
  type ProviderWorkflow,
} from "@matrix-os/contracts";
import { ManagedCreditRefresh } from "./managed-credit-refresh.js";
import { useNativeAuthRefresh } from "./use-native-auth-refresh.js";
import { nativeAuthenticationFingerprint, observedCodexSignIn } from "./native-auth-refresh.js";
import { useManagedCreditRefresh } from "./use-managed-credit-refresh.js";
import type { ProviderSettingsMutationIntent } from "./types.js";

const LOAD_ERROR = "Provider settings are unavailable.";
const MUTATION_ERROR = "Changes were not saved. Refresh and try again.";
const CONFLICT_ERROR = "Provider settings changed. Latest settings were loaded.";
const LOGIN_ACTION_ERROR = "Sign-in started. Use Continue to open it again.";
const MAX_LISTENERS = 64;
const MAX_ACTIVE_REQUESTS = 4;

export type ProviderSettingsTransportErrorCode =
  | "managed_credit_unsupported"
  | "managed_credit_unauthorized"
  | "idempotency_conflict"
  | "invalid_request"
  | "invalid_response"
  | "provider_settings_unavailable"
  | "revision_conflict"
  | "unavailable";

/** A deliberately message-safe transport error. Upstream details must stay out of UI state. */
export class ProviderSettingsTransportError extends Error {
  constructor(
    readonly code: ProviderSettingsTransportErrorCode,
    _unsafeCause?: string,
  ) {
    super(LOAD_ERROR);
    this.name = "ProviderSettingsTransportError";
  }
}

export interface ProviderSettingsTransport {
  getManagedCredit?(signal: AbortSignal): Promise<unknown>;
  getSnapshot(signal: AbortSignal, options?: { refresh?: boolean }): Promise<unknown>;
  mutate(mutation: ProviderSettingsMutation, signal: AbortSignal): Promise<unknown>;
}

export interface ProviderSettingsControllerState {
  identityKey: string;
  snapshot: ProviderSettingsSnapshot | null;
  /** Discovery changes independently from native proof timestamp renewal. */
  capabilityRefreshRevision: number;
  selectedHarnessId: string | null;
  connectionAttempt: ProviderConnectionAttempt | null;
  busy: boolean;
  error: string | null;
  /** The snapshot shown is the last verified one from an earlier open; a read has not replaced it yet. */
  snapshotFromCache: boolean;
}

/**
 * The last snapshot each provider identity was shown, kept in memory for the
 * session, plus one shared non-forced read per identity. A Settings page that
 * opens again renders its last verified state (with its own refreshedAt) at
 * once and refreshes it, instead of staying blank for the whole server read.
 * Never persisted; at most four identities; keyed so identities never mix.
 */
export interface ProviderSettingsSnapshotCache {
  get(identityKey: string): ProviderSettingsSnapshot | undefined;
  set(identityKey: string, snapshot: ProviderSettingsSnapshot): void;
  read(identityKey: string, signal: AbortSignal, load: (signal: AbortSignal) => Promise<unknown>): Promise<unknown>;
  /** Forgets every snapshot, for sign-out and test isolation. */
  clear(): void;
}

const SNAPSHOT_CACHE_IDENTITIES = 4;

export function createProviderSettingsSnapshotCache(): ProviderSettingsSnapshotCache {
  const snapshots = new Map<string, ProviderSettingsSnapshot>();
  const reads = new Map<string, { promise: Promise<unknown>; controller: AbortController; waiting: number }>();
  return {
    get: identityKey => snapshots.get(identityKey),
    clear: () => { snapshots.clear(); for (const entry of reads.values()) entry.controller.abort(); reads.clear(); },
    set(identityKey, snapshot) {
      // A read that started before a newer save (for example another window's
      // mutation) must never move the shown state backward.
      const current = snapshots.get(identityKey);
      if (current && current.revision > snapshot.revision) return;
      // Later callers start a fresh read instead of joining one older than this save.
      reads.delete(identityKey);
      snapshots.delete(identityKey);
      snapshots.set(identityKey, snapshot);
      while (snapshots.size > SNAPSHOT_CACHE_IDENTITIES) snapshots.delete(snapshots.keys().next().value!);
    },
    read(identityKey, signal, load) {
      let shared = reads.get(identityKey);
      if (!shared) {
        if (reads.size >= SNAPSHOT_CACHE_IDENTITIES) return load(signal);
        const controller = new AbortController();
        const entry = { controller, waiting: 0, promise: Promise.resolve<unknown>(undefined) };
        entry.promise = load(controller.signal).finally(() => {
          if (reads.get(identityKey) === entry) reads.delete(identityKey);
        });
        reads.set(identityKey, entry);
        shared = entry;
      }
      const entry = shared;
      entry.waiting += 1;
      // The shared read stops only when every caller has gone.
      return new Promise<unknown>((resolve, reject) => {
        let settled = false;
        const leave = () => {
          if (settled) return;
          settled = true;
          entry.waiting -= 1;
          if (entry.waiting === 0) {
            entry.controller.abort();
            // A transport that ignores the abort must not leave a dead read for later callers to join.
            if (reads.get(identityKey) === entry) reads.delete(identityKey);
          }
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (signal.aborted) { leave(); return; }
        signal.addEventListener("abort", leave, { once: true });
        entry.promise.then(
          value => { if (settled) return; settled = true; entry.waiting -= 1; signal.removeEventListener("abort", leave); resolve(value); },
          (error: unknown) => { if (settled) return; settled = true; entry.waiting -= 1; signal.removeEventListener("abort", leave); reject(error); },
        );
      });
    },
  };
}

/** One per renderer (Electron window or browser tab); shared by its Settings and Chat surfaces. */
export const sessionProviderSettingsSnapshotCache = createProviderSettingsSnapshotCache();

export interface ProviderSettingsControllerOptions {
  /** Shows the identity's last verified snapshot on open and shares plain reads. */
  snapshotCache?: ProviderSettingsSnapshotCache;
  identityKey: string;
  automaticCreditRefreshEnabled?: boolean;
  automaticNativeAuthRefreshEnabled?: boolean;
  transport: ProviderSettingsTransport;
  /** Called only after an explicit refresh or mutation snapshot is accepted. */
  onCatalogChanged?: (intent?: ProviderSettingsMutationIntent, previousSnapshot?: ProviderSettingsSnapshot, loginReceipt?: ProviderWorkflow) => void;
}

export interface ProviderSettingsMutationOptions {
  /** Only the action returned by this explicit sign-in mutation is opened. */
  onLoginAction?: (action: ProviderConnectionAttempt["action"]) => void | Promise<void>;
}

interface ApplySnapshotOptions {
  operationId: number;
  connectionAttempt?: ProviderConnectionAttempt | null;
  refreshCapabilities?: boolean;
}

function hasErrorCode(error: unknown, code: ProviderSettingsTransportErrorCode): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function createIdempotencyKey(): string {
  // randomUUID falls back to getRandomValues over plain (tailnet) HTTP.
  if (typeof globalThis.crypto?.getRandomValues !== "function") throw new ProviderSettingsTransportError("unavailable");
  return randomUUID();
}

function isConnectionAttemptActive(
  attempt: ProviderConnectionAttempt,
  snapshot: ProviderSettingsSnapshot,
): boolean {
  // Keep a bounded failed attempt visible so the same account can retry. The
  // original expiry and successful-auth checks still clear it on refresh.
  if (!["pending", "authorized", "failed", "denied"].includes(attempt.state)) return false;
  if (Date.parse(attempt.expiresAt) <= Date.parse(snapshot.refreshedAt)) return false;
  const harness = snapshot.harnesses.find((candidate) => candidate.id === attempt.harnessInstanceId);
  if (harness === undefined || harness.authState === "authenticated") return false;
  if (attempt.accountId === null) return true;
  const account = snapshot.accounts.find((candidate) => candidate.id === attempt.accountId);
  return account !== undefined && account.authState !== "authenticated";
}

/**
 * Framework-neutral state coordinator. It accepts only a transport and never
 * persists, fetches, or applies optimistic provider state itself.
 */
export class ProviderSettingsController {
  private state: ProviderSettingsControllerState;
  private readonly listeners = new Set<() => void>();
  private readonly requests = new Set<AbortController>();
  private operationClock = 0;
  private appliedOperationId = 0;
  private activeRefreshes = 0;
  private pendingMutations = 0;
  private nativeObservationPending = false;
  private mutationTail: Promise<void> = Promise.resolve();
  private disposed = false;
  /** Set while the shown snapshot came from the cache and no read has replaced it yet. */
  private servingCached = false;
  private readonly managedCredit: ManagedCreditRefresh;

  constructor(private readonly options: ProviderSettingsControllerOptions) {
    this.managedCredit = new ManagedCreditRefresh({
      read: options.transport.getManagedCredit?.bind(options.transport),
      snapshot: () => this.state.snapshot,
      blocked: () => this.disposed || this.state.busy,
      apply: snapshot => this.update({ snapshot }),
    });
    const cached = options.snapshotCache?.get(options.identityKey) ?? null;
    this.servingCached = cached !== null;
    this.state = {
      identityKey: options.identityKey,
      snapshot: cached,
      capabilityRefreshRevision: 0,
      selectedHarnessId: cached?.harnesses[0]?.id ?? null,
      connectionAttempt: null,
      busy: false,
      error: null,
      snapshotFromCache: cached !== null,
    };
  }

  getState = (): ProviderSettingsControllerState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    if (this.listeners.size >= MAX_LISTENERS && !this.listeners.has(listener)) {
      throw new Error("Provider settings subscription limit reached.");
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  selectHarness = (harnessInstanceId: string): void => {
    if (!this.state.snapshot?.harnesses.some((harness) => harness.id === harnessInstanceId)) return;
    this.update({ selectedHarnessId: harnessInstanceId });
  };

  refreshManagedCredit = (signal?: AbortSignal) => this.managedCredit.refresh(signal);

  refreshNativeAuthentication = async (signal: AbortSignal): Promise<void> => {
    if (this.disposed || this.state.busy || this.nativeObservationPending || signal.aborted) return;
    this.nativeObservationPending = true;
    try { await this.runRefresh(false, true, signal); }
    finally { this.nativeObservationPending = false; }
  };

  refresh = async (options: { refresh?: boolean } = { refresh: true }): Promise<void> => {
    if (this.disposed) return;
    if (this.pendingMutations > 0) await this.mutationTail;
    if (!this.disposed) await this.runRefresh(options.refresh ?? true);
  };

  refreshForConnection = async (loginReceipt?: ProviderWorkflow): Promise<ProviderSettingsSnapshot | null> => {
    if (this.disposed) return null;
    if (this.pendingMutations > 0) await this.mutationTail;
    if (this.disposed) return null;
    if (loginReceipt) {
      if (loginReceipt.kind !== "login" || loginReceipt.state !== "succeeded"
        || !this.state.snapshot?.harnesses.some(harness => harness.id === loginReceipt.harnessInstanceId)) return null;
      // The workflow already confirmed its source. Wake open Chat consumers
      // before waiting for the advisory Settings projection, without a second
      // forced renewal of every provider.
      this.options.onCatalogChanged?.(undefined, this.state.snapshot, loginReceipt);
    }
    if (!await this.runRefresh(!loginReceipt) || this.disposed) return null;
    return this.state.snapshot;
  };

  mutate = (intent: ProviderSettingsMutationIntent, options?: ProviderSettingsMutationOptions): Promise<boolean> => {
    if (this.disposed) return Promise.resolve(false);
    this.managedCredit.invalidate();
    this.pendingMutations += 1;
    this.syncBusy();

    const execution = this.mutationTail.then(async () => this.runMutation(intent, options));
    const tracked = execution.finally(() => {
      this.pendingMutations -= 1;
      this.syncBusy();
    });
    this.mutationTail = tracked.then(() => undefined).catch((error: unknown) => {
      console.warn(
        "[provider-settings] Mutation queue recovered:",
        error instanceof Error ? error.name : typeof error,
      );
    });
    return tracked;
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.managedCredit.invalidate();
    for (const request of this.requests) request.abort();
    this.requests.clear();
    this.listeners.clear();
  };

  private async runRefresh(refresh = true, nativeAuthOnly = false, signal?: AbortSignal): Promise<boolean> {
    if (!nativeAuthOnly) this.managedCredit.invalidate();
    const operationId = ++this.operationClock;
    const kind = nativeAuthOnly ? "observation" : "refresh";
    const request = this.beginRequest(kind);
    const abort = () => request.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) request.abort();
      request.signal.throwIfAborted();
      const previous = this.state.snapshot;
      const cache = this.options.snapshotCache;
      const raw = cache && !refresh && !nativeAuthOnly
        ? await cache.read(this.options.identityKey, request.signal,
          shared => this.options.transport.getSnapshot(shared, { refresh: false }))
        : await this.options.transport.getSnapshot(request.signal, { refresh });
      request.signal.throwIfAborted();
      const parsed = ProviderSettingsSnapshotSchema.safeParse(raw);
      if (!parsed.success) throw new ProviderSettingsTransportError("invalid_response");
      // Another controller may have saved a newer revision while this read ran.
      const newer = cache?.get(this.options.identityKey);
      if (newer && newer.revision > parsed.data.revision) parsed.data = newer;
      if (this.disposed || operationId < this.appliedOperationId) return false;
      const snapshot = nativeAuthOnly
        ? this.managedCredit.reconcileNativeSnapshot(parsed.data) : parsed.data;
      const nativeAuthChanged = previous !== null
        && nativeAuthenticationFingerprint(previous) !== nativeAuthenticationFingerprint(snapshot);
      // The first read after opening from the cache only confirms what is shown
      // when nothing changed, so it does not reload capabilities a second time.
      const confirmsCached = this.servingCached && previous !== null
        && previous.revision === snapshot.revision && !nativeAuthChanged;
      this.servingCached = false;
      const applied = this.applySnapshot(snapshot, { operationId,
        refreshCapabilities: confirmsCached ? false
          : !nativeAuthOnly || previous?.revision !== snapshot.revision || nativeAuthChanged });
      if (applied && (refresh || nativeAuthOnly && nativeAuthChanged)) this.options.onCatalogChanged?.();
      return applied;
    } catch (error) {
      if (request.signal.aborted) return false;
      console.warn("[provider-settings] Provider settings refresh failed:", error instanceof Error ? error.name : typeof error);
      if (!this.disposed && operationId >= this.appliedOperationId) this.update({ error: LOAD_ERROR });
      return false;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.endRequest(request, kind);
    }
  }

  private async runMutation(intent: ProviderSettingsMutationIntent, options?: ProviderSettingsMutationOptions): Promise<boolean> {
    if (this.disposed) return false;
    const current = this.state.snapshot;
    if (current === null
      || current.access.mode !== "writable"
      || !current.supportedActions.includes(intent.type)) {
      this.update({ error: MUTATION_ERROR });
      return false;
    }

    let idempotencyKey: string;
    try {
      idempotencyKey = createIdempotencyKey();
    } catch (error) {
      console.warn("[provider-settings] Could not create mutation idempotency key:", error instanceof Error ? error.name : typeof error);
      this.update({ error: MUTATION_ERROR });
      return false;
    }
    const parsedMutation = ProviderSettingsMutationSchema.safeParse({
      ...intent,
      expectedRevision: current.revision,
      idempotencyKey,
    });
    if (!parsedMutation.success) {
      this.update({ error: MUTATION_ERROR });
      return false;
    }

    const operationId = ++this.operationClock;
    const request = this.beginRequest("mutation");
    try {
      const raw = await this.options.transport.mutate(parsedMutation.data, request.signal);
      const parsed = ProviderSettingsMutationResponseSchema.safeParse(raw);
      if (!parsed.success) throw new ProviderSettingsTransportError("invalid_response");
      if (intent.type === "start_login" && parsed.data.kind === "login_attempt"
        && (parsed.data.attempt.harnessInstanceId !== intent.harnessInstanceId
          || parsed.data.attempt.accountId !== intent.accountId
          || parsed.data.attempt.method !== intent.method)) {
        throw new ProviderSettingsTransportError("invalid_response");
      }
      const applied = this.applySnapshot(parsed.data.snapshot, {
        operationId,
        refreshCapabilities: true,
        connectionAttempt: parsed.data.kind === "login_attempt" ? parsed.data.attempt : null,
      });
      if (applied) this.options.onCatalogChanged?.(intent, current);
      if (applied && !this.disposed && intent.type === "start_login"
        && parsed.data.kind === "login_attempt" && parsed.data.attempt.state === "pending"
        && this.state.connectionAttempt?.id === parsed.data.attempt.id && options?.onLoginAction) {
        try {
          await options.onLoginAction(parsed.data.attempt.action);
        } catch (error) {
          console.warn("[provider-settings] Sign-in handoff failed:", error instanceof Error ? error.name : typeof error);
          if (!this.disposed) this.update({ error: LOGIN_ACTION_ERROR });
        }
      }
      if (applied && parsed.data.snapshot.accounts.length > 0) {
        // Mutations keep the historical schema. Re-read negotiated owner details
        // without a full discovery refresh or replacing a newer operation.
        try {
          const enriched = ProviderSettingsSnapshotSchema.safeParse(await this.options.transport.getSnapshot(request.signal, { refresh: false }));
          if (enriched.success && enriched.data.revision >= parsed.data.snapshot.revision) {
            const recoveryError = this.state.error;
            if (this.applySnapshot(enriched.data, { operationId }) && recoveryError !== null) {
              this.update({ error: recoveryError });
            }
          }
        } catch (error) {
          console.warn("[provider-settings] Account details refresh failed:", error instanceof Error ? error.name : typeof error);
          // The mutation is already confirmed; metadata failure is not its failure.
        }
      }
      return applied;
    } catch (error) {
      if (this.disposed) return false;
      if (hasErrorCode(error, "revision_conflict")) {
        const refreshed = await this.runRefresh();
        if (refreshed) this.update({ error: CONFLICT_ERROR });
        return false;
      }
      if (operationId >= this.appliedOperationId) this.update({ error: MUTATION_ERROR });
      return false;
    } finally {
      this.endRequest(request, "mutation");
    }
  }

  private applySnapshot(snapshot: ProviderSettingsSnapshot, options: ApplySnapshotOptions): boolean {
    if (this.disposed || options.operationId < this.appliedOperationId) return false;
    this.appliedOperationId = options.operationId;
    const selectedHarnessId = this.state.selectedHarnessId !== null
      && snapshot.harnesses.some((harness) => harness.id === this.state.selectedHarnessId)
      ? this.state.selectedHarnessId
      : snapshot.harnesses[0]?.id ?? null;
    const previousAttempt = this.state.connectionAttempt;
    const candidateAttempt = options.connectionAttempt !== undefined
      ? options.connectionAttempt
      : previousAttempt;
    const connectionAttempt = candidateAttempt !== null
      && isConnectionAttemptActive(candidateAttempt, snapshot)
      ? candidateAttempt
      : null;
    const previousSnapshot = this.state.snapshot;
    const connectionChoicesChanged = previousSnapshot !== null
      && (nativeAuthenticationFingerprint(previousSnapshot) !== nativeAuthenticationFingerprint(snapshot)
        || observedCodexSignIn(previousSnapshot) !== observedCodexSignIn(snapshot));
    const capabilityRefreshRevision = this.state.capabilityRefreshRevision
      + (options.refreshCapabilities || connectionChoicesChanged ? 1 : 0);
    this.update({ snapshot, selectedHarnessId, connectionAttempt, capabilityRefreshRevision, error: null, snapshotFromCache: false });
    this.options.snapshotCache?.set(this.options.identityKey, snapshot);
    return true;
  }

  private beginRequest(kind: "refresh" | "mutation" | "observation"): AbortController {
    if (this.requests.size >= MAX_ACTIVE_REQUESTS) {
      const oldest = this.requests.values().next().value;
      if (oldest !== undefined) {
        oldest.abort();
        this.requests.delete(oldest);
      }
    }
    const request = new AbortController();
    this.requests.add(request);
    if (kind === "refresh") {
      this.activeRefreshes += 1;
      this.syncBusy();
    }
    return request;
  }

  private endRequest(request: AbortController, kind: "refresh" | "mutation" | "observation"): void {
    this.requests.delete(request);
    if (kind === "refresh") {
      this.activeRefreshes -= 1;
      this.syncBusy();
    }
  }

  private syncBusy(): void {
    if (!this.disposed) this.update({ busy: this.activeRefreshes > 0 || this.pendingMutations > 0 });
  }

  private update(patch: Partial<ProviderSettingsControllerState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export interface UseProviderSettingsControllerResult extends ProviderSettingsControllerState {
  onSelectHarness: (harnessInstanceId: string) => void;
  refresh: (options?: { refresh?: boolean }) => Promise<void>;
  refreshForConnection: (loginReceipt?: ProviderWorkflow) => Promise<ProviderSettingsSnapshot | null>;
  mutate: (intent: ProviderSettingsMutationIntent, options?: ProviderSettingsMutationOptions) => Promise<boolean>;
}

/** Only server-advertised setup commands run; surfaces provide transport and Terminal chrome. */
export async function openProviderAgentSetup(input: {
  harness: ProviderHarnessKind;
  getCatalog: () => Promise<unknown>;
  openCommand: (command: string) => Promise<boolean>;
}): Promise<boolean> {
  try {
    const catalog = CanonicalProviderCatalogSchema.parse(await input.getCatalog());
    const driverKind = input.harness === "claude" ? "claude_code" : input.harness;
    const prefix = input.harness === "claude" ? "claude" : input.harness;
    const action = catalog.instances.filter((instance) => instance.driverKind === driverKind)
      .flatMap((instance) => instance.setupActions)
      .find((candidate) => candidate.kind === "foreground_terminal" && candidate.id.startsWith(`${prefix}_`));
    if (!action || action.kind !== "foreground_terminal") return false;
    return await input.openCommand(action.command);
  } catch (error) {
    console.warn("[provider-settings] Agent setup unavailable:", error instanceof Error ? error.name : typeof error);
    return false;
  }
}

export function useProviderSettingsController(
  options: ProviderSettingsControllerOptions,
): UseProviderSettingsControllerResult {
  const lifecycle = useMemo(
    () => ({
      controller: new ProviderSettingsController(options),
      effectGeneration: 0,
    }),
    [options.identityKey, options.transport, options.onCatalogChanged, options.snapshotCache],
  );
  const controller = lifecycle.controller;
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  useNativeAuthRefresh(controller, options.automaticNativeAuthRefreshEnabled === true);
  useManagedCreditRefresh(controller, options.automaticCreditRefreshEnabled === true && state.snapshot !== null);

  useEffect(() => {
    const effectGeneration = ++lifecycle.effectGeneration;
    void controller.refresh({ refresh: false });
    return () => {
      // React Strict Mode replays an effect's cleanup and setup while retaining
      // memoized state. Let the replay reclaim this generation before disposal.
      queueMicrotask(() => {
        if (lifecycle.effectGeneration === effectGeneration) controller.dispose();
      });
    };
  }, [controller, lifecycle]);

  return {
    ...state,
    onSelectHarness: controller.selectHarness,
    refresh: controller.refresh,
    refreshForConnection: controller.refreshForConnection,
    mutate: controller.mutate,
  };
}
