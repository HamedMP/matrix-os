/** A control origin must never serve uploaded preview code, even on other paths. */
export function devstackApprovalOrigin(value: string | undefined, previewOrigin: string): string {
  if (!value) throw new Error('Source publication requires a separate DevStack approval origin.');
  const url = new URL(value);
  const preview = new URL(previewOrigin);
  if (url.protocol !== 'https:' || url.origin !== value || url.hostname === preview.hostname
    || url.port || !/^[a-z0-9.-]+$/.test(url.hostname) || !url.hostname.includes('.')) {
    throw new Error('Invalid DevStack approval origin.');
  }
  return value;
}
