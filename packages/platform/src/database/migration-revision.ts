/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 2,
  fingerprint: "fbc3cd22568e6bcc8aa456636865efe6aef381e75826acfc1d26fb4f4e951203",
} as const;
