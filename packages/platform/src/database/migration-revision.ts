/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 5,
  fingerprint: "f52b12be4525cc8a6d58d0c0852519710f2fcd68c20183c80a4f1a104fd7d305",
} as const;
