import { AppError } from "../../../../shared/app-error";
import type {
  FileConflictChoice,
  FileManagementApi,
  FileMovePreflight,
} from "./file-management-api";
import {
  MAX_OPERATION_ROWS,
  boundedPaths,
  completedOutcome,
  failedOutcome,
  firstSeen,
  joinPath,
  nextRequestId,
  noticeForError,
  parentDirectory,
  pendingPaths,
  reconcileAuthoritative,
  sameOrderedPaths,
  samePreflight,
  sameScope,
  sanitizeScope,
  staleOutcome,
  typedFailureCode,
  validCreateInput,
  validChoices,
  validMoveDestination,
  validRenameInput,
  validScope,
  validScopedSources,
  type ReconciliationPlan,
} from "./file-operation-reconciliation";

const LISTENER_CAP = 32;
const ACTIVE_OPERATION_CAP = 8;
const STORED_PREFLIGHT_CAP = 16;

export interface FileOperationScope {
  directory: string;
  runtimeSlot: string;
  authGeneration: number;
}

export type FileOperationNotice =
  | "authoritative_reconciliation_required"
  | "operation_failed"
  | "operation_unavailable"
  | "request_conflict"
  | "request_mismatch";

export type FileOperationFailureCode =
  | "failed"
  | "cleanup_failed"
  | "skipped"
  | "source_missing"
  | "destination_conflict"
  | "protected"
  | "invalid_destination";

export interface FileOperationFailure {
  source: string;
  code: FileOperationFailureCode;
}

export interface ControllerMovePreflight extends FileMovePreflight {
  requestId: string;
}

export type FileOperationStatus =
  | "idle"
  | "pending"
  | "ready"
  | "needs-resolution"
  | "completed"
  | "cancelled"
  | "uncertain"
  | "failed"
  | "stale";

export interface FileOperationSnapshot {
  scope: FileOperationScope;
  status: FileOperationStatus;
  pendingPaths: string[];
  retainedPaths: string[];
  failures: FileOperationFailure[];
  notice: FileOperationNotice | null;
  preflight: ControllerMovePreflight | null;
}

export interface FileOperationOutcome {
  status: FileOperationStatus;
  requestId: string;
  succeededPaths: string[];
  retainedPaths: string[];
  failures: FileOperationFailure[];
  affectedDirectories: string[];
  notice: FileOperationNotice | null;
  preflight?: ControllerMovePreflight;
}

export interface FileOperationControllerOptions {
  getApi(): FileManagementApi | null;
  createRequestId(): string;
  getScope(): FileOperationScope;
  loadDirectory(directory: string, scope: FileOperationScope): Promise<readonly string[]>;
  isScopeCurrent?(scope: FileOperationScope): boolean;
  now?: () => number;
}

export interface FileOperationController {
  readonly snapshot: FileOperationSnapshot;
  subscribe(listener: (snapshot: FileOperationSnapshot) => void): () => void;
  syncScope(): void;
  create(input: { parentDirectory: string; name: string; kind: "file" | "directory" }): Promise<FileOperationOutcome>;
  rename(input: { path: string; name: string }): Promise<FileOperationOutcome>;
  preflightMove(input: { sources: string[]; destinationDirectory: string }): Promise<FileOperationOutcome>;
  executeMove(input: { preflight: ControllerMovePreflight; conflictChoices: FileConflictChoice[] }): Promise<FileOperationOutcome>;
  cancelMove(preflight: ControllerMovePreflight): FileOperationOutcome;
  trash(input: { sources: string[] }): Promise<FileOperationOutcome>;
  close(): void;
}

interface OperationToken { requestId: string; scope: FileOperationScope; epoch: number }

export function createFileOperationController(options: FileOperationControllerOptions): FileOperationController {
  let snapshot = emptySnapshot(sanitizeScope(options.getScope()));
  let epoch = 0;
  let closed = false;
  const listeners = new Map<number, (snapshot: FileOperationSnapshot) => void>();
  let nextListenerId = 1;
  const active = new Map<string, string[]>();
  const preflights = new Map<string, ControllerMovePreflight>();
  const recentIds: string[] = [];

  const publish = (next: FileOperationSnapshot) => {
    if (closed) return;
    snapshot = next;
    for (const listener of [...listeners.values()]) {
      try { listener(snapshot); } catch (error: unknown) {
        console.warn("[file-operation-controller] listener failed:", error instanceof Error ? error.name : typeof error);
      }
    }
  };

  const syncScope = () => {
    if (closed) return;
    const current = options.getScope();
    const safeCurrent = sanitizeScope(current);
    const predicateCurrent = validScope(current) && (options.isScopeCurrent?.(current) ?? true);
    if (sameScope(snapshot.scope, safeCurrent) && predicateCurrent) return;
    epoch++;
    active.clear();
    preflights.clear();
    publish(emptySnapshot(safeCurrent));
  };

  const entryScopeCurrent = () => {
    const current = options.getScope();
    return validScope(current) && sameScope(snapshot.scope, current)
      && (options.isScopeCurrent?.(current) ?? true);
  };

  const isCurrent = (token: OperationToken) => {
    syncScope();
    const current = options.getScope();
    const predicateCurrent = options.isScopeCurrent?.(token.scope) ?? true;
    return !closed && token.epoch === epoch && sameScope(token.scope, current) && predicateCurrent;
  };

  const begin = (paths: readonly string[]): OperationToken | FileOperationOutcome => {
    syncScope();
    if (!entryScopeCurrent()) return staleOutcome("");
    if (closed || active.size >= ACTIVE_OPERATION_CAP) {
      return failedOutcome("", paths, "operation_unavailable");
    }
    const requestId = nextRequestId(options.createRequestId, recentIds);
    if (!requestId) return failedOutcome("", paths, "operation_unavailable");
    const token = { requestId, scope: { ...snapshot.scope }, epoch };
    active.set(requestId, boundedPaths(paths));
    publish({ ...snapshot, status: "pending", pendingPaths: pendingPaths(active), notice: null });
    return token;
  };

  const finish = (token: OperationToken, outcome: FileOperationOutcome) => {
    if (!isCurrent(token)) return staleOutcome(token.requestId);
    active.delete(token.requestId);
    publish({
      scope: snapshot.scope,
      status: outcome.status,
      pendingPaths: pendingPaths(active),
      retainedPaths: outcome.retainedPaths,
      failures: outcome.failures,
      notice: outcome.notice,
      preflight: outcome.preflight ?? null,
    });
    return outcome;
  };

  const load = async (directories: readonly string[], token: OperationToken) => {
    const listings: Record<string, string[]> = {};
    for (const directory of firstSeen(directories)) {
      if (!isCurrent(token)) return null;
      const result = await options.loadDirectory(directory, token.scope);
      if (!isCurrent(token)) return null;
      listings[directory] = boundedPaths(result, 1_000);
    }
    return listings;
  };

  const captureBaseline = async (directory: string, token: OperationToken) => {
    try {
      const listings = await load([directory], token);
      return listings?.[directory] ?? null;
    } catch (error: unknown) {
      console.warn(
        "[file-operation-controller] pre-operation reload failed:",
        error instanceof Error ? error.name : typeof error,
      );
      return null;
    }
  };

  async function create(input: { parentDirectory: string; name: string; kind: "file" | "directory" }) {
    syncScope();
    if (!entryScopeCurrent()) return staleOutcome("");
    if (!validCreateInput(input, snapshot.scope)) return failedOutcome("", [], "request_mismatch");
    const expectedPath = joinPath(input.parentDirectory, input.name);
    const started = begin([expectedPath]);
    if (!("scope" in started)) return started;
    const api = options.getApi();
    if (!api) return finish(started, failedOutcome(started.requestId, [expectedPath], "operation_unavailable"));
    const baseline = await captureBaseline(input.parentDirectory, started);
    if (!isCurrent(started)) return staleOutcome(started.requestId);
    try {
      const result = await api.create({ requestId: started.requestId, ...input });
      if (!isCurrent(started)) return staleOutcome(started.requestId);
      if (!await load([input.parentDirectory], started)) return staleOutcome(started.requestId);
      return finish(started, completedOutcome(started.requestId, [result.path], [input.parentDirectory]));
    } catch (error: unknown) {
      return handleUncertain(started, [expectedPath], [input.parentDirectory], {
        kind: "create", target: expectedPath, baseline,
      }, error);
    }
  }

  async function rename(input: { path: string; name: string }) {
    syncScope();
    if (!entryScopeCurrent()) return staleOutcome("");
    if (!validRenameInput(input, snapshot.scope)) return failedOutcome("", [], "request_mismatch");
    const parent = parentDirectory(input.path);
    const expectedPath = joinPath(parent, input.name);
    const started = begin([input.path]);
    if (!("scope" in started)) return started;
    const api = options.getApi();
    if (!api) return finish(started, failedOutcome(started.requestId, [input.path], "operation_unavailable"));
    const baseline = await captureBaseline(parent, started);
    if (!isCurrent(started)) return staleOutcome(started.requestId);
    try {
      const result = await api.rename({ requestId: started.requestId, ...input });
      if (!isCurrent(started)) return staleOutcome(started.requestId);
      if (!await load([parent], started)) return staleOutcome(started.requestId);
      return finish(started, completedOutcome(started.requestId, [result.path], [parent]));
    } catch (error: unknown) {
      return handleUncertain(started, [input.path], [parent], {
        kind: "rename", target: expectedPath, baseline,
      }, error);
    }
  }

  async function preflightMove(input: { sources: string[]; destinationDirectory: string }) {
    syncScope();
    if (!entryScopeCurrent()) return staleOutcome("");
    if (!validScopedSources(input.sources, snapshot.scope)
      || !validMoveDestination(input.destinationDirectory, input.sources, snapshot.scope)) {
      return failedOutcome("", [], "request_mismatch");
    }
    const sources = boundedPaths(input.sources);
    const started = begin(sources);
    if (!("scope" in started)) return started;
    const api = options.getApi();
    if (!api) return finish(started, failedOutcome(started.requestId, sources, "operation_unavailable"));
    try {
      const result = await api.preflightMove({ requestId: started.requestId, sources, destinationDirectory: input.destinationDirectory });
      if (!isCurrent(started)) return staleOutcome(started.requestId);
      if (!sameOrderedPaths(result.sources, sources) || result.destinationDirectory !== input.destinationDirectory) {
        throw new AppError("server");
      }
      const preflight = { requestId: started.requestId, ...result };
      if (preflights.size >= STORED_PREFLIGHT_CAP) preflights.delete(preflights.keys().next().value!);
      preflights.set(started.requestId, preflight);
      const failures = result.invalid.map((item) => ({ source: item.source, code: item.code }));
      return finish(started, {
        status: result.conflicts.length ? "needs-resolution" : "ready",
        requestId: started.requestId,
        succeededPaths: [], retainedPaths: failures.map((item) => item.source), failures,
        affectedDirectories: [], notice: null, preflight,
      });
    } catch (error: unknown) {
      return finish(started, failedOutcome(started.requestId, sources, noticeForError(error)));
    }
  }

  async function executeMove(input: { preflight: ControllerMovePreflight; conflictChoices: FileConflictChoice[] }) {
    syncScope();
    if (!entryScopeCurrent()) return staleOutcome(input.preflight.requestId);
    if (!validScopedSources(input.preflight.sources, snapshot.scope)
      || !validMoveDestination(input.preflight.destinationDirectory, input.preflight.sources, snapshot.scope)) {
      return failedOutcome(input.preflight.requestId, [], "request_mismatch");
    }
    if (active.has(input.preflight.requestId)) {
      return failedOutcome(input.preflight.requestId, input.preflight.sources, "operation_unavailable");
    }
    const stored = preflights.get(input.preflight.requestId);
    if (!stored || !samePreflight(stored, input.preflight) || !validChoices(stored, input.conflictChoices)) {
      return failedOutcome(input.preflight.requestId, input.preflight.sources, "request_mismatch");
    }
    if (active.size >= ACTIVE_OPERATION_CAP) return failedOutcome(stored.requestId, stored.sources, "operation_unavailable");
    const token = { requestId: stored.requestId, scope: { ...snapshot.scope }, epoch };
    active.set(token.requestId, boundedPaths(stored.sources));
    preflights.delete(token.requestId);
    publish({ ...snapshot, status: "pending", pendingPaths: pendingPaths(active), notice: null });
    const api = options.getApi();
    if (!api) return finish(token, failedOutcome(token.requestId, stored.sources, "operation_unavailable"));
    const directories = firstSeen([...stored.sources.map(parentDirectory), stored.destinationDirectory]);
    try {
      const result = await api.executeMove({
        requestId: token.requestId,
        sources: stored.sources,
        destinationDirectory: stored.destinationDirectory,
        preflightFingerprint: stored.preflightFingerprint,
        ...(input.conflictChoices.length ? { conflictChoices: input.conflictChoices } : {}),
      });
      if (!isCurrent(token)) return staleOutcome(token.requestId);
      if (!sameOrderedPaths(result.results.map((item) => item.source), stored.sources)) throw new AppError("server");
      const affected = directories;
      if (!await load(affected, token)) return staleOutcome(token.requestId);
      const failures = result.results
        .filter((item) => item.code !== "moved")
        .map((item) => ({ source: item.source, code: item.code as FileOperationFailureCode }));
      const succeeded = result.results.filter((item) => item.code === "moved").map((item) => item.source);
      preflights.delete(token.requestId);
      return finish(token, {
        status: "completed", requestId: token.requestId, succeededPaths: boundedPaths(succeeded),
        retainedPaths: failures.map((item) => item.source), failures: failures.slice(0, MAX_OPERATION_ROWS),
        affectedDirectories: affected, notice: null,
      });
    } catch (error: unknown) {
      return handleUncertain(token, stored.sources, directories, {
        kind: "move",
        destinationDirectory: stored.destinationDirectory,
        ambiguousSources: input.conflictChoices.map((choice) => choice.source),
      }, error);
    }
  }

  function cancelMove(preflight: ControllerMovePreflight): FileOperationOutcome {
    syncScope();
    if (!entryScopeCurrent()) return staleOutcome(preflight.requestId);
    if (!validScopedSources(preflight.sources, snapshot.scope)
      || !validMoveDestination(preflight.destinationDirectory, preflight.sources, snapshot.scope)) {
      return failedOutcome(preflight.requestId, [], "request_mismatch");
    }
    if (active.has(preflight.requestId)) {
      return failedOutcome(preflight.requestId, preflight.sources, "operation_unavailable");
    }
    const stored = preflights.get(preflight.requestId);
    if (!stored || !samePreflight(stored, preflight)) return failedOutcome(preflight.requestId, preflight.sources, "request_mismatch");
    preflights.delete(preflight.requestId);
    const outcome: FileOperationOutcome = {
      status: "cancelled", requestId: preflight.requestId, succeededPaths: [], retainedPaths: boundedPaths(preflight.sources),
      failures: [], affectedDirectories: [], notice: null,
    };
    publish({ ...snapshot, status: "cancelled", preflight: null, retainedPaths: outcome.retainedPaths });
    return outcome;
  }

  async function trash(input: { sources: string[] }) {
    syncScope();
    if (!entryScopeCurrent()) return staleOutcome("");
    if (!validScopedSources(input.sources, snapshot.scope)) return failedOutcome("", [], "request_mismatch");
    const sources = boundedPaths(input.sources);
    const started = begin(sources);
    if (!("scope" in started)) return started;
    const api = options.getApi();
    if (!api) return finish(started, failedOutcome(started.requestId, sources, "operation_unavailable"));
    const sourceDirectories = firstSeen(sources.map(parentDirectory));
    try {
      const result = await api.trash({ requestId: started.requestId, sources });
      if (!isCurrent(started)) return staleOutcome(started.requestId);
      if (!sameOrderedPaths(result.results.map((item) => item.source), sources)) throw new AppError("server");
      const affected = firstSeen([...sourceDirectories, result.sourceDirectory]);
      if (!await load(affected, started)) return staleOutcome(started.requestId);
      const failures = result.results.filter((item) => item.code !== "trashed")
        .map((item) => ({ source: item.source, code: item.code as FileOperationFailureCode }));
      return finish(started, {
        status: "completed", requestId: started.requestId,
        succeededPaths: result.results.filter((item) => item.code === "trashed").map((item) => item.source),
        retainedPaths: failures.map((item) => item.source), failures, affectedDirectories: affected, notice: null,
      });
    } catch (error: unknown) {
      return handleUncertain(started, sources, sourceDirectories, { kind: "trash" }, error);
    }
  }

  async function handleUncertain(
    token: OperationToken,
    sources: readonly string[],
    directories: readonly string[],
    plan: ReconciliationPlan,
    error: unknown,
  ): Promise<FileOperationOutcome> {
    if (!isCurrent(token)) return staleOutcome(token.requestId);
    const notice = noticeForError(error);
    if (notice === "request_conflict") return finish(token, failedOutcome(token.requestId, sources, notice));
    const typedFailure = typedFailureCode(error);
    if (typedFailure) return finish(token, failedOutcome(token.requestId, sources, "operation_failed", typedFailure));
    let listings: Record<string, string[]> | null = null;
    try {
      listings = await load(directories, token);
    } catch (error: unknown) {
      console.warn(
        "[file-operation-controller] authoritative reload failed:",
        error instanceof Error ? error.name : typeof error,
      );
      listings = null;
    }
    if (!isCurrent(token)) return staleOutcome(token.requestId);
    const { succeeded, retained } = reconcileAuthoritative(sources, listings, plan);
    const failures = retained.map((source) => ({ source, code: "failed" as const }));
    return finish(token, {
      status: "uncertain", requestId: token.requestId, succeededPaths: succeeded,
      retainedPaths: retained, failures, affectedDirectories: firstSeen(directories),
      notice: "authoritative_reconciliation_required",
    });
  }

  return {
    get snapshot() { return snapshot; },
    subscribe(listener) {
      if (closed) throw new Error("File operation controller is closed");
      if (listeners.size >= LISTENER_CAP) throw new Error(`File operation listener cap (${LISTENER_CAP}) exceeded`);
      const id = nextListenerId++;
      listeners.set(id, listener);
      return () => { listeners.delete(id); };
    },
    syncScope,
    create,
    rename,
    preflightMove,
    executeMove,
    cancelMove,
    trash,
    close() {
      if (closed) return;
      closed = true;
      epoch++;
      active.clear();
      preflights.clear();
      listeners.clear();
      snapshot = emptySnapshot(sanitizeScope(options.getScope()));
    },
  };
}

function emptySnapshot(scope: FileOperationScope): FileOperationSnapshot {
  return { scope: { ...scope }, status: "idle", pendingPaths: [], retainedPaths: [], failures: [], notice: null, preflight: null };
}
