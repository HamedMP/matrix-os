const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;
// Fixed developer-authored messages only: no slashes (paths), no newlines,
// no `=` or quotes, bounded length, so the line stays public-safe.
const SAFE_MESSAGE = /^[A-Za-z0-9 ,.'-]{1,96}$/;

// Content-free description of a supervisor failure for the journal. Host
// acceptance parses `name`, optional `code=`, and optional `message=`.
export function describeScopeRuntimeFailure(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const parts = [error.name];
  const code: unknown = (error as { code?: unknown }).code;
  if (typeof code === "string" && ERROR_CODE.test(code)) {
    parts.push(`code=${code}`);
    return parts.join(" ");
  }
  if (SAFE_MESSAGE.test(error.message)) parts.push(`message=${error.message}`);
  return parts.join(" ");
}
