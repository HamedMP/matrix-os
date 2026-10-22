import { describe, expect, it, vi } from "vitest";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { ChatAgentClient } from "../../packages/ui/src/chat-agents/client.js";
import { BotClientError, createBotClient } from "../../packages/ui/src/chat-agents/bots/client.js";
import { AppError } from "../../desktop/src/shared/app-error.js";
import { legacyChatNavigation } from "../../packages/ui/src/chat-navigation/legacy.js";
import { ChatNavigationAuthorityRevoked } from "../../packages/ui/src/chat-navigation/store.js";

function record(id: string): CanonicalChatRecord {
  return { chat: { id, title: id, titleVersion: 1, revision: 1, lifecycle: "active", attention: "none", messageCount: 0,
    ownerScope: { type: "personal", ownerId: "test-owner" }, createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" } };
}
function fixture() {
  const list = vi.fn(async () => ({ enabled: true, agents: [] }));
  const directChat = vi.fn(async (_id: string): Promise<string | null> => null);
  const directBot = vi.fn(async (_id: string): Promise<string | null> => null);
  const client = { list, bots: { directChat, directBot } } as unknown as ChatAgentClient;
  return { client, list, directChat, directBot };
}
describe("legacy navigation classification failure isolation", () => {
  it("preserves Desktop unauthorized errors through the real Bot client wrapper", async () => {
    const { client } = fixture();
    client.bots = createBotClient(async () => { throw new AppError("unauthorized"); });
    await expect(legacyChatNavigation([record("chat_one")], client)).rejects.toBeInstanceOf(ChatNavigationAuthorityRevoked);
  });
  it("publishes successful ordinary and Bot bindings together after a failed identity, excluding unknowns", async () => {
    const { client, directBot } = fixture();
    let resolve!: (value: string | null) => void;
    const slow = new Promise<string | null>(done => { resolve = done; });
    directBot.mockImplementation(async id => {
      if (id === "chat_failed") throw new BotClientError(503, "Unavailable");
      if (id === "chat_bot") return "bot_known001";
      if (id === "chat_slow") return slow;
      return null;
    });
    const publish = vi.fn();
    const result = legacyChatNavigation(["chat_fast", "chat_failed", "chat_bot", "chat_slow", "chat_last"].map(record), client).then(publish, error => ({ error }));
    await vi.waitFor(() => expect(directBot).toHaveBeenCalledTimes(5));
    expect(publish).not.toHaveBeenCalled();
    resolve(null);
    expect(await result).toBeUndefined();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]![0].items.map((item: { chat: { id: string }; classification: unknown }) => [item.chat.id, item.classification])).toEqual([
      ["chat_fast", { kind: "ordinary" }], ["chat_bot", { kind: "bot", agentId: "bot_known001" }],
      ["chat_slow", { kind: "ordinary" }], ["chat_last", { kind: "ordinary" }],
    ]);
  });
  it("continues classification when one library direct-Chat read fails", async () => {
    const { client, list, directChat, directBot } = fixture();
    list.mockResolvedValue({ enabled: true, agents: [{ id: "bot_bad00001" }, { id: "bot_good0001" }] } as never);
    directChat.mockImplementation(async id => { if (id === "bot_bad00001") throw new BotClientError(503, "Unavailable"); return "chat_bot"; });
    const result = await legacyChatNavigation([record("chat_ordinary"), record("chat_bot")], client);
    expect(result.items.map(item => item.classification)).toEqual([{ kind: "ordinary" }, { kind: "bot", agentId: "bot_good0001" }]);
    expect(directBot).toHaveBeenCalledExactlyOnceWith("chat_ordinary");
  });
  it.each([401, 403])("rejects the whole cohort for authorization failure %i at every discovery boundary", async status => {
    for (const boundary of ["library", "directChat", "directBot"] as const) {
      const { client, list, directChat, directBot } = fixture();
      const error = new BotClientError(status, "Unavailable");
      if (boundary === "library") list.mockRejectedValue(error);
      if (boundary === "directChat") {
        list.mockResolvedValue({ enabled: true, agents: [{ id: "bot_one00001" }] } as never);
        directChat.mockRejectedValue(error);
      }
      if (boundary === "directBot") directBot.mockRejectedValue(error);
      await expect(legacyChatNavigation([record("chat_one")], client)).rejects.toBeInstanceOf(ChatNavigationAuthorityRevoked);
    }
  });
});
