import sharp from "sharp";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { createPlatformCollaborationTestDatabase, destroyPlatformCollaborationTestDatabase, type PlatformCollaborationTestDatabase } from "./collaboration-test-support.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const icon = await sharp({ create: { width: 200, height: 200, channels: 4, background: "#e02f70" } }).png({ compressionLevel: 0 }).toBuffer();
const sha256 = createHash("sha256").update(icon).digest("hex");

describe("preview shared-app icon migration", () => {
  let fixture: PlatformCollaborationTestDatabase;
  beforeEach(async () => {
    fixture = await createPlatformCollaborationTestDatabase();
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    await sql`CREATE TABLE collaboration_app_icons (runtime_id TEXT, sha256 TEXT, content_type TEXT, bytes BYTEA,
      created_at TIMESTAMPTZ DEFAULT now(), last_uploaded_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(runtime_id, sha256))`.execute(fixture.collaborationDb);
    await sql`INSERT INTO collaboration_app_icons(runtime_id, sha256, content_type, bytes)
      VALUES ('runtime_owner', ${sha256}, 'image/png', ${icon}), ('other_runtime', ${sha256}, 'image/png', ${icon})`.execute(fixture.collaborationDb);
    await sql`INSERT INTO collaboration_directory(scope_id, runtime_id, owner_id, kind, authority_generation,
      metadata_revision, last_event_id, app_state, app_name, app_icon_sha256)
      VALUES (${scopeId}::uuid, 'runtime_owner', 'user_owner', 'app', 1, 7,
      '20000000-0000-4000-8000-000000000001', 'active', 'Owner Artwork', ${sha256})`.execute(fixture.collaborationDb);
  });
  afterEach(async () => { await destroyPlatformCollaborationTestDatabase(fixture); });

  it("converts referenced large artwork before dropping the obsolete table, preserving name/revision", async () => {
    expect(icon.length).toBeGreaterThan(48 * 1024);
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    const row = await fixture.collaborationDb.selectFrom("collaboration_directory").selectAll().executeTakeFirstOrThrow();
    expect(row.app_name).toBe("Owner Artwork");
    expect(Number(row.metadata_revision)).toBe(7);
    expect(row.app_icon_bytes!.length).toBeLessThanOrEqual(48 * 1024);
    expect((await sharp(row.app_icon_bytes!).metadata()).width).toBe(96);
    expect(row.app_icon_sha256).toBe(createHash("sha256").update(row.app_icon_bytes!).digest("hex"));
    expect((await sql<{ present: boolean }>`SELECT to_regclass('collaboration_app_icons') IS NOT NULL AS present`.execute(fixture.collaborationDb)).rows[0]?.present).toBe(false);
  });

  it.each(["stopped", "dangling", "corrupt"])("clears %s artwork instead of retaining orphan bytes", async (kind) => {
    if (kind === "stopped") await fixture.collaborationDb.updateTable("collaboration_directory").set({ app_state: "stopped" }).execute();
    if (kind === "dangling") await fixture.collaborationDb.updateTable("collaboration_directory").set({ runtime_id: "missing_runtime" }).execute();
    if (kind === "corrupt") await sql`UPDATE collaboration_app_icons SET bytes = ${Buffer.from("not an image")}`.execute(fixture.collaborationDb);
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    expect(await fixture.collaborationDb.selectFrom("collaboration_directory").select(["app_icon_sha256", "app_icon_bytes"]).executeTakeFirstOrThrow())
      .toEqual({ app_icon_sha256: null, app_icon_bytes: null });
  });

  it("rolls back conversion and preserves the preview table on a database write failure", async () => {
    await sql`CREATE FUNCTION reject_thumbnail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'thumbnail_write_failed'; END $$`.execute(fixture.collaborationDb);
    await sql`CREATE TRIGGER reject_thumbnail BEFORE UPDATE ON collaboration_directory FOR EACH ROW EXECUTE FUNCTION reject_thumbnail()`.execute(fixture.collaborationDb);
    await expect(bootstrapPlatformCollaborationDatabase(fixture.collaborationDb)).rejects.toThrow("thumbnail_write_failed");
    expect((await sql`SELECT * FROM collaboration_app_icons`.execute(fixture.collaborationDb)).rows).toHaveLength(2);
    expect((await fixture.collaborationDb.selectFrom("collaboration_directory").select("app_icon_sha256").executeTakeFirstOrThrow()).app_icon_sha256).toBe(sha256);
  });
});
