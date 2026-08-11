import { AppError } from "../../../../shared/app-error";
import type {
  FileConflictChoice,
  FileManagementApi,
  FileMovePreflight,
} from "./file-management-api";

const LISTENER_CAP = 32;
const ACTIVE_OPERATION_CAP = 8;
const STORED_PREFLIGHT_CAP = 16;
const RECENT_REQUEST_ID_CAP = 512;
const MAX_ROWS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
type ReconciliationPlan =
  | { kind: "create"; target: string }
  | { kind: "rename"; target: string }
  | { kind: "move"; destinationDirectory: string; ambiguousSources: string[] }
  | { kind: "trash" };

export function createFileOperationController(options: FileOperationControllerOptions): FileOperationController {
  let snapshot = emptySnapshot(options.getScope());
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
    if (sameScope(snapshot.scope, current)) return;
    epoch++;
    active.clear();
    preflights.clear();
    publish(emptySnapshot(current));
  };

  const isCurrent = (token: OperationToken) => {
    const current = options.getScope();
    if (!sameScope(snapshot.scope, current)) syncScope();
    const predicateCurrent = options.isScopeCurrent?.(token.scope) ?? true;
    if (!predicateCurrent && !closed) {
      epoch++;
      active.clear();
      preflights.clear();
      publish(emptySnapshot(current));
    }
    return !closed && token.epoch === epoch && sameScope(token.scope, current) && predicateCurrent;
  };

  const begin = (paths: readonly string[]): OperationToken | FileOperationOutcome => {
    syncScope();
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

  async function create(input: { parentDirectory: string; name: string; kind: "file" | "directory" }) {
    const expectedPath = joinPath(input.parentDirectory, input.name);
    const started = begin([expectedPath]);
    if (!("scope" in started)) return started;
    const api = options.getApi();
    if (!api) return finish(started, failedOutcome(started.requestId, [expectedPath], "operation_unavailable"));
    try {
      const result = await api.create({ requestId: started.requestId, ...input });
      if (!isCurrent(started)) return staleOutcome(started.requestId);
      if (!await load([input.parentDirectory], started)) return staleOutcome(started.requestId);
      return finish(started, completedOutcome(started.requestId, [result.path], [input.parentDirectory]));
    } catch (error: unknown) {
      return handleUncertain(started, [expectedPath], [input.parentDirectory], { kind: "create", target: expectedPath }, error);
    }
  }

  async function rename(input: { path: string; name: string }) {
    const parent = parentDirectory(input.path);
    const expectedPath = joinPath(parent, input.name);
    const started = begin([input.path]);
    if (!("scope" in started)) return started;
    const api = options.getApi();
    if (!api) return finish(started, failedOutcome(started.requestId, [input.path], "operation_unavailable"));
    try {
      const result = await api.rename({ requestId: started.requestId, ...input });
      if (!isCurrent(started)) return staleOutcome(started.requestId);
      if (!await load([parent], started)) return staleOutcome(started.requestId);
      return finish(started, completedOutcome(started.requestId, [result.path], [parent]));
    } catch (error: unknown) {
      return handleUncertain(started, [input.path], [parent], { kind: "rename", target: expectedPath }, error);
    }
  }

  async function preflightMove(input: { sources: string[]; destinationDirectory: string }) {
    if (!validBatchSources(input.sources)) return failedOutcome("", input.sources, "request_mismatch");
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
    const stored = preflights.get(input.preflight.requestId);
    if (!stored || !samePreflight(stored, input.preflight) || !validChoices(stored, input.conflictChoices)) {
      return failedOutcome(input.preflight.requestId, input.preflight.sources, "request_mismatch");
    }
    if (active.size >= ACTIVE_OPERATION_CAP) return failedOutcome(stored.requestId, stored.sources, "operation_unavailable");
    const token = { requestId: stored.requestId, scope: { ...snapshot.scope }, epoch };
    active.set(token.requestId, boundedPaths(stored.sources));
    publish({ ...snapshot, status: "pending", pendingPaths: pendingPaths(active), notice: null });
    const api = options.getApi();
    if (!api) return finish(token, failedOutcome(token.requestId, stored.sources, "operation_unavailable"));
    const directories = firstSeen([...stored.sources.map(parentDirectory), stored.destinationDirectory]);
    try {
      const result = await api.executeMove({
        requestId: token.requestId,
        sources: stored.sources,
        preflightFingerprint: stored.preflightFingerprint,
        ...(input.conflictChoices.length ? { conflictChoices: input.conflictChoices } : {}),
      });
      if (!isCurrent(token)) return staleOutcome(token.requestId);
      if (!sameOrderedPaths(result.results.map((item) => item.source), stored.sources)) throw new AppError("server");
      const affected = firstSeen([...directories, ...result.affectedDirectories]);
      if (!await load(affected, token)) return staleOutcome(token.requestId);
      const failures = result.results
        .filter((item) => item.code !== "moved")
        .map((item) => ({ source: item.source, code: item.code as FileOperationFailureCode }));
      const succeeded = result.results.filter((item) => item.code === "moved").map((item) => item.source);
      preflights.delete(token.requestId);
      return finish(token, {
        status: "completed", requestId: token.requestId, succeededPaths: boundedPaths(succeeded),
        retainedPaths: failures.map((item) => item.source), failures: failures.slice(0, MAX_ROWS),
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
    if (!validBatchSources(input.sources)) return failedOutcome("", input.sources, "request_mismatch");
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
    const notice = noticeForError(error);
    if (notice === "request_conflict") return finish(token, failedOutcome(token.requestId, sources, notice));
    const succeeded: string[] = [];
    const retained: string[] = [];
    for (const source of boundedPaths(sources)) {
      if (listings === null || (plan.kind === "move" && plan.ambiguousSources.includes(source))) {
        retained.push(source);
        continue;
      }
      const sourcePresent = listings?.[parentDirectory(source)]?.includes(source) ?? false;
      const target = plan.kind === "move"
        ? joinPath(plan.destinationDirectory, basename(source))
        : plan.kind === "create" || plan.kind === "rename" ? plan.target : null;
      const targetPresent = target
        ? listings?.[parentDirectory(target)]?.includes(target) ?? false
        : false;
      const safelySucceeded = plan.kind === "create"
        ? targetPresent
        : plan.kind === "trash" ? !sourcePresent : !sourcePresent && targetPresent;
      if (safelySucceeded) succeeded.push(source);
      else retained.push(source);
    }
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
      snapshot = emptySnapshot(options.getScope());
    },
  };
}

function emptySnapshot(scope: FileOperationScope): FileOperationSnapshot {
  return { scope: { ...scope }, status: "idle", pendingPaths: [], retainedPaths: [], failures: [], notice: null, preflight: null };
}
function boundedPaths(paths: readonly string[], max = MAX_ROWS): string[] { return [...new Set(paths)].slice(0, max); }
function pendingPaths(active: Map<string, string[]>): string[] { return boundedPaths([...active.values()].flat()); }
function firstSeen(values: readonly string[]): string[] { return [...new Set(values)].slice(0, MAX_ROWS); }
function validBatchSources(paths: readonly string[]): boolean {
  if (paths.length < 1 || paths.length > MAX_ROWS || new Set(paths).size !== paths.length) return false;
  return paths.every((path) => parentDirectory(path) === parentDirectory(paths[0]!));
}
function parentDirectory(path: string): string { const at = path.lastIndexOf("/"); return at < 0 ? "" : path.slice(0, at); }
function basename(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }
function joinPath(parent: string, name: string): string { return parent ? `${parent}/${name}` : name; }
function sameScope(a: FileOperationScope, b: FileOperationScope): boolean { return a.directory === b.directory && a.runtimeSlot === b.runtimeSlot && a.authGeneration === b.authGeneration; }
function sameOrderedPaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, index) => path === b[index]);
}
function samePreflight(a: ControllerMovePreflight, b: ControllerMovePreflight): boolean {
  return a.requestId === b.requestId && a.preflightFingerprint === b.preflightFingerprint
    && a.destinationDirectory === b.destinationDirectory && a.sources.join("\0") === b.sources.join("\0");
}
function validChoices(preflight: ControllerMovePreflight, choices: FileConflictChoice[]): boolean {
  return choices.length === preflight.conflicts.length
    && choices.every((choice, index) => choice.source === preflight.conflicts[index]?.source);
}
function nextRequestId(generate: () => string, recent: string[]): string | null {
  for (let attempt = 0; attempt < 16; attempt++) {
    const id = generate();
    if (!UUID.test(id) || recent.includes(id)) continue;
    recent.push(id);
    if (recent.length > RECENT_REQUEST_ID_CAP) recent.shift();
    return id;
  }
  return null;
}
function noticeForError(error: unknown): FileOperationNotice {
  if (error instanceof AppError && error.detail === "request_id_conflict") return "request_conflict";
  if (error instanceof AppError && error.detail === "operation_unavailable") return "authoritative_reconciliation_required";
  return error instanceof AppError ? "authoritative_reconciliation_required" : "operation_failed";
}
function staleOutcome(requestId: string): FileOperationOutcome {
  return { status: "stale", requestId, succeededPaths: [], retainedPaths: [], failures: [], affectedDirectories: [], notice: null };
}
function failedOutcome(requestId: string, paths: readonly string[], notice: FileOperationNotice): FileOperationOutcome {
  const retainedPaths = boundedPaths(paths);
  return { status: "failed", requestId, succeededPaths: [], retainedPaths,
    failures: retainedPaths.map((source) => ({ source, code: "failed" })), affectedDirectories: [], notice };
}
function completedOutcome(requestId: string, succeededPaths: string[], affectedDirectories: string[]): FileOperationOutcome {
  return { status: "completed", requestId, succeededPaths: boundedPaths(succeededPaths), retainedPaths: [], failures: [], affectedDirectories: firstSeen(affectedDirectories), notice: null };
}
