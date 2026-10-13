/** Shared UTF-8 limit for the owner SOUL reader, Settings and atomic writer. */
export const OWNER_SOUL_MAX_BYTES = 16 * 1024;

export function ownerSoulExceedsLimit(text: string): boolean {
  return new TextEncoder().encode(text).byteLength > OWNER_SOUL_MAX_BYTES;
}
