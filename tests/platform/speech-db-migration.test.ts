import { KyselyPGlite } from "kysely-pglite";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createPlatformDb, insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { destroyTestPlatformDb } from "./platform-db-test-helper.js";

const now = "2026-09-10T00:00:00.000Z";

function legacyInvalidRow(operationId: string) {
  return {
    owner_id: "user_speech_upgrade",
    machine_id: "machine_speech_upgrade",
    runtime_slot: "primary",
    operation_id: operationId,
    source_kind: "dictation" as const,
    content_fingerprint: "a".repeat(64),
    policy_revision: "speech-policy-1",
    adapter_id: "adapter-a",
    model_id: "model-a",
    funding_reservation_id: "funding_legacy",
    execution_state: "succeeded" as const,
    cancellation_requested: false,
    tombstone: false,
    dispatch_claimed_at: null,
    safe_outcome_code: null,
    audio_duration_ms: 1_000,
    reserved_microusd: 20,
    actual_microusd: null,
    created_at: now,
    updated_at: now,
    expires_at: "2026-09-11T00:00:00.000Z",
  };
}

describe("speech lifecycle constraint migration", () => {
  it("does not block startup on a legacy row but enforces new writes", async () => {
    const instance = await KyselyPGlite.create();
    const original = createPlatformDb({ dialect: instance.dialect });
    let upgraded: PlatformDB | undefined;
    try {
      await original.ready;
      await insertUserMachine(original, {
        machineId: "machine_speech_upgrade",
        clerkUserId: "user_speech_upgrade",
        handle: "speech-upgrade",
        runtimeSlot: "primary",
        status: "running",
        imageVersion: "v1",
        provisionedAt: "2026-09-09T00:00:00.000Z",
        activationState: "authorized",
      });
      await sql`ALTER TABLE speech_operations DROP CONSTRAINT speech_operation_lifecycle_shape`
        .execute(original.executor);
      await original.executor.insertInto("speech_operations").values(
        legacyInvalidRow("sp_1788998400000_legacyinvalidrow"),
      ).execute();

      upgraded = createPlatformDb({ dialect: instance.dialect });
      await expect(upgraded.ready).resolves.toBeUndefined();
      await expect(upgraded.executor.insertInto("speech_operations").values(
        legacyInvalidRow("sp_1788998400000_newinvalidrowdata"),
      ).execute()).rejects.toThrow();
    } finally {
      await destroyTestPlatformDb(upgraded ?? original);
    }
  });
});
