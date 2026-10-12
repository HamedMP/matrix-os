// Browser-safe shared display policy. The detached runner imports this .mjs
// subpath with plain Node; schemas and renderer bundles use the same predicate.
export const MAX_COMMAND_PREVIEW_CHARS = 4000;
export const MAX_COMMAND_PREVIEW_BYTES = 16 * 1024;
export const MAX_PUBLIC_COMMAND_PREVIEW_CHARS = 1000;
export const MAX_PUBLIC_COMMAND_PREVIEW_BYTES = 4000;
const encoder = new TextEncoder();
const CREDENTIAL = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|(?:aws_)?secret(?:_access_key)?["']?\s*[=:]|session(?:id|_id|token|_token)?["']?\s*[=:]|(?:api[_-]?(?:key|token)|authorization|cookie|credential|password|secret|token)["']?\s*(?:=|:)|(?:^|\s)--?(?:api[_-]?(?:key|token)|access[_-]?token|password|secret|token)(?:=|\s+)\S|bearer\s+|sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}|-----BEGIN .*PRIVATE KEY/i;

export function isAllowedCommandPreview(value) {
  return typeof value === "string" && value.trim().length > 0
    && value.length <= MAX_COMMAND_PREVIEW_CHARS
    && encoder.encode(value).byteLength <= MAX_COMMAND_PREVIEW_BYTES
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    && !CREDENTIAL.test(value);
}
