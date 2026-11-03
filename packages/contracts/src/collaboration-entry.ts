/**
 * The account-only collaboration entry path family (spec 535 M1). Platform
 * session routing and the shell's post-auth return path share this matcher so
 * they can never disagree about which destinations are shared entries.
 */
export const SHARED_ENTRY_ROOT = "/shared";
const SHARED_ENTRY_MAX_SEGMENTS = 4;
const SHARED_ENTRY_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * True for exactly `/shared`, `/shared/`, and `/shared/<segment>` with one to
 * four `[A-Za-z0-9_-]{1,128}` segments. Encoded separators, dot segments,
 * empty segments, trailing slashes, backslashes and control characters never
 * match.
 */
export function isSharedEntryPath(path: string): boolean {
  if (path === SHARED_ENTRY_ROOT || path === `${SHARED_ENTRY_ROOT}/`) return true;
  if (!path.startsWith(`${SHARED_ENTRY_ROOT}/`)) return false;
  const segments = path.slice(SHARED_ENTRY_ROOT.length + 1).split("/");
  return segments.length <= SHARED_ENTRY_MAX_SEGMENTS
    && segments.every((segment) => SHARED_ENTRY_SEGMENT.test(segment));
}
