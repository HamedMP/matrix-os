/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 5,
  fingerprint: "69067cd892775667f02e9a23fe46e8140643df6761c1641c3d46556f3a19a32d",
} as const;
