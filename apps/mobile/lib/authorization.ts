/** Gateway clients and request helpers share the same Clerk/Basic credential format. */
export function formatAuthorizationHeader(token: string | undefined): string | undefined {
  if (!token) return undefined;
  if (/^(Basic|Bearer)\s+/i.test(token)) return token;
  return `Bearer ${token}`;
}
