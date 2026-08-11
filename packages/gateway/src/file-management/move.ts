import { lstat } from "node:fs/promises";
import { posix } from "node:path";
import {
  FileManagementNameSchema,
  FileManagementPathSchema,
  type FileOperationResultCode,
} from "./contracts.js";
import {
  getFileEntryCapabilities,
  isFileManagementParentAllowed,
} from "./policy.js";
import {
  resolveExistingFileApiPath,
  resolveWithinHome,
} from "../path-security.js";
import {
  moveFileNoReplace,
  isSameOrDescendantPath,
  type NoReplaceFileMoveCapability,
} from "../file-ops.js";

const MAX_KEEP_BOTH_CANDIDATES = 100;

export type MoveConflictResolution = "keep-both" | "skip";
export type MoveItemResultCode = Extract<
  FileOperationResultCode,
  "moved" | "skipped" | "source_missing" | "destination_conflict" | "protected" | "invalid_destination" | "failed"
>;

export interface MoveItemInput {
  homePath: string;
  requestId: string;
  source: string;
  destinationDirectory: string;
  conflictResolution?: MoveConflictResolution;
}

export interface MoveItemResult {
  source: string;
  destination?: string;
  code: MoveItemResultCode;
}

export interface MoveItemDependencies {
  moveCapability?: NoReplaceFileMoveCapability;
}

export async function moveFileItem(
  input: MoveItemInput,
  dependencies: MoveItemDependencies = {},
): Promise<MoveItemResult> {
  if (!isValidMovePath(input.source) || !isValidMovePath(input.destinationDirectory)) {
    return { source: input.source, code: "invalid_destination" };
  }
  if (input.conflictResolution === "skip") {
    return { source: input.source, code: "skipped" };
  }

  const sourceName = posix.basename(input.source);
  const candidates = input.conflictResolution === "keep-both"
    ? keepBothCandidates(sourceName)
    : [sourceName];

  for (const candidate of candidates) {
    if (!FileManagementNameSchema.safeParse(candidate).success) {
      return { source: input.source, code: "invalid_destination" };
    }
    const target = `${input.destinationDirectory}/${candidate}`;
    let authorization: Awaited<ReturnType<typeof authorizeMove>>;
    try {
      authorization = await authorizeMove(
        input.homePath,
        input.requestId,
        input.source,
        input.destinationDirectory,
      );
    } catch (error: unknown) {
      console.error(`[file-management] Batch move authorization failed for request ${input.requestId}`, error);
      return { source: input.source, code: "failed" };
    }
    if (authorization !== "authorized") {
      return { source: input.source, code: authorization };
    }

    const nativeResult = await moveFileNoReplace(
      input.homePath,
      input.source,
      target,
      { moveCapability: dependencies.moveCapability, requestId: input.requestId },
    );
    if (nativeResult.ok) {
      return { source: input.source, destination: target, code: "moved" };
    }
    if (nativeResult.code === "destination_conflict") {
      if (input.conflictResolution === "keep-both") continue;
      return { source: input.source, code: "destination_conflict" };
    }
    if (nativeResult.code === "source_missing") {
      return { source: input.source, code: "source_missing" };
    }
    if (nativeResult.code === "invalid_path") {
      return { source: input.source, code: "invalid_destination" };
    }
    console.error(
      `[file-management] Native batch move failed for request ${input.requestId}: ${nativeResult.code}`,
    );
    return { source: input.source, code: "failed" };
  }

  return { source: input.source, code: "destination_conflict" };
}

async function authorizeMove(
  homePath: string,
  requestId: string,
  source: string,
  destinationDirectory: string,
): Promise<"authorized" | Exclude<MoveItemResultCode, "moved" | "skipped" | "destination_conflict" | "failed"> | "failed"> {
  const sourceCapabilities = getFileEntryCapabilities(homePath, source);
  if (!sourceCapabilities.canMove) {
    return sourceCapabilities.readOnlyReason === "protected" ? "protected" : "invalid_destination";
  }
  const destinationCapabilities = getFileEntryCapabilities(homePath, destinationDirectory);
  if (!destinationCapabilities.canMove) {
    return destinationCapabilities.readOnlyReason === "protected" ? "protected" : "invalid_destination";
  }
  if (!isFileManagementParentAllowed(homePath, destinationDirectory)) {
    return "invalid_destination";
  }

  const lexicalSource = resolveWithinHome(homePath, source);
  const lexicalDestination = resolveWithinHome(homePath, destinationDirectory);
  if (!lexicalSource || !lexicalDestination) return "invalid_destination";

  let sourceIsDirectory: boolean;
  try {
    const sourceStat = await lstat(lexicalSource);
    if (sourceStat.isSymbolicLink()) return "invalid_destination";
    sourceIsDirectory = sourceStat.isDirectory();
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return "source_missing";
    console.error(`[file-management] Failed to authorize batch move source for request ${requestId}`, error);
    return "failed";
  }

  try {
    const destinationStat = await lstat(lexicalDestination);
    if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) return "invalid_destination";
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return "invalid_destination";
    console.error(`[file-management] Failed to authorize batch move destination for request ${requestId}`, error);
    return "failed";
  }

  if (
    !resolveExistingFileApiPath(homePath, source)
    || !resolveExistingFileApiPath(homePath, destinationDirectory)
  ) {
    return "invalid_destination";
  }
  if (posix.dirname(source) === destinationDirectory) return "invalid_destination";
  if (sourceIsDirectory && isSameOrDescendantPath(source, destinationDirectory)) {
    return "invalid_destination";
  }
  return "authorized";
}

function keepBothCandidates(name: string): string[] {
  const extension = posix.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  const existingCopy = /^(.*) copy(?: ([1-9]\d*))?$/.exec(stem);
  const existingNumber = existingCopy?.[2] ? Number(existingCopy[2]) : undefined;
  const base = existingCopy && (existingNumber === undefined || Number.isSafeInteger(existingNumber))
    ? existingCopy[1]!
    : stem;
  const firstCopyNumber = existingCopy && existingNumber === undefined
    ? 2
    : existingNumber !== undefined && Number.isSafeInteger(existingNumber)
      ? existingNumber + 1
      : 1;
  return Array.from({ length: MAX_KEEP_BOTH_CANDIDATES }, (_, index) => {
    const copyNumber = firstCopyNumber + index;
    const suffix = copyNumber === 1 ? " copy" : ` copy ${copyNumber}`;
    return fitKeepBothName(base, suffix, extension);
  });
}

function fitKeepBothName(base: string, suffix: string, extension: string): string {
  let preservedExtension = extension;
  let candidateBase = base;
  if (Buffer.byteLength(`${suffix}${preservedExtension}`, "utf8") > 255) {
    candidateBase += preservedExtension;
    preservedExtension = "";
  }
  const availableBaseBytes = 255 - Buffer.byteLength(`${suffix}${preservedExtension}`, "utf8");
  return `${truncateUtf8(candidateBase, availableBaseBytes)}${suffix}${preservedExtension}`;
}

function truncateUtf8(value: string, byteLimit: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > byteLimit) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function isValidMovePath(path: string): boolean {
  return FileManagementPathSchema.safeParse(path).success;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
