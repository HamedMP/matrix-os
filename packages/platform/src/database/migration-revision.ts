/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 2,
  fingerprint: "d6b5c7044ebc364c1beac840ff646e2496dbce4f3e9104ded65c1699bfd9ea1c",
} as const;
