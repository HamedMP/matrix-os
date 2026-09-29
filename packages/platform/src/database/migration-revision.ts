/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 5,
  fingerprint: "6b4f433f9f5bbb82eca21604ae840a6198eff80b6113fd0f93f47c8696f1a715",
} as const;
