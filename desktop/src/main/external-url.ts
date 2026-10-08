const MAX_EXTERNAL_URL_LENGTH = 2048;

export function safeExternalHttpUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (_err: unknown) {
    return null;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.toString().length > MAX_EXTERNAL_URL_LENGTH
  ) {
    return null;
  }
  return parsed.toString();
}

/** OAuth ID-token hints may exceed the ordinary external-link limit. */
export function safeChatgptAuthorizationUrl(raw: string): string | null {
  if (raw.length > 32768) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (_err: unknown) {
    return null;
  }
  if (parsed.origin !== "https://auth.openai.com"
    || parsed.pathname !== "/api/accounts/authorize"
    || parsed.username !== "" || parsed.password !== "" || parsed.hash !== ""
    || parsed.toString().length > 32768) return null;
  return parsed.toString();
}
