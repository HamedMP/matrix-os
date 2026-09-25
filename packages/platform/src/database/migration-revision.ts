/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 3,
  fingerprint: "4451a920ba4270643904b8f1147f6d738c56b84c0c9d8ba966bf6304afdf31bb",
} as const;
