/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 6,
  fingerprint: "053b205ef5d67a9c5fe8648aa8ba3c0ffebeedfb366df32c2da160ca0d950433",
} as const;
