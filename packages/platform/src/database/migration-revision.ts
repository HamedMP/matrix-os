/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 4,
  fingerprint: "312663d91c55f26f503cc2a31a211e317f497ef93bfcf36e25000a57f83ec8e9",
} as const;
