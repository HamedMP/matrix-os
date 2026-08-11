import { lstat } from "node:fs/promises";
import { posix } from "node:path";
import {
  FileManagementPathSchema,
  type FileOperationResultCode,
} from "./contracts.js";
import { getFileEntryCapabilities } from "./policy.js";
import { resolveExistingFileApiPath } from "../path-security.js";
import { hashBatchMovePreflightPayload } from "./result-cache.js";

export interface BatchMovePreflightInput {
  homePath: string;
  sources: readonly string[];
  destinationDirectory: string;
}

export interface BatchMovePreflightInvalidItem {
  source: string;
  code: Extract<FileOperationResultCode, "source_missing" | "protected" | "invalid_destination">;
}

export interface BatchMovePreflightConflict {
  source: string;
  destination: string;
}

export interface BatchMovePreflightResult {
  sources: string[];
  destinationDirectory: string;
  conflicts: BatchMovePreflightConflict[];
  invalid: BatchMovePreflightInvalidItem[];
  preflightFingerprint: string;
}

export class FileBatchPreflightError extends Error {
  readonly code = "invalid_destination";

  constructor() {
    super("Invalid batch move request");
    this.name = "FileBatchPreflightError";
  }
}

/**
 * Reads current owner-home state to prepare a batch move. This is advisory:
 * execute must repeat policy and filesystem checks before every mutation.
 */
export async function preflightBatchMove(input: BatchMovePreflightInput): Promise<BatchMovePreflightResult> {
  const sources = [...input.sources];
  validateInput(sources, input.destinationDirectory);
  const sourceParent = posix.dirname(sources[0] ?? "");
  if (!sources.every((source) => posix.dirname(source) === sourceParent)) {
    throw new FileBatchPreflightError();
  }

  const fingerprint = hashBatchMovePreflightPayload({
    phase: "preflight",
    sources,
    destinationDirectory: input.destinationDirectory,
  });
  const destination = await inspectDestination(input.homePath, input.destinationDirectory);
  const invalid: BatchMovePreflightInvalidItem[] = [];
  const conflicts: BatchMovePreflightConflict[] = [];

  for (const source of sources) {
    const sourceState = await inspectSource(input.homePath, source);
    if (sourceState.code) {
      invalid.push({ source, code: sourceState.code });
      continue;
    }
    if (!destination.available || sourceParent === input.destinationDirectory || (sourceState.isDirectory && isSameOrDescendant(input.destinationDirectory, source))) {
      invalid.push({ source, code: "invalid_destination" });
      continue;
    }
    const destinationPath = `${input.destinationDirectory}/${posix.basename(source)}`;
    if (await existsInOwnerHome(input.homePath, destinationPath)) {
      conflicts.push({ source, destination: destinationPath });
    }
  }

  return {
    sources,
    destinationDirectory: input.destinationDirectory,
    conflicts,
    invalid,
    preflightFingerprint: fingerprint,
  };
}

function validateInput(sources: string[], destinationDirectory: string): void {
  if (sources.length === 0 || sources.length > 100 || new Set(sources).size !== sources.length) {
    throw new FileBatchPreflightError();
  }
  if (!FileManagementPathSchema.safeParse(destinationDirectory).success || sources.some((source) => !FileManagementPathSchema.safeParse(source).success)) {
    throw new FileBatchPreflightError();
  }
}

async function inspectDestination(homePath: string, destinationDirectory: string): Promise<{ available: boolean }> {
  const capabilities = getFileEntryCapabilities(homePath, destinationDirectory);
  if (!capabilities.canMove) return { available: false };
  const resolved = resolveExistingFileApiPath(homePath, destinationDirectory);
  if (!resolved) return { available: false };
  try {
    return { available: (await lstat(resolved)).isDirectory() };
  } catch {
    return { available: false };
  }
}

async function inspectSource(
  homePath: string,
  source: string,
): Promise<{ code?: BatchMovePreflightInvalidItem["code"]; isDirectory: boolean }> {
  const capabilities = getFileEntryCapabilities(homePath, source);
  if (!capabilities.canMove) {
    return { code: capabilities.readOnlyReason === "protected" ? "protected" : "invalid_destination", isDirectory: false };
  }
  const resolved = resolveExistingFileApiPath(homePath, source);
  if (!resolved) return { code: "source_missing", isDirectory: false };
  try {
    return { isDirectory: (await lstat(resolved)).isDirectory() };
  } catch {
    return { code: "source_missing", isDirectory: false };
  }
}

async function existsInOwnerHome(homePath: string, path: string): Promise<boolean> {
  const resolved = resolveExistingFileApiPath(homePath, path);
  if (!resolved) return false;
  try {
    await lstat(resolved);
    return true;
  } catch {
    return false;
  }
}

function isSameOrDescendant(destinationDirectory: string, source: string): boolean {
  return destinationDirectory === source || destinationDirectory.startsWith(`${source}/`);
}
