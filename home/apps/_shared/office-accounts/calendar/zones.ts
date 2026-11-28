/**
 * The contract uses IANA zone names. A name the runtime knows passes through;
 * anything else becomes `UTC`.
 */
import { TIME_ZONE_NAME } from "./common.js";

/** The IANA name for a zone name; `UTC` when it is unknown. */
export function ianaZone(name: unknown): string {
  if (typeof name !== "string") return "UTC";
  const trimmed = name.trim();
  if (trimmed === "UTC") return "UTC";
  if (trimmed.includes("/") && TIME_ZONE_NAME.test(trimmed) && isKnownZone(trimmed)) return trimmed;
  return "UTC";
}

function isKnownZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch (error: unknown) {
    // An unknown zone name is a RangeError; anything else is a real fault.
    if (!(error instanceof RangeError)) throw error;
    return false;
  }
}
