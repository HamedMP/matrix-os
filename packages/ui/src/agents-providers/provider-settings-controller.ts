import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  ProviderSettingsMutationResponseSchema,
  ProviderSettingsMutationSchema,
  ProviderSettingsSnapshotSchema,
  type ProviderConnectionAttempt,
  type ProviderSettingsMutation,
  type ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import type { ProviderSettingsMutationIntent } from "./types.js";

const LOAD_ERROR = "Provider settings are unavailable.";
const MUTATION_ERROR = "Changes were not saved. Refresh and try again.";
const CONFLICT_ERROR = "Provider settings changed. Latest settings were loaded.";
const MAX_LISTENERS = 64;
const MAX_ACTIVE_REQUESTS = 4;

export type ProviderSettingsTransportErrorCode =
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
  getSnapshot(signal: AbortSignal): Promise<unknown>;
  mutate(mutation: ProviderSettingsMutation, signal: AbortSignal): Promise<unknown>;
}

export interface ProviderSettingsControllerState {
  identityKey: string;
  snapshot: ProviderSettingsSnapshot | null;
  selectedHarnessId: string | null;
  connectionAttempt: ProviderConnectionAttempt | null;
  busy: boolean;
  error: string | null;
}

export interface ProviderSettingsControllerOptions {
  identityKey: string;
  transport: ProviderSettingsTransport;
}

interface ApplySnapshotOptions {
  operationId: number;
  connectionAttempt?: ProviderConnectionAttempt | null;
}

function hasErrorCode(error: unknown, code: ProviderSettingsTransportErrorCode): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function createIdempotencyKey(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID !== "function") throw new ProviderSettingsTransportError("unavailable");
  return randomUUID.call(globalThis.crypto);
}

function isConnectionAttemptActive(
  attempt: ProviderConnectionAttempt,
  snapshot: ProviderSettingsSnapshot,
): boolean {
  if (attempt.state !== "pending" && attempt.state !== "authorized") return false;
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
  private mutationTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: ProviderSettingsControllerOptions) {
    this.state = {
      identityKey: options.identityKey,
      snapshot: null,
      selectedHarnessId: null,
      connectionAttempt: null,
      busy: false,
      error: null,
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

  refresh = async (): Promise<void> => {
    if (this.disposed) return;
    if (this.pendingMutations > 0) await this.mutationTail;
    if (!this.disposed) await this.runRefresh();
  };

  mutate = (intent: ProviderSettingsMutationIntent): Promise<void> => {
    if (this.disposed) return Promise.resolve();
    this.pendingMutations += 1;
    this.syncBusy();

    const execution = this.mutationTail.then(async () => this.runMutation(intent));
    const tracked = execution.finally(() => {
      this.pendingMutations -= 1;
      this.syncBusy();
    });
    this.mutationTail = tracked.catch(() => undefined);
    return tracked;
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    for (const request of this.requests) request.abort();
    this.requests.clear();
    this.listeners.clear();
  };

  private async runRefresh(): Promise<boolean> {
    const operationId = ++this.operationClock;
    const request = this.beginRequest("refresh");
    try {
      const raw = await this.options.transport.getSnapshot(request.signal);
      const parsed = ProviderSettingsSnapshotSchema.safeParse(raw);
      if (!parsed.success) throw new ProviderSettingsTransportError("invalid_response");
      return this.applySnapshot(parsed.data, { operationId });
    } catch (error) {
      console.warn("[provider-settings] Provider settings refresh failed:", error instanceof Error ? error.name : typeof error);
      if (!this.disposed && operationId >= this.appliedOperationId) this.update({ error: LOAD_ERROR });
      return false;
    } finally {
      this.endRequest(request, "refresh");
    }
  }

  private async runMutation(intent: ProviderSettingsMutationIntent): Promise<void> {
    if (this.disposed) return;
    const current = this.state.snapshot;
    if (current === null
      || current.access.mode !== "writable"
      || !current.supportedActions.includes(intent.type)) {
      this.update({ error: MUTATION_ERROR });
      return;
    }

    let idempotencyKey: string;
    try {
      idempotencyKey = createIdempotencyKey();
    } catch (error) {
      console.warn("[provider-settings] Could not create mutation idempotency key:", error instanceof Error ? error.name : typeof error);
      this.update({ error: MUTATION_ERROR });
      return;
    }
    const parsedMutation = ProviderSettingsMutationSchema.safeParse({
      ...intent,
      expectedRevision: current.revision,
      idempotencyKey,
    });
    if (!parsedMutation.success) {
      this.update({ error: MUTATION_ERROR });
      return;
    }

    const operationId = ++this.operationClock;
    const request = this.beginRequest("mutation");
    try {
      const raw = await this.options.transport.mutate(parsedMutation.data, request.signal);
      const parsed = ProviderSettingsMutationResponseSchema.safeParse(raw);
      if (!parsed.success) throw new ProviderSettingsTransportError("invalid_response");
      this.applySnapshot(parsed.data.snapshot, {
        operationId,
        connectionAttempt: parsed.data.kind === "login_attempt" ? parsed.data.attempt : null,
      });
    } catch (error) {
      if (this.disposed) return;
      if (hasErrorCode(error, "revision_conflict")) {
        const refreshed = await this.runRefresh();
        if (refreshed) this.update({ error: CONFLICT_ERROR });
        return;
      }
      if (operationId >= this.appliedOperationId) this.update({ error: MUTATION_ERROR });
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
    this.update({ snapshot, selectedHarnessId, connectionAttempt, error: null });
    return true;
  }

  private beginRequest(kind: "refresh" | "mutation"): AbortController {
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

  private endRequest(request: AbortController, kind: "refresh" | "mutation"): void {
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
  refresh: () => Promise<void>;
  mutate: (intent: ProviderSettingsMutationIntent) => Promise<void>;
}

export function useProviderSettingsController(
  options: ProviderSettingsControllerOptions,
): UseProviderSettingsControllerResult {
  const controller = useMemo(
    () => new ProviderSettingsController(options),
    [options.identityKey, options.transport],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  useEffect(() => {
    void controller.refresh();
    return controller.dispose;
  }, [controller]);

  return {
    ...state,
    onSelectHarness: controller.selectHarness,
    refresh: controller.refresh,
    mutate: controller.mutate,
  };
}
