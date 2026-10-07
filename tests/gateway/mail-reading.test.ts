import { mailTestDatabase } from "./mail-test-database.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mailObjectNamespace } from "../../packages/gateway/src/mail/objects.js";
import { MailArchiveRepository } from "../../packages/gateway/src/mail/repository.js";
describe("mail reading CAS", () => {
  let repo: MailArchiveRepository;
  let cleanupDb: () => Promise<void>;
  let id: string;
  const scope = { ownerId: "owner", accountId: "account", appId: "edition" };
  beforeEach(async () => {
    const pg = await mailTestDatabase(); cleanupDb = pg.cleanup; repo = new MailArchiveRepository(pg.dialect); await repo.bootstrap();
    await repo.registerSource({ ownerId: "owner", accountId: "account", provider: "gmail", connectionId: "conn", email: "a@example.com", group: "personal" });
    const saved = await repo.saveMessage({ ownerId: "owner", accountId: "account", messageId: "msg", threadId: "t", sender: "s", subject: "subject", receivedAt: "2026-10-01T00:00:00Z", labels: [], object: { namespace: mailObjectNamespace("owner", "gmail", "conn"), digest: "b".repeat(64), sizeBytes: 5 } });
    if (saved.kind !== "saved") throw new Error("Expected saved"); id = saved.message.id;
    await repo.grantConsumer(scope);
  });
  afterEach(async () => { await repo.destroy(); await cleanupDb(); });
  it("creates once and rejects concurrent stale changes", async () => {
    const update = { ...scope, id, baseRevision: 0, saved: true, read: false, progress: 0.3 };
    const states = await Promise.all([repo.saveReadingState(update), repo.saveReadingState(update)]);
    expect(states.filter(Boolean)).toHaveLength(1);
    expect(await repo.getReadingState({ ...scope, id })).toMatchObject({ saved: true, read: false, progress: 0.3, revision: 1 });
    expect(await repo.saveReadingState({ ...update, baseRevision: 1, read: true, progress: 1 })).toMatchObject({ revision: 2 });
  });
  it("rechecks grants for reading changes and bounds progress", async () => {
    await expect(repo.saveReadingState({ ...scope, id, baseRevision: 0, saved: true, read: false, progress: 2 })).rejects.toThrow();
    await repo.revokeConsumer(scope);
    await expect(repo.saveReadingState({ ...scope, id, baseRevision: 0, saved: true, read: false, progress: 0 })).rejects.toThrow();
  });
});
