/**
 * Maps bridge and engine failures to client-safe session errors. Messages are
 * fixed sentences; the original error goes to the log only.
 */

import type { BridgeFileError } from "../../../_shared/matrix-os";
import { isOfficeError } from "../../../_shared/office-engine/errors";
import type { SessionError, SessionErrorCode } from "./types";

const MESSAGES: Record<SessionErrorCode, string> = {
  not_found: "This file could not be found. It may have been moved or deleted.",
  forbidden: "Docs is not allowed to use this file.",
  too_large: "This file is larger than Docs can open (10 MB).",
  unavailable: "The file could not be reached. Try again in a moment.",
  invalid_request: "This file path cannot be used.",
  version_conflict: "The file changed since it was opened.",
  already_exists: "A file with this name already exists.",
  unsupported_file: "This file is not a Word document that Docs can open.",
  corrupt_file: "This document is damaged and could not be opened.",
  edited_meanwhile: "New edits were made while the file was being read, so the document was not replaced. Your edits are still here.",
  unknown: "Something went wrong. Try again.",
};

const BRIDGE_CODES: ReadonlySet<string> = new Set(["not_found", "forbidden", "too_large", "version_conflict", "invalid_request", "unavailable"]);

export function sessionError(code: SessionErrorCode): SessionError {
  return { code, message: MESSAGES[code] };
}

export function isBridgeFileError(error: unknown, code?: BridgeFileError["code"]): error is BridgeFileError {
  const value = error as Partial<BridgeFileError> | null;
  if (value === null || typeof value !== "object" || value.name !== "BridgeFileError") return false;
  if (typeof value.code !== "string" || !BRIDGE_CODES.has(value.code)) return false;
  return code === undefined || value.code === code;
}

/** The session error for anything thrown while reading, parsing or writing a document. */
export function toSessionError(error: unknown): SessionError {
  if (isBridgeFileError(error)) return sessionError(error.code);
  if (isOfficeError(error, "not_a_zip", "unsupported_format")) return sessionError("unsupported_file");
  if (isOfficeError(error, "corrupt_package", "malformed_xml", "zip_limit_exceeded", "limit_exceeded")) return sessionError("corrupt_file");
  return sessionError("unknown");
}
