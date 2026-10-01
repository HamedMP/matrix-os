/**
 * The organization a member is placed in when they have not chosen one.
 *
 * Organizations are added by Matrix, not created by users, so a member never has to
 * activate one: if they belong to any, the oldest is active by default and the account
 * menu only switches between them. A user in none stays individual and sees sharing
 * disabled.
 *
 * Clerk ids are KSUIDs -- base62 with a leading timestamp -- so plain code-unit order is
 * creation order. One rule over ids lets Web (Clerk memberships) and Electron Desktop
 * (the platform's membership projection, which keeps no Clerk creation time) agree.
 */
export function pickDefaultOrganizationId(organizationIds: readonly string[]): string | null {
  let oldest: string | null = null;
  for (const id of organizationIds) {
    if (oldest === null || id < oldest) oldest = id;
  }
  return oldest;
}
