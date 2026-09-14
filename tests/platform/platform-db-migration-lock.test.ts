import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("platform database startup migration", () => {
  it("serializes the full schema migration on one transaction-scoped advisory lock", async () => {
    const source = await readFile("packages/platform/src/db.ts", "utf8");
    const wrapperStart = source.indexOf("async function migrate(");
    const schemaStart = source.indexOf("async function migrateSchema(");

    expect(wrapperStart).toBeGreaterThanOrEqual(0);
    expect(schemaStart).toBeGreaterThan(wrapperStart);

    expect(source.slice(wrapperStart, schemaStart)).toContain('await runPlatformMigration(db, migrateSchema)');
    const wrapper = await readFile('packages/platform/src/migration-runner.ts', 'utf8');
    const transactionStart = wrapper.indexOf("await db.transaction().execute");
    const callbackStart = wrapper.indexOf("=> {", transactionStart);
    const lockStart = wrapper.indexOf("pg_advisory_xact_lock", callbackStart);
    const lockExecution = wrapper.indexOf(".execute(transaction)", lockStart);
    const schemaMigration = wrapper.indexOf("await migrateSchema(transaction)", lockExecution);
    const transactionEnd = wrapper.lastIndexOf("});");

    expect(transactionStart).toBeGreaterThanOrEqual(0);
    expect(callbackStart).toBeGreaterThan(transactionStart);
    expect(lockStart).toBeGreaterThan(callbackStart);
    expect(lockExecution).toBeGreaterThan(lockStart);
    expect(schemaMigration).toBeGreaterThan(lockExecution);
    expect(transactionEnd).toBeGreaterThan(schemaMigration);
    expect(wrapper.slice(lockStart, lockExecution)).toContain(
      "matrix_os_platform_schema_migration",
    );
  });
});
