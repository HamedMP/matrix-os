/** Bump generation and refresh the source fingerprint whenever a core schema
 * step changes. The test covers migrate.ts, migrations/*.ts, and their DDL
 * helper. Older Cloud Run instances skip newer generations during rollouts. */
export const PLATFORM_SCHEMA_REVISION = {
  generation: 4,
  fingerprint: "c2027263df6757fd7a3d5072d7deda5ef52b6bd6a135e6b811cf027d5860cc42",
} as const;
