import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTelegramAdapter,
  type TelegramBot,
  type TelegramBotFactory,
  type TelegramMessage,
} from "../../../packages/gateway/src/channels/telegram.js";
import type { ChannelMessage } from "../../../packages/gateway/src/channels/types.js";

function createMockBot(): TelegramBot & {
  triggerMessage: (msg: TelegramMessage) => void;
} {
  let messageHandler: ((msg: TelegramMessage) => void) | null = null;

  return {
    on: vi.fn((event: string, handler: (msg: TelegramMessage) => void) => {
      if (event === "message") messageHandler = handler;
    }),
    stopPolling: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    sendMessage: vi.fn<(chatId: string, text: string, options?: Record<string, unknown>) => Promise<unknown>>().mockResolvedValue({}),
    triggerMessage(msg: TelegramMessage) {
      messageHandler?.(msg);
    },
  };
}

describe("createTelegramAdapter", () => {
  let mockBot: ReturnType<typeof createMockBot>;
  let factory: TelegramBotFactory;

  beforeEach(() => {
    mockBot = createMockBot();
    factory = vi.fn(() => mockBot);
  });

  it("creates adapter with telegram id", () => {
    const adapter = createTelegramAdapter(factory);
    expect(adapter.id).toBe("telegram");
  });

  it("creates bot with the provided token", async () => {
    const adapter = createTelegramAdapter(factory);
    await adapter.start({ enabled: true, token: "test-token" });

    expect(factory).toHaveBeenCalledWith("test-token", { polling: true });
  });

  it("registers message handler on start", async () => {
    const adapter = createTelegramAdapter(factory);
    await adapter.start({ enabled: true, token: "test-token" });

    expect(mockBot.on).toHaveBeenCalledWith("message", expect.any(Function));
  });

  it("normalizes inbound messages to ChannelMessage", async () => {
    const adapter = createTelegramAdapter(factory);
    const messages: ChannelMessage[] = [];
    adapter.onMessage = (msg) => messages.push(msg);

    await adapter.start({ enabled: true, token: "test-token" });

    mockBot.triggerMessage({
      text: "Hello",
      from: { id: 123, first_name: "Hamed" },
      chat: { id: 456 },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      source: "telegram",
      senderId: "123",
      senderName: "Hamed",
      text: "Hello",
      chatId: "456",
    });
  });

  it("filters messages not in allowFrom list", async () => {
    const adapter = createTelegramAdapter(factory);
    const messages: ChannelMessage[] = [];
    adapter.onMessage = (msg) => messages.push(msg);

    await adapter.start({
      enabled: true,
      token: "test-token",
      allowFrom: ["999"],
    });

    mockBot.triggerMessage({
      text: "Hello",
      from: { id: 123, first_name: "Stranger" },
      chat: { id: 456 },
    });

    expect(messages).toHaveLength(0);
  });

  it("allows messages when allowFrom is empty (open mode)", async () => {
    const adapter = createTelegramAdapter(factory);
    const messages: ChannelMessage[] = [];
    adapter.onMessage = (msg) => messages.push(msg);

    await adapter.start({
      enabled: true,
      token: "test-token",
      allowFrom: [],
    });

    mockBot.triggerMessage({
      text: "Hello",
      from: { id: 123, first_name: "Anyone" },
      chat: { id: 456 },
    });

    expect(messages).toHaveLength(1);
  });

  it("sends reply via bot.sendMessage with MarkdownV2", async () => {
    const adapter = createTelegramAdapter(factory);
    await adapter.start({ enabled: true, token: "test-token" });

    await adapter.send({
      channelId: "telegram",
      chatId: "456",
      text: "Response",
    });

    expect(mockBot.sendMessage).toHaveBeenCalledWith("456", "Response", {
      parse_mode: "MarkdownV2",
    });
  });

  it("stops polling on stop", async () => {
    const adapter = createTelegramAdapter(factory);
    await adapter.start({ enabled: true, token: "test-token" });
    await adapter.stop();

    expect(mockBot.stopPolling).toHaveBeenCalled();
  });

  it("ignores messages without text", async () => {
    const adapter = createTelegramAdapter(factory);
    const messages: ChannelMessage[] = [];
    adapter.onMessage = (msg) => messages.push(msg);

    await adapter.start({ enabled: true, token: "test-token" });

    mockBot.triggerMessage({
      from: { id: 123, first_name: "Hamed" },
      chat: { id: 456 },
    });

    expect(messages).toHaveLength(0);
  });
});
