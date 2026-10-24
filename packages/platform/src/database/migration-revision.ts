/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, core migrations, and their DDL
 * helper. WhatsApp owns an independent revision. Older Cloud Run instances
 * skip newer generations during rollouts.
 * An integration merge needs a generation above both deployed predecessors;
 * refreshing the fingerprint at their generation would fail closed on startup.
 * Dependent branches must rebase and allocate a new generation after landing. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 23,
  fingerprint: "588aa2cb52e99cfd8d48cf0ddd92f5f663aa266f2a5a1b40b099f7b92af5d3f0",
} as const;
