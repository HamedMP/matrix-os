/**
 * Spec 537 Private Preview machine handles: `pv-<pr>-<8 lowercase hex>`.
 * `@matrix-os/clerk-sync` reserves the same grammar for the platform; a
 * contract test keeps the two definitions identical.
 */
export const PRIVATE_PREVIEW_HANDLE_PATTERN = /^pv-[1-9][0-9]{0,8}-[0-9a-f]{8}$/;

export function isPrivatePreviewHandle(handle: string): boolean {
  return PRIVATE_PREVIEW_HANDLE_PATTERN.test(handle);
}
