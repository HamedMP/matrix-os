/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 6,
  fingerprint: "a9f22eecd7bb6d75eb4eaa2f0e94973b3fcc21e97327fd438959f099486b9ba5",
} as const;
