import { isOfficeError } from "@matrix-os/office";
import type { OfficeDocumentErrorCode } from "@matrix-os/contracts/office-documents";

/** Where a failure that crossed the engine thread boundary came from. Logged, never sent. */
export interface OfficeErrorOrigin {
  name: string;
  engineCode: string | null;
}

/**
 * The one error type of the document service. `code` is safe for a client;
 * `message` is for server logs and may name engine internals, never shown.
 * This module is loaded by the engine thread too, so it imports only the engine.
 */
export class OfficeDocumentError extends Error {
  readonly origin: OfficeErrorOrigin | null;
  constructor(
    readonly code: OfficeDocumentErrorCode,
    message: string = code,
    options?: { cause?: unknown; origin?: OfficeErrorOrigin },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OfficeDocumentError";
    this.origin = options?.origin ?? null;
  }
}

export function errnoCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Maps an engine error to a client code. Codes about the document's own bytes become `unsupported_document`. */
export function officeEngineErrorCode(error: unknown): OfficeDocumentErrorCode | null {
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

/** The engine's own code of an error, for logs. */
export function officeEngineCodeName(error: unknown): string | null {
  return isOfficeError(error) ? error.code : null;
}
