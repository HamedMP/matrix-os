import { expect, it, vi } from "vitest";
import { createAoedeDelegation } from "../../../packages/gateway/src/aoede/delegate.js";

it.each(["unavailable", "setup_required", "auth_required"])("classifies explicit %s without timestamps", async availability => {
  const getCatalog = vi.fn(async () => ({ instances: [{ id: "codex_default", availability, supports: { rootChat: true } }] }));
  const delegate = createAoedeDelegation({ ownerId: "owner", sessionRepository: { ownerId: "owner", latestChatAssociation: async () => undefined } as any,
    repository: { get: async () => undefined } as any, catalog: { getCatalog } as any,
    orchestrator: {} as any, eventStream: {} as any, actions: {} as any });
  try {
    const results = await Promise.all([delegate.readiness({ userId: "owner", source: "jwt" }), delegate.readiness({ userId: "owner", source: "jwt" })]);
    expect(results.map(r => r.status)).toEqual([availability === "unavailable" ? "error" : "setup_required", availability === "unavailable" ? "error" : "setup_required"]);
  } finally { await delegate.shutdown(); }
});
