import { describe, it, expect, vi } from "vitest";
import { getService, getServiceByPipedreamApp } from "../../packages/gateway/src/integrations/registry.js";
import { INTEGRATION_ACTION_FAILURES } from "@matrix-os/contracts/integration-marketplace";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

describe("Discord connection capabilities", () => {
  it("includes the send permission in bot setup and permission recovery", () => {
    expect(INTEGRATION_ACTION_FAILURES.discord_bot_required.message).toContain("Send Messages");
    expect(INTEGRATION_ACTION_FAILURES.discord_access_denied.message).toContain("Send Messages");
  });
  it("advertises only user OAuth server discovery on the regular connector", () => {
    const service = getService("discord")!;
    expect(Object.keys(service.actions)).toEqual(["list_servers"]);
    expect(service.actions.list_servers.description).toContain("user");
    expect(service.description).toContain("Discord Bot");
  });
  it("maps the provider bot slug separately and retains only reviewed bot actions", () => {
    const bot = getServiceByPipedreamApp("discord_bot")!;
    expect(bot.id).toBe("discord_bot");
    expect(bot.authType).toBe("keys");
    expect(Object.keys(bot.actions).sort()).toEqual(["list_channels", "list_messages", "list_servers", "send_message"]);
    expect(getServiceByPipedreamApp("discord")?.id).toBe("discord");
  });
  it("keeps the existing bot send mapping bound to the selected provider account", async () => {
    const bot = getService("discord_bot")!;
    const proxyPost = vi.fn().mockResolvedValue({ id: "345678901234567890" });
    await executeIntegrationAction({
      pipedream: { proxyPost } as unknown as PipedreamConnectClient,
      externalUserId: "synthetic-owner", connection: { pipedream_account_id: "synthetic-bot" },
      def: bot, actionDef: bot.actions.send_message, serviceId: bot.id, actionId: "send_message",
      params: { channelId: "234567890123456789", content: "Synthetic fixture only" },
    });
    expect(proxyPost).toHaveBeenCalledExactlyOnceWith({
      externalUserId: "synthetic-owner", accountId: "synthetic-bot",
      url: "https://discord.com/api/v10/channels/234567890123456789/messages",
      body: { content: "Synthetic fixture only" },
    });
  });
  it("rejects a malformed server ID before dispatching to the provider", async () => {
    const bot = getService("discord_bot")!;
    const proxyGet = vi.fn();
    await expect(executeIntegrationAction({
      pipedream: { proxyGet } as unknown as PipedreamConnectClient,
      externalUserId: "synthetic-owner", connection: { pipedream_account_id: "synthetic-bot" },
      def: bot, actionDef: bot.actions.list_channels, serviceId: bot.id, actionId: "list_channels",
      params: { serverId: "../other" },
    })).rejects.toThrow("Discord ID must be");
    expect(proxyGet).not.toHaveBeenCalled();
  });
});
