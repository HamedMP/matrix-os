import { expect, it } from "vitest";
import { ownerRuleHarness } from "../slack-rule-tools-support.js";
import { createBotStateDatabase, insertChat } from "./bot-state-support.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { bootstrapChatSharing } from "../../../packages/gateway/src/chat/sharing.js";
import { canProposeBotSettings } from "../../../packages/gateway/src/chat/bot-settings-authority.js";
import type { CanonicalChatRunActivity } from "@matrix-os/contracts";

it.each([
  { type: "bot.draft.proposed", patch: { instructions: "Review only this repository." } },
  { type: "bot.connection.requested", resource: { kind: "integration", service: "github" } },
] as const)("requires the owner's live direct Bot turn before publishing $type", async payload => {
  const fixture = await createBotStateDatabase();
  const ownerId = "user_test", botId = "bot_review001", chatId = "chat_settings";
  try {
    await insertChat(fixture.db, chatId, ownerId);
    const bindings = createBotBindingsRepository(fixture.db);
    await bindings.bindDirect({ ownerId, botId, chatId, now: new Date().toISOString() });
    const h = await ownerRuleHarness({ fixture, enrollment: { access: { ownerId, botId, chatId, grantId: "0".repeat(64), runtimeId: "fixture" },
      appId: "A123", teamId: "T123", channel: { id: "C123", name: "fixture" } } });
    await bootstrapChatSharing(h.repository.kysely);
    const automatic = await h.turn("An automatic background turn.", false);
    const eligible = (runId: string, agent: string) => canProposeBotSettings(h.repository.kysely, h.owner, chatId, runId, agent);
    expect(await eligible(automatic.runId, botId)).toBe(false);
    const binding = await h.turn(payload.type === "bot.draft.proposed" ? "Change your instructions to review only this repository." : "Connect GitHub.");
    expect(await eligible(binding.runId, botId)).toBe(true);
    expect(await eligible(binding.runId, "bot_another01")).toBe(false);
    const proposal: CanonicalChatRunActivity = { id: "activity_settings", runId: binding.runId, chatId, occurredAt: new Date().toISOString(),
      proposalId: "proposal_settings", sessionId: botId, baseDraftRevision: 1, ...payload };
    await expect(h.repository.appendRunActivities(h.owner, chatId, binding.runId, [{ ...proposal, sessionId: "bot_another01" }])).rejects.toThrow();
    expect(await h.repository.appendRunActivities(h.owner, chatId, binding.runId, [proposal])).toBe(1);
    expect(await h.repository.appendRunActivities(h.owner, chatId, binding.runId, [proposal])).toBe(0);
    await fixture.db.updateTable("bot_chat_bindings").set({ removed_at: new Date() }).where("bot_id", "=", botId).execute();
    expect(await eligible(binding.runId, botId)).toBe(false);
    await expect(h.repository.appendRunActivities(h.owner, chatId, binding.runId, [proposal])).rejects.toThrow();
  } finally { await fixture.destroy(); }
});
