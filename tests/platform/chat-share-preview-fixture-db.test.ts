import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedSpeechPreviewFixture } from "../../scripts/chat-share-preview-fixture.mjs";
import { type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const now = new Date("2026-09-13T12:00:00.000Z");

describe("chat share preview speech seed", () => {
  let db: PlatformDB;
  let client: { query: (text: string, values?: unknown[]) => Promise<unknown> };

  beforeEach(async () => {
    const created = await createTestPlatformDb();
    db = created.db;
    client = { query: (text, values) => created.instance.client.query(text, values) };
  });

  afterEach(async () => destroyTestPlatformDb(db));

  function activation(machineId: string, ownerId = "user_preview") {
    return {
      handle: "pr-1620", runtimeSlot: "pr-1620", address: "8.8.8.8",
      ownerId, machineId, speechOrigin: "https://pr-1620---preview.example.a.run.app",
      speechRuntimeToken: "a".repeat(64),
    };
  }

  it("is idempotent, funds a replacement machine once, and rejects ownership drift", async () => {
    await seedSpeechPreviewFixture(client, activation("machine_one"), now);
    await seedSpeechPreviewFixture(client, activation("machine_one"), now);
    let balance = await db.executor.selectFrom("ai_funded_runtime_balances")
      .select(["machine_id", "credit_balance_microusd"]).execute();
    expect(balance).toEqual([{ machine_id: "machine_one", credit_balance_microusd: 1_000_000 }]);

    await seedSpeechPreviewFixture(client, activation("machine_two"), now);
    balance = await db.executor.selectFrom("ai_funded_runtime_balances")
      .select(["machine_id", "credit_balance_microusd"]).execute();
    expect(balance).toEqual([{ machine_id: "machine_two", credit_balance_microusd: 1_000_000 }]);

    await expect(seedSpeechPreviewFixture(client, activation("machine_two", "user_other"), now))
      .rejects.toThrow("ownership mismatch");
    const machine = await db.executor.selectFrom("user_machines").select(["clerk_user_id"])
      .where("machine_id", "=", "machine_two").executeTakeFirstOrThrow();
    expect(machine.clerk_user_id).toBe("user_preview");
  });
});
