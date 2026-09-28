/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 5,
  fingerprint: "c62eca798d1c986a5a69ae11e6dadebc2b32c46d968931ee9d773bbdf6a44f4b",
} as const;
