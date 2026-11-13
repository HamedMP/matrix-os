/** Full pages: 20 of them cover the 2,000-member organization limit. */
export const ORGANIZATION_MEMBER_PAGE_SIZE = 100;

/** One members page request, in the exact shape the platform client allows. */
export function organizationMembersPath(organizationId: string, { cursor, profileImages = false }: { cursor?: string; profileImages?: boolean } = {}): string {
  const query = new URLSearchParams({ limit: String(ORGANIZATION_MEMBER_PAGE_SIZE) });
  if (cursor) query.set("cursor", cursor);
  if (profileImages) query.set("include", "imageUrl");
  return `/api/organizations/${organizationId}/members?${query}`;
}
