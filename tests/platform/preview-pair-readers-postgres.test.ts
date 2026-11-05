import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { authorizePreviewPairReader } from "../../packages/platform/src/preview-pair/readers.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("report ownership uses canonical leases and verifier-assigned identity domains", () => {
  let fixture: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { fixture = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await fixture?.destroy(); });
  const principal = (actorId: string, kind: "control" | "preview" = "preview") => ({ actorId, kind, expiresAt: PAIR_NOW + 60_000 });
  const maintainer = async (actorId: string) => actorId === "user_maintainer";
  it.each(["user_pair_owner", "user_pair_member"])("allows leased test actor %s", async actor => {
    expect((await authorizePreviewPairReader(fixture.db, fixture.pair.pair_id, principal(actor), maintainer, PAIR_NOW)).pair_id).toBe(fixture.pair.pair_id);
  });
  it.each(["user_requester", "user_maintainer"])("allows real control-plane requester/maintainer %s", async actor => {
    expect((await authorizePreviewPairReader(fixture.db, fixture.pair.pair_id, principal(actor, "control"), maintainer, PAIR_NOW)).pair_id).toBe(fixture.pair.pair_id);
  });
  it.each([["user_pair_outsider", "preview"], ["user_pair_owner", "control"], ["user_requester", "preview"]] as const)(
    "denies outsider or wrong issuer domain %s/%s", async (actor, kind) => {
      await expect(authorizePreviewPairReader(fixture.db, fixture.pair.pair_id, principal(actor, kind), maintainer, PAIR_NOW))
        .rejects.toMatchObject({ status: 404 });
    });
  it("denies an expired real session before report access", async () => {
    await expect(authorizePreviewPairReader(fixture.db, fixture.pair.pair_id,
      { ...principal("user_requester", "control"), expiresAt: PAIR_NOW }, maintainer, PAIR_NOW)).rejects.toMatchObject({ status: 401 });
  });
  it("a released fixture no longer grants access to a past run", async () => {
    await fixture.db.executor.updateTable("preview_pair_fixtures").set({ active_pair_id: null }).execute();
    await expect(authorizePreviewPairReader(fixture.db, fixture.pair.pair_id, principal("user_pair_owner"), maintainer, PAIR_NOW))
      .rejects.toMatchObject({ status: 404 });
  });
});
