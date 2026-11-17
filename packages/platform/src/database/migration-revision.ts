/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, core migrations, and their DDL
 * helper. WhatsApp owns an independent revision. Older Cloud Run instances
 * skip newer generations during rollouts.
 * An integration merge needs a generation above both deployed predecessors;
 * refreshing the fingerprint at their generation would fail closed on startup.
 * Dependent branches must rebase and allocate a new generation after landing. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 27,
  fingerprint: "b86b7a53cc1170808a3ecd7f7949a0d7d2f066b2d3469caf27c31baa5cf18ae2",
} as const;
