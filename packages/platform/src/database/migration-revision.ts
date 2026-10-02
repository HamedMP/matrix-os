/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 7,
  fingerprint: "e688c8412e2ea8a6403fdfc0d75ec7b2776c4a637f650e5eaf1e5d193ac97f35",
} as const;
