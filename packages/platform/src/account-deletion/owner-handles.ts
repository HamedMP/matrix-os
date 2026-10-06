import { sql } from 'kysely';

/** Historical runtime names may be reused. Retain another owner's current claim.
 * Keep the inventory in SQL; callers bound any rows returned to the worker. */
export function ownerHandlesQuery(owner: string) {
  return sql<string>`SELECT candidates.handle FROM
    (SELECT handle FROM users WHERE clerk_id = ${owner}
      UNION SELECT handle FROM containers WHERE clerk_user_id = ${owner}
      UNION SELECT handle FROM user_machines WHERE clerk_user_id = ${owner}) candidates
    WHERE NOT EXISTS (SELECT 1 FROM users current_identity
      WHERE current_identity.handle = candidates.handle AND current_identity.clerk_id <> ${owner})
    AND NOT EXISTS (SELECT 1 FROM containers current_container
      WHERE current_container.handle = candidates.handle AND current_container.clerk_user_id <> ${owner})
    AND NOT EXISTS (SELECT 1 FROM user_machines current_runtime
      WHERE current_runtime.handle = candidates.handle AND current_runtime.clerk_user_id <> ${owner}
        AND current_runtime.deleted_at IS NULL)`;
}
