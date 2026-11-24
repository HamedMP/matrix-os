/**
 * Maps the specific faults of the ZIP and OPC layers to the shared
 * {@link OfficeError} codes. The fault name travels in `details.reason` for logs.
 */

import { OfficeError, isOfficeError, type OfficeErrorCode, type OfficeErrorDetails } from "../errors.js";

const FAULT_CODES = {
  // Not a ZIP container at all.
  not_zip: "not_a_zip",
  // A container this engine refuses to read.
  ole_compound_file: "unsupported_format",
  encrypted: "unsupported_format",
  multi_disk: "unsupported_format",
  zip64: "unsupported_format",
  unsupported_compression: "unsupported_format",
  compression_stream_unavailable: "unsupported_format",
  // ZipLimits bounds.
  too_many_entries: "zip_limit_exceeded",
  entry_too_large: "zip_limit_exceeded",
  archive_too_large: "zip_limit_exceeded",
  // Damaged or hostile archives and packages.
  corrupt_zip: "corrupt_package",
  crc_mismatch: "corrupt_package",
  size_mismatch: "corrupt_package",
  unsafe_entry_name: "corrupt_package",
  duplicate_entry: "corrupt_package",
  invalid_xml: "corrupt_package",
  invalid_text: "corrupt_package",
  invalid_content_types: "corrupt_package",
  invalid_relationships: "corrupt_package",
  // Caller mistakes.
  invalid_part_name: "invalid_argument",
  invalid_value: "invalid_argument",
  not_allowed: "invalid_operation",
  duplicate_relationship: "invalid_operation",
  missing_part: "not_found",
  // The writer cannot express the archive without ZIP64.
  archive_not_writable: "limit_exceeded",
} as const satisfies Record<string, OfficeErrorCode>;

export type OpcFault = keyof typeof FAULT_CODES;

export function fault(reason: OpcFault, message: string, details?: OfficeErrorDetails, cause?: unknown): OfficeError {
  return new OfficeError(FAULT_CODES[reason], message, { cause, details: { ...details, reason } });
}

/** Runs `action` and reports any caller-side fault it raises as damage in the package instead. */
export function asPackageDamage<T>(reason: OpcFault, message: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (isOfficeError(error, "invalid_argument", "corrupt_package")) {
      throw fault(reason, message, undefined, error);
    }
    throw error;
  }
}
