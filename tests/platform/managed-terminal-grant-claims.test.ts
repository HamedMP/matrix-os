import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createManagedTerminalGrantClaims } from "../../packages/platform/src/managed-terminal-grant-claims.js";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const source = { ownerId: "user_owner", sourceMachineId: "machine_a", sourceRuntimeSlot: "primary", sourceEpoch: 1 };
const turn = {
  ...source, chatId: "chat_test", clientRequestId: "turn_test", runId: "run_test", nonce: "nonce_fixture",
  worktreeId: "wt_1111111111111111",
  bodyDigest: "d".repeat(64),
  workspaceId: "tws_6d6774" + "0".repeat(26), tabId: "tt_" + "a".repeat(32), revision: "b".repeat(64),
};
const now = 1_800_000_000_000;
const input = { ...turn, activateBefore: now + 30_000, expiresAt: now + 120_000 };
let db: PlatformDB;
beforeAll(async () => { ({ db } = await createTestPlatformDb()); });
afterAll(async () => { await destroyTestPlatformDb(db); });

describe("durable managed terminal owner grant run claim", () => {
  it("binds one turn across Platform processes and rejects replay into another run or terminal", async () => {
    const first = createManagedTerminalGrantClaims(db, () => now);
    const replica = createManagedTerminalGrantClaims(db, () => now + 1);
    expect(await first.claim(input)).toBe(true);
    expect(await replica.claim(input)).toBe(true);
    expect(await replica.claim({ ...input, runId: "run_other" })).toBe(false);
    expect(await replica.claim({ ...input, nonce: "new_proof", runId: "run_other" })).toBe(false);
    expect(await replica.claim({ ...input, nonce: "new_proof", tabId: "tt_" + "f".repeat(32) })).toBe(false);
    expect(await replica.claim({ ...input, nonce: "new_proof", bodyDigest: "f".repeat(64) })).toBe(false);
    expect(await replica.claim({ ...input, nonce: "new_proof", clientRequestId: "turn_other" })).toBe(false);
  });

  it("allows only one live run when Platform replicas claim the same browser turn concurrently", async () => {
    const first = { ...input, clientRequestId: "race_turn", runId: "race_one", nonce: "race_one" };
    const competing = { ...first, runId: "race_two", nonce: "race_two" };
    const left = createManagedTerminalGrantClaims(db, () => now);
    const right = createManagedTerminalGrantClaims(db, () => now);
    const claims = await Promise.all([left.claim(first), right.claim(competing)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("denies activation after the deadline and does not let a retry extend the original lease", async () => {
    const deadline = createManagedTerminalGrantClaims(db, () => now + 45_000);
    expect(await deadline.claim({ ...input, clientRequestId: "unclaimed_turn", runId: "unclaimed_run" })).toBe(false);
    expect(await deadline.claim(input)).toBe(true);
    const after = createManagedTerminalGrantClaims(db, () => now + 130_000);
    expect(await after.claim({ ...input, activateBefore: now + 140_000, expiresAt: now + 240_000 })).toBe(false);
  });

  it("fences actual owner cancellation before and after the first request", async () => {
    const replica = createManagedTerminalGrantClaims(db, () => now + 2);
    const stopBefore = { ...input, clientRequestId: "turn_cancel", runId: "run_cancel" };
    await replica.revoke(stopBefore, stopBefore.chatId, stopBefore.runId);
    expect(await replica.claim(stopBefore)).toBe(false);
    const stopAfter = { ...input, clientRequestId: "turn_active", runId: "run_active", nonce: "nonce_active" };
    expect(await replica.claim(stopAfter)).toBe(true);
    await replica.revoke({ ...stopAfter, ownerId: "user_unrelated" }, stopAfter.chatId, stopAfter.runId);
    expect(await replica.claim(stopAfter)).toBe(true);
    await replica.revoke(stopAfter, stopAfter.chatId, stopAfter.runId);
    expect(await replica.claim(stopAfter)).toBe(false);
  });
});
