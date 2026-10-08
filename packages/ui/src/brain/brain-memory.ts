/**
 * Ids this viewer picked last (a per-browser convenience; the gateway still decides access and what is listed).
 * Storage can be blocked or throw, so every access is in try/catch and a failure is logged by its name only.
 */
const STORED_ID_MAX_CHARS = 200;

function storageFailure(what: string, error: unknown): void {
  const name = typeof error === "object" && error !== null ? (error as { readonly name?: unknown }).name : undefined;
  console.warn(`[brain] remembered ${what} unavailable`, typeof name === "string" ? name.slice(0, 64) : typeof error);
}

export function readRemembered(key: string, what: string): string {
  if (typeof window === "undefined") return "";
  try {
    return (window.localStorage.getItem(key) ?? "").slice(0, STORED_ID_MAX_CHARS);
  } catch (error: unknown) {
    storageFailure(what, error);
    return "";
  }
}

export function writeRemembered(key: string, value: string, what: string): void {
  try {
    window.localStorage.setItem(key, value.slice(0, STORED_ID_MAX_CHARS));
  } catch (error: unknown) {
    storageFailure(what, error);
  }
}
