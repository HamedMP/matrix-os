/** Exact local Gmail consent return; never a general post-auth redirect. */
export function gmailSignInReturnTarget(value: unknown): string | null {
  return typeof value === "string" && /^\/auth\/gmail\?state=[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
