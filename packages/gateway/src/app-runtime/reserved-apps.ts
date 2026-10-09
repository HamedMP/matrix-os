/** Privileged bundled app routes cannot be supplied by gallery or IPC installs.
 * Release/template synchronization copies owner files directly and does not use
 * these untrusted install entrypoints. The owner retains filesystem authority.
 */
export const RESERVED_APP_INSTALL_ERROR = "This app identity is reserved for a bundled Matrix app.";

export function isReservedAppSlug(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase() === "utilities";
}

export function hasReservedAppIdentity(manifest: unknown): boolean {
  return typeof manifest === "object" && manifest !== null &&
    "slug" in manifest && isReservedAppSlug(manifest.slug);
}
