import { describe, it, expect, vi, beforeEach } from "vitest";
import { createChannelManager } from "../../../packages/gateway/src/channels/manager.js";
import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelMessage,
  ChannelReply,
  ChannelId,
} from "../../../packages/gateway/src/channels/types.js";

function mockAdapter(id: ChannelId): ChannelAdapter {
  return {
    id,
    start: vi.fn<(config: ChannelConfig) => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    send: vi.fn<(reply: ChannelReply) => Promise<void>>().mockResolvedValue(undefined),
    onMessage: vi.fn(),
  };
}

describe("ChannelManager", () => {
  let telegramAdapter: ChannelAdapter;
  let discordAdapter: ChannelAdapter;

  beforeEach(() => {
    telegramAdapter = mockAdapter("telegram");
    discordAdapter = mockAdapter("discord");
  });

  it("starts only enabled adapters from config", async () => {
    const config = {
      telegram: { enabled: true, token: "tg-token" },
      discord: { enabled: false, token: "" },
    };

    const mgr = createChannelManager({
      config,
      adapters: { telegram: telegramAdapter, discord: discordAdapter },
      onMessage: vi.fn(),
    });

    await mgr.start();

    expect(telegramAdapter.start).toHaveBeenCalledWith(config.telegram);
    expect(discordAdapter.start).not.toHaveBeenCalled();
  });

  it("stops all started adapters on shutdown", async () => {
    const config = {
      telegram: { enabled: true, token: "tg-token" },
      discord: { enabled: true, token: "dc-token" },
    };

    const mgr = createChannelManager({
      config,
      adapters: { telegram: telegramAdapter, discord: discordAdapter },
      onMessage: vi.fn(),
    });

    await mgr.start();
    await mgr.stop();

    expect(telegramAdapter.stop).toHaveBeenCalled();
    expect(discordAdapter.stop).toHaveBeenCalled();
  });

  it("routes inbound messages to the onMessage callback", async () => {
    const onMessage = vi.fn();
    const config = { telegram: { enabled: true, token: "tg-token" } };

    const mgr = createChannelManager({
      config,
      adapters: { telegram: telegramAdapter },
      onMessage,
    });

    await mgr.start();

    const msg: ChannelMessage = {
      source: "telegram",
      senderId: "123",
      senderName: "Hamed",
      text: "Hello",
      chatId: "456",
    };

    telegramAdapter.onMessage(msg);

    expect(onMessage).toHaveBeenCalledWith(msg);
  });

  it("sends replies to the correct adapter", async () => {
    const config = {
      telegram: { enabled: true, token: "tg-token" },
      discord: { enabled: true, token: "dc-token" },
    };

    const mgr = createChannelManager({
      config,
      adapters: { telegram: telegramAdapter, discord: discordAdapter },
      onMessage: vi.fn(),
    });

    await mgr.start();

    const reply: ChannelReply = {
      channelId: "telegram",
      chatId: "456",
      text: "Response",
    };

    await mgr.send(reply);

    expect(telegramAdapter.send).toHaveBeenCalledWith(reply);
    expect(discordAdapter.send).not.toHaveBeenCalled();
  });

  it("reports status of all adapters", async () => {
    const config = {
      telegram: { enabled: true, token: "tg-token" },
      discord: { enabled: false, token: "" },
    };

    const mgr = createChannelManager({
      config,
      adapters: { telegram: telegramAdapter, discord: discordAdapter },
      onMessage: vi.fn(),
    });

    await mgr.start();
    const status = mgr.status();

    expect(status.telegram).toBe("connected");
    expect(status.discord).toBe("disabled");
  });

  it("handles adapter start failure gracefully", async () => {
    const failAdapter = mockAdapter("telegram");
    (failAdapter.start as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("bad token"));

    const config = { telegram: { enabled: true, token: "bad" } };

    const mgr = createChannelManager({
      config,
      adapters: { telegram: failAdapter },
      onMessage: vi.fn(),
    });

    await mgr.start();
    const status = mgr.status();

    expect(status.telegram).toBe("error");
  });

  it("skips adapters not present in adapters map", async () => {
    const config = {
      telegram: { enabled: true, token: "tg-token" },
      slack: { enabled: true, botToken: "slack-token" },
    };

    const mgr = createChannelManager({
      config,
      adapters: { telegram: telegramAdapter },
      onMessage: vi.fn(),
    });

    await mgr.start();
    const status = mgr.status();

    expect(status.telegram).toBe("connected");
    expect(status.slack).toBeUndefined();
  });
});
