const FAILURE_PREFIX = /^(?:failed to authenticate\b|api error:\s*[45]\d\d\b)/i;
const STRUCTURED_AUTH_FAILURE = /["']?type["']?\s*:\s*["']authentication_error["']/i;
const INVALID_CREDENTIAL = /\b(?:api key|oauth token|credential)s?\s+(?:is|are)\s+invalid\b/i;

/**
 * Some provider CLIs return authentication failures in a nominally successful
 * SDK result. Treat only strongly error-shaped result text as a failure so
 * shells do not expose credential details as an assistant response.
 */
export function isKernelResultFailureText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const sample = value.trim().slice(0, 2_048);
  if (!sample) return false;
  return FAILURE_PREFIX.test(sample)
    || STRUCTURED_AUTH_FAILURE.test(sample)
    || INVALID_CREDENTIAL.test(sample);
}
