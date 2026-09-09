import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import { retryAvailability } from "../../packages/gateway/src/chat/retry-preflight.js";
import { owner, principal } from "./helpers/canonical-codex-catalog.js";

describe("retry backing-state authorization and compatibility", () => {
  it("fails closed on inaccessible or invalid backing state and preserves other adapters", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "coding-retry-"));
    const threads = createCodingAgentThreadStore({ homePath, providers: [{ providerId: "codex",
      async startThread({ thread, nextEventId, now }) {
        return { events: [{ threadId: thread.id, eventId: nextEventId(), occurredAt: now().toISOString(),
          type: "thread.completed", outcome: "completed" }] };
      } }] });
    try {
      const created = await threads.createThread(principal, { providerId: "codex", prompt: "Inspect", clientRequestId: "req_retry" });
      const state = { conversationId: created.snapshot.thread.id };
      const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
      const stored = async () => ({ schemaVersion: 1, state });
      expect(await retryAvailability(adapter, owner, undefined, stored)).toBe("ready");
      expect(await retryAvailability(adapter, { type: "personal", ownerId: "different_owner" }, undefined, stored)).toBe("unavailable");
      expect(await retryAvailability(adapter, owner, undefined, async () => ({ schemaVersion: 1, state: { invalid: true } })))
        .toBe("unavailable");
      expect(await retryAvailability(adapter, owner, undefined, async () => null)).toBe("ready");
      expect(await retryAvailability(adapter, owner, undefined, async () => { throw "unavailable"; })).toBe("unavailable");
      expect(await retryAvailability(adapter, owner, undefined, async () => ({ schemaVersion: 2, state }))).toBe("unavailable");
      const other = createCanonicalCodingChatProviderAdapter({ providerId: "opencode", threads });
      expect(await retryAvailability(other, owner, state, stored)).toBe("ready");
    } finally {
      await threads.shutdownTurns();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
