import { AppError } from "../../../../shared/app-error";
import type { FileConflictChoice } from "./file-management-api";
import type {
  ControllerMovePreflight,
  FileOperationFailureCode,
  FileOperationNotice,
  FileOperationOutcome,
  FileOperationScope,
} from "./file-operation-controller";
import {
  FileMutationNameSchema,
  OwnerDirectoryPathSchema,
  OwnerRelativePathSchema,
} from "./file-management-contracts";

export const MAX_OPERATION_ROWS = 100;
const RECENT_REQUEST_ID_CAP = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReconciliationPlan =
  | { kind: "create"; target: string; baseline: readonly string[] | null }
  | { kind: "rename"; target: string; baseline: readonly string[] | null }
  | { kind: "move"; destinationDirectory: string; ambiguousSources: string[] }
  | { kind: "trash" };

export function reconcileAuthoritative(
  sources: readonly string[],
  listings: Record<string, string[]> | null,
  plan: ReconciliationPlan,
): { succeeded: string[]; retained: string[] } {
  const succeeded: string[] = [];
  const retained: string[] = [];
  for (const source of boundedPaths(sources)) {
    if (listings === null || (plan.kind === "move" && plan.ambiguousSources.includes(source))) {
      retained.push(source);
      continue;
    }
    const sourcePresent = listings[parentDirectory(source)]?.includes(source) ?? false;
    const target = plan.kind === "move"
      ? joinPath(plan.destinationDirectory, basename(source))
      : plan.kind === "create" || plan.kind === "rename" ? plan.target : null;
    const targetPresent = target
      ? listings[parentDirectory(target)]?.includes(target) ?? false
      : false;
    const safelySucceeded = plan.kind === "create"
      ? plan.baseline !== null && !plan.baseline.includes(plan.target) && targetPresent
      : plan.kind === "rename"
        ? plan.baseline !== null && plan.baseline.includes(source)
          && !plan.baseline.includes(plan.target) && !sourcePresent && targetPresent
        : plan.kind === "trash" ? !sourcePresent : !sourcePresent && targetPresent;
    if (safelySucceeded) succeeded.push(source);
    else retained.push(source);
  }
  return { succeeded, retained };
}

export function boundedPaths(paths: readonly string[], max = MAX_OPERATION_ROWS): string[] {
  return [...new Set(paths)].slice(0, max);
}
export function pendingPaths(active: Map<string, string[]>): string[] {
  return boundedPaths([...active.values()].flat());
}
export function firstSeen(values: readonly string[]): string[] {
  return [...new Set(values)].slice(0, MAX_OPERATION_ROWS);
}
export function validBatchSources(paths: readonly string[]): boolean {
  if (paths.length < 1 || paths.length > MAX_OPERATION_ROWS || new Set(paths).size !== paths.length) return false;
  return paths.every((path) => OwnerRelativePathSchema.safeParse(path).success
    && parentDirectory(path) === parentDirectory(paths[0]!));
}
export function sanitizeScope(scope: FileOperationScope): FileOperationScope {
  return OwnerDirectoryPathSchema.safeParse(scope.directory).success
    ? { ...scope }
    : { ...scope, directory: "" };
}
export function validScope(scope: FileOperationScope): boolean {
  return OwnerDirectoryPathSchema.safeParse(scope.directory).success;
}
export function validCreateInput(
  input: { parentDirectory: string; name: string },
  scope: FileOperationScope,
): boolean {
  return OwnerDirectoryPathSchema.safeParse(input.parentDirectory).success
    && FileMutationNameSchema.safeParse(input.name).success
    && input.parentDirectory === scope.directory;
}
export function validRenameInput(
  input: { path: string; name: string },
  scope: FileOperationScope,
): boolean {
  return OwnerRelativePathSchema.safeParse(input.path).success
    && FileMutationNameSchema.safeParse(input.name).success
    && parentDirectory(input.path) === scope.directory;
}
export function validScopedSources(paths: readonly string[], scope: FileOperationScope): boolean {
  return validBatchSources(paths) && paths.every((path) => parentDirectory(path) === scope.directory);
}
export function validMoveDestination(destination: string, sources: readonly string[], scope: FileOperationScope): boolean {
  return OwnerRelativePathSchema.safeParse(destination).success
    && destination !== scope.directory
    && sources.every((source) => destination !== source && !destination.startsWith(`${source}/`));
}
export function parentDirectory(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}
export function basename(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }
export function joinPath(parent: string, name: string): string { return parent ? `${parent}/${name}` : name; }
export function sameScope(a: FileOperationScope, b: FileOperationScope): boolean {
  return a.directory === b.directory && a.runtimeSlot === b.runtimeSlot && a.authGeneration === b.authGeneration;
}
export function sameOrderedPaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, index) => path === b[index]);
}
export function samePreflight(a: ControllerMovePreflight, b: ControllerMovePreflight): boolean {
  return a.requestId === b.requestId && a.preflightFingerprint === b.preflightFingerprint
    && a.destinationDirectory === b.destinationDirectory && a.sources.join("\0") === b.sources.join("\0");
}
export function validChoices(preflight: ControllerMovePreflight, choices: FileConflictChoice[]): boolean {
  return choices.length === preflight.conflicts.length
    && choices.every((choice, index) => choice.source === preflight.conflicts[index]?.source);
}
export function nextRequestId(generate: () => string, recent: string[]): string | null {
  for (let attempt = 0; attempt < 16; attempt++) {
    const id = generate();
    if (!UUID.test(id) || recent.includes(id)) continue;
    recent.push(id);
    if (recent.length > RECENT_REQUEST_ID_CAP) recent.shift();
    return id;
  }
  return null;
}
export function noticeForError(error: unknown): FileOperationNotice {
  if (error instanceof AppError && error.detail === "request_id_conflict") return "request_conflict";
  if (error instanceof AppError && error.detail === "operation_unavailable") return "authoritative_reconciliation_required";
  return error instanceof AppError ? "authoritative_reconciliation_required" : "operation_failed";
}
export function typedFailureCode(error: unknown): FileOperationFailureCode | null {
  if (!(error instanceof AppError)) return null;
  if (error.detail === "destination_conflict") return "destination_conflict";
  if (error.detail === "protected") return "protected";
  if (error.detail === "invalid_path" || error.detail === "invalid_destination") return "invalid_destination";
  if (error.detail === "source_missing") return "source_missing";
  if (error.detail === "cleanup_failed") return "cleanup_failed";
  if (error.detail === "failed") return "failed";
  if (error.detail === "invalid_request") return "invalid_destination";
  return null;
}
export function staleOutcome(requestId: string): FileOperationOutcome {
  return { status: "stale", requestId, succeededPaths: [], retainedPaths: [], failures: [], affectedDirectories: [], notice: null };
}
export function failedOutcome(
  requestId: string,
  paths: readonly string[],
  notice: FileOperationNotice,
  code: FileOperationFailureCode = "failed",
): FileOperationOutcome {
  const retainedPaths = boundedPaths(paths);
  return { status: "failed", requestId, succeededPaths: [], retainedPaths,
    failures: retainedPaths.map((source) => ({ source, code })), affectedDirectories: [], notice };
}
export function completedOutcome(
  requestId: string,
  succeededPaths: string[],
  affectedDirectories: string[],
): FileOperationOutcome {
  return { status: "completed", requestId, succeededPaths: boundedPaths(succeededPaths), retainedPaths: [],
    failures: [], affectedDirectories: firstSeen(affectedDirectories), notice: null };
}
