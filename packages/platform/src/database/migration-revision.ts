/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, core migrations, and their DDL
 * helper. WhatsApp owns an independent revision. Older Cloud Run instances
 * skip newer generations during rollouts.
 * An integration merge needs a generation above both deployed predecessors;
 * refreshing the fingerprint at their generation would fail closed on startup.
 * Dependent branches must rebase and allocate a new generation after landing. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 33,
  fingerprint: "ed0ec857d51f0b2e8dec6b64ae1fd4f568544118edb5a102ad7fdb438398a92a",
} as const;
