import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createAoedeDelegation } from "../../../packages/gateway/src/aoede/delegate.js";

it.each(["unavailable", "setup_required", "auth_required"])("classifies explicit %s without timestamps", async availability => {
  const getCatalog = vi.fn(async () => ({ instances: [{ id: "codex_default", availability, supports: { rootChat: true } }] }));
  const delegate = createAoedeDelegation({ ownerId: "owner", sessionRepository: { ownerId: "owner", latestChatAssociation: async () => undefined } as any,
    repository: { get: async () => undefined } as any, catalog: { getCatalog } as any,
    orchestrator: {} as any, eventStream: {} as any, actions: {} as any });
  try {
    const results = await Promise.all([delegate.readiness({ userId: "owner", source: "jwt" }), delegate.readiness({ userId: "owner", source: "jwt" })]);
    expect(results.map(r => r.status)).toEqual([availability === "unavailable" ? "error" : "setup_required", availability === "unavailable" ? "error" : "setup_required"]);
    expect(getCatalog).toHaveBeenCalledTimes(1);
    await delegate.readiness({ userId: "owner", source: "jwt" });
    expect(getCatalog).toHaveBeenCalledTimes(2);
  } finally { await delegate.shutdown(); }
});

it.each([undefined, "chat_disappeared"])("retains deterministic legacy hydration fallback after association %s", async chatId => {
  const lookup = vi.fn(async () => chatId), get = vi.fn(async () => undefined);
  const delegate = createAoedeDelegation({ ownerId: "owner",
    sessionRepository: { ownerId: "owner", latestChatAssociation: lookup } as any,
    repository: { get } as any, catalog: { getCatalog: async () => ({ instances: [] }) } as any,
    orchestrator: {} as any, eventStream: {} as any, actions: {} as any });
  try {
    expect(await delegate.readiness({ userId: "owner", source: "jwt" })).toMatchObject({ status: "error" });
    const digest = createHash("sha256").update("aoede:owner").digest("hex").slice(0, 32);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(chatId ? 2 : 1);
    expect(get).toHaveBeenLastCalledWith({ type: "personal", ownerId: "owner" }, `chat_aoede_${digest}`);
  } finally { await delegate.shutdown(); }
});
