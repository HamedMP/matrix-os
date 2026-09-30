/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 5,
  fingerprint: "c7af1500a88dd094ffd3b8e1966635d286b1c0b024e7bdd81f37f09e9776a72d",
} as const;
