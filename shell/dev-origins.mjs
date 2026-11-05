const DEFAULT_ORIGINS = [
  'staging.matrix-os.com',
  'dev.matrix-os.com',
  'localhost',
  '127.0.0.1',
];

/** Resolve exact development hostnames; Next uses this setting only in dev mode.
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function resolveAllowedDevOrigins(raw) {
  if (!raw?.trim()) return [...DEFAULT_ORIGINS];
  const entries = raw.split(',');
  if (entries.length > 32) {
    throw new Error('MATRIX_ALLOWED_DEV_ORIGINS accepts at most 32 additional entries');
  }
  const origins = new Set(DEFAULT_ORIGINS);
  for (const entry of entries) {
    const hostname = entry.trim();
    if (!hostname || hostname.length > 253 || !hostname.split('.').every(
      (label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
    )) {
      throw new Error('MATRIX_ALLOWED_DEV_ORIGINS requires exact DNS hostnames without schemes, ports or paths');
    }
    origins.add(hostname.toLowerCase());
  }
  return [...origins];
}
