/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 4,
  fingerprint: "e322249c58097a9c095e59d848854ea3f06f3120776919da015ca72456a381d9",
} as const;
