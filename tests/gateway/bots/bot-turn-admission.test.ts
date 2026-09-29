import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withBotProviderInstance } from "../../../packages/gateway/src/bots/provider-instance.js";
import { ChatAgentContext } from "../../../packages/gateway/src/chat/agent-context.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";

const owner = { type: "personal" as const, ownerId: "owner_bot_turns" };
const principal = { userId: owner.ownerId, source: "jwt" as const };
const BOT_CHAT = "chat_bot_direct";

let repository: ChatRepository;
let orchestrator: CanonicalChatOrchestrator;
let started: Array<{ selection: unknown; permissionMode: string }>;

beforeEach(async () => {
  repository = new ChatRepository((await KyselyPGlite.create()).dialect);
  await repository.bootstrap();
  started = [];
  const bot: CanonicalChatProviderAdapter<{ taskId: string }> = {
    driverKind: "matrix_bot",
    stateSchemaVersion: 1,
    parseState: (value) => value as { taskId: string },
    serializeState: (value) => value,
    async *start(input) {
      started.push({ selection: input.selection, permissionMode: input.permissionMode });
      yield { type: "assistant.delta", delta: "Hello" };
      yield { type: "run.completed", outcome: "completed" };
    },
  };
  orchestrator = new CanonicalChatOrchestrator({
    repository,
    catalog: withBotProviderInstance({ getCatalog: async () => ({ revision: "rev_bots", drivers: [], instances: [] }) }),
    adapters: new CanonicalChatProviderRegistry([bot]),
    agentContext: new ChatAgentContext({
      repository, agents: { get: vi.fn(async () => null) }, enabled: () => true,
      botChats: { directBot: async (_owner, chatId) => (chatId === BOT_CHAT ? "bot_0123456789abcdef01234567" : null) },
    }),
  });
  for (const id of [BOT_CHAT, "chat_ordinary"]) await repository.create(owner, { id, clientRequestId: `req_${id}`, title: id });
});
afterEach(async () => {
  await orchestrator.drain();
  await orchestrator.close();
  await repository.kysely.destroy();
});

describe("turns in a bot's chat", () => {
  it("run on the bot runtime with the bot's permission mode, whatever the client sent", async () => {
    const admitted = await orchestrator.admitTurn(principal, owner, BOT_CHAT, {
      clientRequestId: "req_turn_1", baseRevision: 0, parts: [{ type: "text", text: "Tighten my intro" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" }, interactionMode: "plan", permissionMode: "read_only",
    });
    expect(admitted.run).toMatchObject({ driverKind: "matrix_bot", instanceId: "matrix_bot_default", permissionMode: "default", interactionMode: "default" });
    await vi.waitFor(async () => expect((await repository.get(owner, BOT_CHAT))?.activeRun).toBeUndefined());
    expect(started).toEqual([{ selection: { instanceId: "matrix_bot_default", model: "auto" }, permissionMode: "default" }]);
  });

  it("are the only turns that can reach the bot runtime", async () => {
    await expect(orchestrator.admitTurn(principal, owner, "chat_ordinary", {
      clientRequestId: "req_turn_2", baseRevision: 0, parts: [{ type: "text", text: "hi" }],
      selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default",
    })).rejects.toMatchObject({ status: 400 });
    expect(started).toEqual([]);
  });
});
