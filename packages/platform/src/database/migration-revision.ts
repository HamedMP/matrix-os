/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 7,
  fingerprint: "b71b9829063bf03a3e46d4159adba4e82f576ab15143772230d67f630fc14283",
} as const;
