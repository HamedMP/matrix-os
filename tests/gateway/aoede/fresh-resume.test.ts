import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AoedeStartRequestSchema } from "@matrix-os/contracts";
import { createAoedeSessionService } from "../../../packages/gateway/src/aoede/session.js";

it("accepts only UUID explicit resume sources", () => {
  expect(AoedeStartRequestSchema.safeParse({ clientRequestId: randomUUID(), sdp: "offer", resumeSessionId: randomUUID() }).success).toBe(true);
  expect(AoedeStartRequestSchema.safeParse({ clientRequestId: randomUUID(), sdp: "offer", resumeSessionId: "other" }).success).toBe(false);
});

it.each([false, true])("fresh/resume=%s binds only the chosen conversation and fingerprints the choice", async resume => {
  const prior = { id: randomUUID(), owner_id: "owner", runtime_id: "runtime", chat_id: "chat_old",
    checkpoint: [{ role: "user", text: "old words", offset: 0 }], checkpoint_until: new Date(Date.now() + 60_000) };
  const row = { ...prior, id: randomUUID(), state: "connecting", checkpoint: [], checkpoint_epoch: 0,
    started_at: new Date(), provider_id: null, chat_id: null };
  const reserve = vi.fn(async () => ({ record: row, created: true }));
  const update = vi.fn(async (_id, values) => { Object.assign(row, values); return true; });
  const repository = { ownerId: "owner", runtimeId: "runtime", latest: async () => prior,
    get: async () => prior, reserve, update, expireRecovery: async () => {}, interrupt: async () => [],
    checkpoint: async () => {}, beginClose: async () => {} };
  const mint = vi.fn(async () => ({ providerSessionId: "live_test", sdp: "answer" }));
  const service = createAoedeSessionService({ repository: repository as any, finalizationMs: 1,
    platform: { ownerId: "owner", runtimeId: "runtime", mint, attach: async () => ({ send() {}, close() {} }), close: async () => {} } });
  try {
    await service.start({ userId: "owner", source: "jwt" }, { clientRequestId: randomUUID(), sdp: "offer",
      ...(resume ? { resumeSessionId: prior.id } : {}) });
    expect(row.chat_id).toBe(resume ? "chat_old" : `chat_aoede_${row.id}`);
    expect(JSON.stringify(mint.mock.calls)).toContain(resume ? "old words" : "instructions");
    if (!resume) expect(JSON.stringify(mint.mock.calls)).not.toContain("old words");
    expect(reserve.mock.calls[0][1]).toBeDefined();
  } finally { await service.shutdown(); }
});
