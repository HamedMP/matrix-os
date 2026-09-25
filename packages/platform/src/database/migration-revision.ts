/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 1,
  fingerprint: "34a1fe0b4b073496afd88c683a53ac5941f7ba4de13a67a88e6d97b62dde952c",
} as const;
