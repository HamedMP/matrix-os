import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("platform database startup migration", () => {
  it("serializes the full schema migration on one transaction-scoped advisory lock", async () => {
    const source = await readFile("packages/platform/src/db.ts", "utf8");
    const wrapperStart = source.indexOf("async function migrate(");
    const schemaStart = source.indexOf("async function migrateSchema(");

    expect(wrapperStart).toBeGreaterThanOrEqual(0);
    expect(schemaStart).toBeGreaterThan(wrapperStart);

    const wrapper = source.slice(wrapperStart, schemaStart);
    expect(wrapper).toContain("db.transaction().execute");
    expect(wrapper).toContain("pg_advisory_xact_lock");
    expect(wrapper).toContain("matrix_os_platform_schema_migration");
    expect(wrapper).toContain("await migrateSchema(trx)");
  });
});
