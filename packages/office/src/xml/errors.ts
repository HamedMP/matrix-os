/**
 * Error constructors of the XML layer. Every failure is an {@link OfficeError}
 * whose `details` carry the position, so callers can log it without parsing
 * the message.
 */

import { OfficeError } from "../errors.js";

/** Why a document was refused; travels in `details.reason`. */
export type XmlFault =
  | "syntax"
  | "doctype"
  | "undefined_entity"
  | "invalid_reference"
  | "forbidden_character"
  | "duplicate_attribute"
  | "mismatched_tag"
  | "unclosed"
  | "no_root"
  | "declaration";

const MAX_QUOTED_NAME = 64;

/** Shortens a name taken from the document before it goes into a message. */
export function quoteName(name: string): string {
  return name.length <= MAX_QUOTED_NAME ? name : `${name.slice(0, MAX_QUOTED_NAME)}…`;
}

/** One-based line and column of an offset, in UTF-16 code units. */
export function locate(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let at = text.indexOf("\n"); at !== -1 && at < offset; at = text.indexOf("\n", at + 1)) {
    line++;
    lineStart = at + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

/** A `malformed_xml` error at an offset of the parsed text. */
export function malformed(text: string, offset: number, message: string, reason: XmlFault = "syntax"): OfficeError {
  const { line, column } = locate(text, offset);
  return new OfficeError("malformed_xml", `${message} (line ${line}, column ${column})`, {
    details: { offset, line, column, reason },
  });
}

/** A `limit_exceeded` error for one of the parse limits. */
export function limitExceeded(limit: "maxDepth" | "maxNodes", max: number, offset: number): OfficeError {
  const what = limit === "maxDepth" ? "nesting depth" : "node count";
  return new OfficeError("limit_exceeded", `XML ${what} exceeds the limit of ${max}`, {
    details: { limit, max, offset },
  });
}

export function invalidArgument(message: string): OfficeError {
  return new OfficeError("invalid_argument", message);
}

export function invalidOperation(message: string): OfficeError {
  return new OfficeError("invalid_operation", message);
}
