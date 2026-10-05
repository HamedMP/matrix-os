/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 6,
  fingerprint: "86d085b29b25b134dc3257090707534e9c2fe4e5a08df4731668447961848cb8",
} as const;
