/** Real PostgreSQL proves connected-runtime filtering happens before the bounded delivery query. */
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { bootstrapPlatformOrganizationDatabase, type OrganizationPlatformDatabase } from "../../packages/platform/src/organizations/database.js";
import { PlatformOrganizationRepository } from "../../packages/platform/src/organizations/repository.js";
import { createCollaborationControlAuthority } from "../../packages/platform/src/collaboration/control-authority.js";
import { CollaborationControlStream } from "../../packages/platform/src/collaboration/control-stream.js";
import { createRealPlatformCollaborationTestDatabase } from "./collaboration-test-support.js";

const disconnectedRuntime = "vps-10000000-0000-4000-8000-00000000000a";
const connectedRuntime = "vps-10000000-0000-4000-8000-00000000000b";
const scopeId = "10000000-0000-4000-8000-000000000001";

describe("control denial delivery on real PostgreSQL", () => {
  it.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("delivers beyond 100 disconnected due rows without spending their attempts", async () => {
    const fixture = await createRealPlatformCollaborationTestDatabase();
    let clock = new Date("2026-09-20T12:00:00.000Z");
    const db = fixture.collaborationDb as unknown as Kysely<OrganizationPlatformDatabase>;
    try {
      await bootstrapPlatformOrganizationDatabase(db);
      const repository = new PlatformOrganizationRepository(db, { now: () => clock });
      const authority = createCollaborationControlAuthority({ repository, now: () => clock, affectedRuntimes: async () => [] });
      const stream = new CollaborationControlStream({
        controlAuthority: authority,
        tickets: { issueControlTicket: async () => undefined, consumeControlTicket: async () => true },
      });
      const sent: string[] = [];
      stream.attach(connectedRuntime, { send: (frame) => { sent.push(frame); }, close: () => undefined });
      try {
        for (let i = 0; i < 100; i += 1) {
          await repository.createDenial({ scopeId, generation: 1, fencedAt: new Date(clock.getTime() + i),
            ackDeadline: new Date(clock.getTime() + 120_000), runtimeIds: [disconnectedRuntime] });
        }
        const connected = await repository.createDenial({ scopeId, generation: 1, fencedAt: new Date(clock.getTime() + 100),
          ackDeadline: new Date(clock.getTime() + 120_000), runtimeIds: [connectedRuntime] });
        clock = new Date(clock.getTime() + 101);
        expect((await authority.sweep()).delivered).toBe(1);
        expect(sent).toHaveLength(1);
        expect(JSON.parse(sent[0]!)).toMatchObject({ type: "denial" });
        expect(await authority.describeOutbox(connected.denialId)).toEqual([
          { runtimeId: connectedRuntime, attempts: 1, deadLetter: false, acknowledgedAt: null },
        ]);
        const disconnected = await db.selectFrom("collaboration_denial_runtimes").select("attempts")
          .where("runtime_id", "=", disconnectedRuntime).execute();
        expect(disconnected).toHaveLength(100);
        expect(disconnected.every((row) => Number(row.attempts) === 0)).toBe(true);
      } finally {
        await stream.shutdown();
        await authority.shutdown();
      }
    } finally {
      await fixture.destroy();
    }
  });
});
