import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { describe, expect, it } from "vitest";
import {
  bootstrapOrganizationDriveDatabase,
  type OrganizationDriveDatabase,
} from "../../packages/gateway/src/organization-drive/database.js";

describe("owner-hosted organization drive schema", () => {
  it("keeps files in their organization and permits only one live path", async () => {
    const instance = await KyselyPGlite.create();
    const db = new Kysely<OrganizationDriveDatabase>({ dialect: instance.dialect });
    try {
      await bootstrapOrganizationDriveDatabase(db);
      await sql`INSERT INTO organization_drives (organization_id, scope_id, authority_runtime_id, authority_generation)
        VALUES ('org_example', '00000000-0000-4000-8000-000000000001', 'vps:home', 1)`.execute(db);
      await sql`INSERT INTO organization_drive_files (id, organization_id, path, current_version)
        VALUES ('00000000-0000-4000-8000-000000000002', 'org_example', 'reports/a.txt', 1)`.execute(db);
      await expect(sql`INSERT INTO organization_drive_files (id, organization_id, path, current_version)
        VALUES ('00000000-0000-4000-8000-000000000003', 'org_example', 'reports/a.txt', 1)`.execute(db)).rejects.toThrow();
      await sql`UPDATE organization_drive_files SET deleted_at = now() WHERE id = '00000000-0000-4000-8000-000000000002'`.execute(db);
      await sql`INSERT INTO organization_drive_files (id, organization_id, path, current_version)
        VALUES ('00000000-0000-4000-8000-000000000003', 'org_example', 'reports/a.txt', 1)`.execute(db);
      const live = await sql<{ count: string }>`SELECT count(*)::text AS count FROM organization_drive_files
        WHERE organization_id = 'org_example' AND deleted_at IS NULL`.execute(db);
      expect(live.rows[0]?.count).toBe("1");
    } finally {
      await db.destroy();
    }
  });
});
