import { JEV_EMAIL_TRIAGE_ANSWER_IDS, JEV_MODEL_ID, type JevEmailTriageResult } from "@matrix-os/contracts";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JevEvaluationRepository } from "../../packages/gateway/src/jev/repository.js";

const completed: JevEmailTriageResult = {
  requestId: "jev_req_request_123",
  recipe: "email-triage-v1",
  model: JEV_MODEL_ID,
  latencyMs: 1,
  answers: JEV_EMAIL_TRIAGE_ANSWER_IDS.map((id) => ({ id, type: "boolean", probability: 0.5 })),
};
const key = { ownerId: "owner_a", idempotencyKey: "thread:abc123", payloadHash: "a".repeat(64) };

describe("Jev evaluation repository", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: JevEvaluationRepository;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    repository = new JevEvaluationRepository(pglite.dialect, {
      now: () => new Date("2026-09-22T10:00:00.000Z"),
    });
    await repository.bootstrap();
  });

  afterEach(async () => repository.destroy());

  it("atomically claims and returns a completed result within the owner scope", async () => {
    const [first, second] = await Promise.all([repository.claim(key), repository.claim(key)]);
    expect([first.kind, second.kind].sort()).toEqual(["claimed", "pending"]);
    await repository.complete({ ...key, result: completed });
    await expect(repository.claim(key)).resolves.toEqual({ kind: "completed", result: completed });
    await expect(repository.claim({ ...key, ownerId: "owner_b" })).resolves.toEqual({ kind: "claimed" });
  });

  it("detects changed payloads and preserves unknown outcomes", async () => {
    await repository.claim(key);
    await expect(repository.claim({ ...key, payloadHash: "b".repeat(64) })).resolves.toEqual({ kind: "conflict" });
    await repository.markUnknown(key);
    await expect(repository.claim(key)).resolves.toEqual({ kind: "unknown" });
  });

  it("releases only matching pending claims", async () => {
    await repository.claim(key);
    await repository.release({ ...key, payloadHash: "b".repeat(64) });
    await expect(repository.claim(key)).resolves.toEqual({ kind: "pending" });
    await repository.release(key);
    await expect(repository.claim(key)).resolves.toEqual({ kind: "claimed" });
  });
});
