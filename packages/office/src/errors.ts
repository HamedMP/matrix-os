/**
 * The one error type thrown by every `@matrix-os/office` module.
 *
 * `code` is a stable, client-safe identifier. `message` and `details` are for
 * logs: they may quote part names or document text and must not be shown to
 * a client as they are.
 */

/** Every code an {@link OfficeError} can carry. */
export const OFFICE_ERROR_CODES = [
  /** The bytes are not a ZIP archive (no end-of-central-directory record). */
  "not_a_zip",
  /** A {@link import("./api/opc.js").ZipLimits} bound was exceeded while reading. */
  "zip_limit_exceeded",
  /** A ZIP archive that is damaged, or an OPC package with missing or inconsistent required parts. */
  "corrupt_package",
  /** A valid container this engine does not read: encrypted, wrong document kind, unsupported ZIP method. */
  "unsupported_format",
  /** XML that is not well formed, uses a DTD, or references an undefined entity. */
  "malformed_xml",
  /** A part, relationship, sheet or other named thing that does not exist. */
  "not_found",
  /** An argument with an invalid shape or value: bad A1 address, negative index, empty name. */
  "invalid_argument",
  /** An operation that is not allowed in the current state of the document. */
  "invalid_operation",
  /** A block id, offset, revision id, comment id or quoted text that no longer matches the document. */
  "stale_reference",
  /** A formula that cannot be parsed. Evaluation failures are values, not exceptions. */
  "formula_error",
  /** A resource bound other than the ZIP limits: XML depth, cell count, text size. */
  "limit_exceeded",
] as const;

export type OfficeErrorCode = (typeof OFFICE_ERROR_CODES)[number];

/** Structured, loggable context. Values are primitives so the object stays JSON-safe. */
export type OfficeErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

export interface OfficeErrorOptions {
  /** The underlying error, kept for server-side logs. */
  cause?: unknown;
  details?: OfficeErrorDetails;
}

const KNOWN_CODES: ReadonlySet<string> = new Set<string>(OFFICE_ERROR_CODES);

export class OfficeError extends Error {
  readonly code: OfficeErrorCode;
  readonly details: OfficeErrorDetails;

  constructor(code: OfficeErrorCode, message: string, options: OfficeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OfficeError";
    this.code = code;
    this.details = Object.freeze({ ...options.details });
  }

  /** Client-safe JSON: the code only. Log the error itself for the message and details. */
  toJSON(): { name: "OfficeError"; code: OfficeErrorCode } {
    return { name: "OfficeError", code: this.code };
  }
}

/**
 * True for an {@link OfficeError}, optionally with one of the given codes.
 *
 * Matches by shape, not by `instanceof`: the engine source is mirrored into
 * the default apps, so two copies of the class can exist in one process.
 */
export function isOfficeError(value: unknown, ...codes: OfficeErrorCode[]): value is OfficeError {
  if (!(value instanceof Error) || value.name !== "OfficeError") return false;
  const code: unknown = (value as { code?: unknown }).code;
  if (typeof code !== "string" || !KNOWN_CODES.has(code)) return false;
  return codes.length === 0 || codes.includes(code as OfficeErrorCode);
}
