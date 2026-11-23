import { isOfficeError } from "@matrix-os/office";
import type { OfficeDocumentErrorCode } from "@matrix-os/contracts/office-documents";
import { ProjectWriteRefusedError } from "../app-files/project-write-fence.js";
import { OwnerFileMutationBusyError } from "../owner-file-mutations.js";
import { KeyedMutexBusyError } from "./path-mutex.js";

/**
 * The one error type of the document service. `code` is safe for a client;
 * `message` is for server logs and may name engine internals, never shown.
 */
export class OfficeDocumentError extends Error {
  constructor(readonly code: OfficeDocumentErrorCode, message: string = code, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OfficeDocumentError";
  }
}

export function errnoCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Maps an engine error to a client code. Codes about the document's own bytes become `unsupported_document`. */
function officeEngineCode(error: unknown): OfficeDocumentErrorCode | null {
  if (!isOfficeError(error)) return null;
  switch (error.code) {
    case "not_a_zip":
    case "zip_limit_exceeded":
    case "corrupt_package":
    case "unsupported_format":
    case "malformed_xml":
      return "unsupported_document";
    case "limit_exceeded":
      return "too_large";
    case "not_found":
      return "not_found";
    case "stale_reference":
      return "stale_reference";
    case "invalid_operation":
    case "formula_error":
      return "invalid_operation";
    case "invalid_argument":
      return "invalid_request";
  }
}

export function officeErrorCodeFor(error: unknown): OfficeDocumentErrorCode {
  if (error instanceof OfficeDocumentError) return error.code;
  if (error instanceof KeyedMutexBusyError || error instanceof OwnerFileMutationBusyError) return "busy";
  // A shared or fenced project is written through the shared project route, never this one.
  if (error instanceof ProjectWriteRefusedError) return error.refusal === "refused" ? "forbidden" : "unavailable";
  const engine = officeEngineCode(error);
  if (engine) return engine;
  switch (errnoCode(error)) {
    case "ENOENT": return "not_found";
    case "EACCES":
    case "EPERM":
    case "ELOOP": return "forbidden";
    case "EISDIR":
    case "ENOTDIR": return "invalid_request";
    case "EFBIG": return "too_large";
    default: return "internal";
  }
}

/** Logs the failure without document text or the home path. */
export function logOfficeFailure(route: string, code: OfficeDocumentErrorCode, error: unknown): void {
  if (error instanceof ProjectWriteRefusedError) {
    console.warn("[office-documents] project write not admitted", { route, refusal: error.refusal, reason: error.reason });
    return;
  }
  const detail = {
    route,
    code,
    name: error instanceof Error ? error.name : typeof error,
    engineCode: isOfficeError(error) ? error.code : null,
    errno: errnoCode(error),
  };
  if (code === "internal" || code === "unavailable") {
    console.error("[office-documents] request failed", detail, error instanceof Error ? error.message : "");
  } else {
    console.warn("[office-documents] request refused", detail);
  }
}
