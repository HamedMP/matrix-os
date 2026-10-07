/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, core migrations, and their DDL
 * helper. WhatsApp owns an independent revision. Older Cloud Run instances
 * skip newer generations during rollouts.
 * An integration merge needs a generation above both deployed predecessors;
 * refreshing the fingerprint at their generation would fail closed on startup.
 * Dependent branches must rebase and allocate a new generation after landing. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 15,
  fingerprint: "f691e3a76abc776f05366176c556f2e8d6e1dbbbb2593b96685f7afb8021cd3d",
} as const;
