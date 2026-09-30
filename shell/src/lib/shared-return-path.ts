import { isSharedEntryPath } from "@matrix-os/contracts";

const MAX_SHARED_RETURN_PATH_LENGTH = 2_048;
// Backslashes, control characters and encoded separators never belong in a
// shared destination; rejecting them before URL parsing keeps browser
// normalization from turning them into another path or origin.
const UNSAFE_RETURN_PATH = /[\\\u0000-\u001f\u007f]|%(?:2f|5c|00)/i;

/**
 * Validates a post-auth destination for the account-only collaboration entry.
 * Only same-origin `/shared` destinations survive; everything else returns the
 * app root, which keeps today's sign-in behavior.
 */
export function normalizeSharedReturnPath(value: string | null | undefined, appOrigin: string): string {
  if (!value || value.length > MAX_SHARED_RETURN_PATH_LENGTH || UNSAFE_RETURN_PATH.test(value)) return "/";
  // A root-relative path or an absolute http(s) URL; protocol-relative and
  // document-relative values are never accepted.
  if (value.startsWith("//") || !(value.startsWith("/") || /^https?:\/\//i.test(value))) return "/";
  if (!URL.canParse(appOrigin)) return "/";
  const canonical = new URL(appOrigin);
  if (canonical.protocol !== "http:" && canonical.protocol !== "https:") return "/";
  const base = `${canonical.origin}/`;
  if (!URL.canParse(value, base)) return "/";
  const destination = new URL(value, base);
  if (destination.origin !== canonical.origin || destination.username || destination.password) return "/";
  if (!isSharedEntryPath(destination.pathname)) return "/";
  const target = `${destination.pathname}${destination.search}`;
  return target.length <= MAX_SHARED_RETURN_PATH_LENGTH ? target : "/";
}
