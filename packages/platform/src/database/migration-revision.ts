/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, core migrations, and their DDL
 * helper. WhatsApp owns an independent revision. Older Cloud Run instances
 * skip newer generations during rollouts.
 * An integration merge needs a generation above both deployed predecessors;
 * refreshing the fingerprint at their generation would fail closed on startup.
 * Dependent branches must rebase and allocate a new generation after landing. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 32,
  fingerprint: "f4bb53e49fcedadc72f654e951e1315f3b3dfd5d60d8d1a5353441c36c29b9d4",
} as const;
