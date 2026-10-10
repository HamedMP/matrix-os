/** Fixed browser download hosts used by the pinned, bundled Utilities toolkit.
 * Models start at huggingface.co; large files redirect to its object CDN.
 * No wildcard or arbitrary user-entered network destinations are permitted.
 */
export const UTILITIES_MODEL_DOWNLOAD_ORIGINS = [
  "https://huggingface.co",
  "https://cdn.jsdelivr.net",
  "https://us.aws.cdn.hf.co",
  "https://cdn-lfs.huggingface.co",
  "https://cdn-lfs.hf.co",
  "https://cdn-lfs-us-1.hf.co",
  "https://cas-bridge.xethub.hf.co",
] as const;

export function utilitiesAppCsp({ baseUri = "'none'", frameAncestors = false }: { baseUri?: "'none'" | "'self'"; frameAncestors?: boolean } = {}): string {
  return [
    "default-src 'self'",
    `base-uri ${baseUri}`,
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
    "worker-src 'self' blob: https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${UTILITIES_MODEL_DOWNLOAD_ORIGINS.join(" ")}`,
    "frame-src blob:",
    ...(frameAncestors ? ["frame-ancestors 'self'"] : []),
  ].join("; ");
}
