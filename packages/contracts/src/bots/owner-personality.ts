/** Shared UTF-8 limit for the owner SOUL reader, Settings and atomic writer. */
export const OWNER_SOUL_MAX_BYTES = 16 * 1024;

export function ownerSoulExceedsLimit(text: string): boolean {
  return new TextEncoder().encode(text).byteLength > OWNER_SOUL_MAX_BYTES;
}

/** C0 controls and DEL are unsupported; tab, LF and CR remain valid SOUL text. */
export function ownerSoulHasInvalidControls(text: string): boolean {
  return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}
