const GMAIL_RETURN_PATH = /^\/auth\/gmail\?state=[A-Za-z0-9_-]{43}$/;
const GMAIL_RETURN_ORIGINS = ["https://app.matrix-os.com", "https://gmail-pilot.matrix-os.com"] as const;

/** Exact Gmail consent return from the platform or shell proxy, never an arbitrary redirect. */
export function gmailSignInReturnTarget(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (GMAIL_RETURN_PATH.test(value)) return value;
  return GMAIL_RETURN_ORIGINS.some(origin => value.startsWith(origin) && GMAIL_RETURN_PATH.test(value.slice(origin.length))) ? value : null;
}
