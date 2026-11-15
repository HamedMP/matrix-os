import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { CollaborativeAppPresentationRepository } from "../../packages/platform/src/collaboration/app-presentation-repository.js";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { createRealPlatformCollaborationTestDatabase } from "./collaboration-test-support.js";

const MiB = 1024 * 1024;
const windowMs = 60_000;

// The dedicated collaboration PostgreSQL lane supplies this URL and rejects skipped assertions.
describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("fleet-wide shared app artwork budget on real PostgreSQL", () => {
  it("never admits more than one member's budget across concurrent workers", async () => {
    const fixture = await createRealPlatformCollaborationTestDatabase();
    try {
      await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
      const now = Date.now();
      // Independent repositories stand in for separate platform workers sharing one database.
      const workers = Array.from({ length: 6 }, () => new CollaborativeAppPresentationRepository(fixture.collaborationDb));
      const results = await Promise.all(Array.from({ length: 40 }, (_, index) => workers[index % workers.length]!
        .reserveArtworkReadBytes({ actorId: "user_member", bytes: 4 * MiB, limit: 64 * MiB, windowMs, now })));
      expect(results.filter(Boolean)).toHaveLength(16);
      const [row] = await fixture.collaborationDb.selectFrom("collaboration_app_artwork_reads").selectAll().execute();
      expect(Number(row!.bytes)).toBe(64 * MiB);
    } finally {
      await fixture.destroy();
    }
  });

  it("skips expired rows another request holds instead of waiting or deadlocking", async () => {
    const fixture = await createRealPlatformCollaborationTestDatabase();
    const db = fixture.collaborationDb;
    try {
      await bootstrapPlatformCollaborationDatabase(db);
      const now = Date.now();
      const expired = new Date(Math.floor(now / windowMs) * windowMs - 5 * windowMs).toISOString();
      await db.insertInto("collaboration_app_artwork_reads").values([
        { actor_id: "user_member", window_start: expired, bytes: MiB },
        { actor_id: "user_other", window_start: expired, bytes: MiB },
      ]).execute();
      const repository = new CollaborativeAppPresentationRepository(db);
      await db.transaction().execute(async (trx) => {
        // Another request holds the other member's expired row for the whole reservation.
        await sql`SELECT 1 FROM collaboration_app_artwork_reads WHERE actor_id = 'user_other' FOR UPDATE`.execute(trx);
        const started = Date.now();
        await expect(repository.reserveArtworkReadBytes({ actorId: "user_member", bytes: MiB, limit: 64 * MiB, windowMs, now }))
          .resolves.toBe(true);
        // Well under the fixture's 2 s lock_timeout: the sweep never waited on the held row.
        expect(Date.now() - started).toBeLessThan(1_500);
      });
      const rows = await db.selectFrom("collaboration_app_artwork_reads").select(["actor_id", "window_start"])
        .orderBy("actor_id").execute();
      expect(rows.map((row) => row.actor_id)).toEqual(["user_member", "user_other"]);
      expect(new Date(rows[0]!.window_start).getTime()).toBe(Math.floor(now / windowMs) * windowMs);

      // Many members crossing into a new window at once all succeed: no deadlock aborts.
      const actors = Array.from({ length: 12 }, (_, index) => `user_${index}`);
      await db.insertInto("collaboration_app_artwork_reads")
        .values(actors.map((actorId) => ({ actor_id: actorId, window_start: expired, bytes: MiB }))).execute();
      const results = await Promise.all(actors.flatMap((actorId) => [0, 1].map(() =>
        repository.reserveArtworkReadBytes({ actorId, bytes: MiB, limit: 64 * MiB, windowMs, now }))));
      expect(results.every(Boolean)).toBe(true);
    } finally {
      await fixture.destroy();
    }
  });
});
