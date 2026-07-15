// Display-level credential redaction for agent transcripts. Unlike the
// contracts' preview allowlist (which suppresses any text mentioning common
// coding vocabulary like "token" or "/Users/"), this masks only unambiguous
// credential material so full assistant messages stay readable. Applies at
// render time; transcripts are never persisted by the shell.

const REDACTED = "[redacted]";

// Order matters: connection-string credentials before generic assignments so
// the URL form keeps its scheme/host context.
const CREDENTIAL_PATTERNS: RegExp[] = [
  // user:password@ inside connection URLs (postgres://, mysql://, redis://...)
  /(?<=[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+(?=@)/gi,
  // Bearer tokens
  /\bbearer\s+[A-Za-z0-9._-]{8,}/gi,
  // OpenAI / Stripe style keys
  /\bsk[-_](?:live_|test_|proj-)?[A-Za-z0-9_-]{8,}/g,
  // AWS access key ids
  /\bAKIA[0-9A-Z]{16}\b/g,
  // JWTs
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
  // GitHub / GitLab / Slack tokens
  /\bghp_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{12,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Secret-named assignments (PASSWORD, AWS_SECRET_ACCESS_KEY, API_KEY,
  // AUTH_TOKEN, CLIENT_SECRET, ... — any prefixed name ending in a secret
  // word), quoted values masked through spaces up to the closing quote and
  // bare values up to whitespace.
  /(?<=\b[\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*")[^"\n]{1,256}/gi,
  /(?<=\b[\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*')[^'\n]{1,256}/gi,
  /(?<=\b[\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*`)[^`\n]{1,256}/gi,
  /(?<=\b[\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*)[^\s'"`]+/gi,
];

/**
 * Masks unambiguous credential material in transcript text while leaving
 * ordinary technical prose (paths, the words "token"/"secret", hostnames)
 * untouched.
 */
export function redactCredentialsForDisplay(text: string): string {
  let output = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  return output;
}
