/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 7,
  fingerprint: "c995527e209702dcaac1e0a5bce3cedcc3cd708ec877aa8a44abea93dfb406f0",
} as const;
