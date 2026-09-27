/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 4,
  fingerprint: "78dbcb282b561d50e7375509d1c69c3ba0159b1ced600a7d0e2f1033ef13c362",
} as const;
