import type { Kysely } from 'kysely';
import type { GalleryDatabase } from './types.js';

export async function filterListingsByVisibility(
  db: Kysely<GalleryDatabase>,
  opts: { userId: string | undefined },
) {
  let query = db
    .selectFrom('app_listings')
    .selectAll()
    .where('status', '=', 'active');

  if (!opts.userId) {
    return query.where('visibility', '=', 'public').execute();
  }

  // Get org IDs where user is an active member
  const memberships = await db
    .selectFrom('org_memberships')
    .select('org_id')
    .where('user_id', '=', opts.userId)
    .where('status', '=', 'active')
    .execute();

  const orgIds = memberships.map((m) => m.org_id);

  if (orgIds.length === 0) {
    return query.where('visibility', '=', 'public').execute();
  }

  // Public OR (organization AND user is member of that org)
  return query
    .where((eb) =>
      eb.or([
        eb('visibility', '=', 'public'),
        eb.and([
          eb('visibility', '=', 'organization'),
          eb('org_id', 'in', orgIds),
        ]),
      ]),
    )
    .execute();
}
