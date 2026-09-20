import { describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { Kysely } from "kysely";
import { createManifestDb } from "../../../packages/gateway/src/sync/db-impl.js";
import type { SyncDatabase } from "../../../packages/gateway/src/sync/sharing-db.js";

describe("PostgreSQL manifest lock", () => {
  it("acquires a runtime-scoped advisory lock with a valid PostgreSQL text parameter", async () => {
    const pg = await KyselyPGlite.create();
    const db = new Kysely<SyncDatabase>({ dialect: pg.dialect });
    try {
      const manifestDb = createManifestDb(db);
      await expect(manifestDb.withAdvisoryLock(
        { ownerId: "owner", runtimeSlot: "secondary" },
        async () => "locked",
      )).resolves.toBe("locked");
    } finally {
      await db.destroy();
    }
  });
});
