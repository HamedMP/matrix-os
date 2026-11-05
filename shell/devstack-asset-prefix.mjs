/** Keep parallel development tabs independent of the shared shell-route cookie.
 * @param {string | undefined} raw
 * @param {string | undefined} mode
 * @returns {string | undefined}
 */
export function resolveDevstackAssetPrefix(raw, mode) {
  if (mode !== 'development' || !raw) return undefined;
  if (!/^\/vm\/[a-z0-9][a-z0-9-]{1,62}\/~runtime\/[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(raw)) {
    throw new Error('MATRIX_DEVSTACK_ASSET_PREFIX requires an exact /vm/<handle>/~runtime/<slot> path');
  }
  return raw;
}
