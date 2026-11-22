/** Validation of ZIP entry names as they come out of an untrusted archive. */

import { fault } from "./errors.js";

/**
 * Refuses names that could address anything outside the archive root or that
 * two readers could resolve differently: absolute paths, drive prefixes,
 * backslashes, control characters, and `.`, `..` or empty path segments.
 * A single trailing slash (a directory entry) is allowed.
 */
export function assertSafeEntryName(name: string): void {
  if (name === "" || name.startsWith("/") || name.includes("\\") || /^[A-Za-z]:/.test(name)) {
    throw fault("unsafe_entry_name", "entry name is not a relative archive path");
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw fault("unsafe_entry_name", "entry name contains a control character");
    }
  }
  const segments = name.split("/");
  if (segments[segments.length - 1] === "") segments.pop();
  if (segments.length === 0) {
    throw fault("unsafe_entry_name", "entry name is not a relative archive path");
  }
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw fault("unsafe_entry_name", "entry name contains a traversal or empty segment");
    }
  }
}

/** Key under which two names collide. OPC compares names without regard to ASCII case. */
export function entryNameKey(name: string): string {
  return name.replace(/[A-Z]/g, (char) => char.toLowerCase());
}
