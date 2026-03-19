import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createTelegramAdapter,
  type TelegramBot,
  type TelegramBotFactory,
  type TelegramMessage,
} from "../../../packages/gateway/src/channels/telegram.js";
import type { ChannelMessage } from "../../../packages/gateway/src/channels/types.js";
import type { SttProvider } from "../../../packages/gateway/src/voice/stt/base.js";

function createMockStt(overrides: Partial<SttProvider> = {}): SttProvider {
  return {
    name: "mock-stt",
    isAvailable: vi.fn(() => true),
    transcribe: vi.fn().mockResolvedValue({
      text: "Hello from voice note",
      language: "en",
      durationMs: 3200,
    }),
    ...overrides,
  };
}

function createMockBot(): TelegramBot & {
  triggerMessage: (msg: TelegramMessage) => void;
} {
  let messageHandler: ((msg: TelegramMessage) => void) | null = null;

  return {
    on: vi.fn((event: string, handler: (msg: TelegramMessage) => void) => {
      if (event === "message") messageHandler = handler;
    }),
    stopPolling: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    sendMessage: vi
      .fn<
        (
          chatId: string,
          text: string,
          options?: Record<string, unknown>,
        ) => Promise<{ message_id: number }>
      >()
      .mockResolvedValue({ message_id: 1 }),
    editMessageText: vi
      .fn<
        (
          text: string,
          options?: Record<string, unknown>,
        ) => Promise<unknown>
      >()
      .mockResolvedValue({}),
    sendChatAction: vi
      .fn<
        (chatId: string | number, action: string) => Promise<unknown>
      >()
      .mockResolvedValue({}),
    getFile: vi.fn().mockResolvedValue({ file_path: "voice/file_42.oga" }),
    triggerMessage(msg: TelegramMessage) {
      messageHandler?.(msg);
    },
  };
}

describe("Telegram voice note handling", () => {
  let mockBot: ReturnType<typeof createMockBot>;
  let factory: TelegramBotFactory;
  let homePath: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockBot = createMockBot();
    factory = vi.fn(() => mockBot);
    homePath = mkdtempSync(join(tmpdir(), "matrixos-tg-voice-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(homePath, { recursive: true, force: true });
  });

  it("detects Telegram voice message (message.voice present)", async () => {
    const audioData = Buffer.from("fake-ogg-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(
          audioData.buffer.slice(
            audioData.byteOffset,
            audioData.byteOffset + audioData.byteLength,
          ),
        ),
    });

    const stt = createMockStt();
    const adapter = createTelegramAdapter(factory);
    const messages: ChannelMessage[] = [];
    adapter.onMessage = (msg) => messages.push(msg);

    adapter.setVoiceContext({ homePath, stt });
    await adapter.start({ enabled: true, token: "test-token-123" });

    mockBot.triggerMessage({
      voice: { file_id: "voice_file_abc", duration: 5 },
      from: { id: 123, first_name: "Hamed" },
      chat: { id: 456 },
    });

    // Wait for async voice handling
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));

    expect(messages[0]!.text).toBe("Hello from voice note");
  });

  it("downloads voice file via Telegram Bot API (getFile -> file_path -> URL)", async () => {
    const audioData = Buffer.from("fake-ogg-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(
          audioData.buffer.slice(
            audioData.byteOffset,
            audioData.byteOffset + audioData.byteLength,
          ),
        ),
    });

    const stt = createMockStt();
    const adapter = createTelegramAdapter(factory);
    adapter.onMessage = () => {};

    adapter.setVoiceContext({ homePath, stt });
    await adapter.start({ enabled: true, token: "test-token-123" });

    mockBot.triggerMessage({
      voice: { file_id: "voice_file_abc", duration: 5 },
      from: { id: 123, first_name: "Hamed" },
      chat: { id: 456 },
    });

    await vi.waitFor(() => expect(mockBot.getFile).toHaveBeenCalled());

    expect(mockBot.getFile).toHaveBeenCalledWith("voice_file_abc");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/bottest-token-123/voice/file_42.oga",
    );
  });

  it("dispatches transcript text as message content", async () => {
    const audioData = Buffer.from("fake-ogg-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(
          audioData.buffer.slice(
            audioData.byteOffset,
            audioData.byteOffset + audioData.byteLength,
          ),
        ),
    });

    const stt = createMockStt();
    const adapter = createTelegramAdapter(factory);
    const messages: ChannelMessage[] = [];
    adapter.onMessage = (msg) => messages.push(msg);

    adapter.setVoiceContext({ homePath, stt });
    await adapter.start({ enabled: true, token: "test-token-123" });

    mockBot.triggerMessage({
      voice: { file_id: "voice_abc", duration: 3 },
      from: { id: 123, first_name: "Hamed" },
      chat: { id: 456 },
    });

    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));

    expect(messages[0]).toEqual(
      expect.objectContaining({
        source: "telegram",
        senderId: "123",
        senderName: "Hamed",
        text: "Hello from voice note",
        chatId: "456",
      }),
    );
  });

  it("includes audio path and source in metadata", async () => {
    const audioData = Buffer.from("fake-ogg-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(
          audioData.buffer.slice(
            audioData.byteOffset,
            audioData.byteOffset + audioData.byteLength,
          ),
        ),
    });

    const stt = createMockStt();
    const adapter = createTelegramAdapter(factory);
    const messages: ChannelMessage[] = [];
    adapter.onMessage = (msg) => messages.push(msg);

    adapter.setVoiceContext({ homePath, stt });
    await adapter.start({ enabled: true, token: "test-token-123" });

    mockBot.triggerMessage({
      voice: { file_id: "voice_abc", duration: 3 },
      from: { id: 123, first_name: "Hamed" },
      chat: { id: 456 },
    });

    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));

    expect(messages[0]!.metadata).toEqual(
      expect.objectContaining({
        source: "voice",
        audioPath: expect.stringMatching(/telegram-\d+\.ogg$/),
      }),
    );
  });

  it("STT failure: dispatches fallback text with error", async () => {
    const audioData = Buffer.from("fake-ogg-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(
          audioData.buffer.slice(
            audioData.byteOffset,
            audioData.byteOffset + audioData.byteLength,
          ),
        ),
    });

    const stt = createMockStt({
      transcribe: vi
        .fn()
        .mockRejectedValue(new Error("Whisper rate limited")),
    });

    const adapter = createTelegramAdapter(factory);
    const messages: ChannelMessage[] = [];
    adapter.onMessage = (msg) => messages.push(msg);

    adapter.setVoiceContext({ homePath, stt });
    await adapter.start({ enabled: true, token: "test-token-123" });

    mockBot.triggerMessage({
      voice: { file_id: "voice_abc", duration: 3 },
      from: { id: 123, first_name: "Hamed" },
      chat: { id: 456 },
    });

    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));

    expect(messages[0]!.text).toBe(
      "[Voice message - transcription failed]",
    );
    expect(messages[0]!.metadata).toEqual(
      expect.objectContaining({
        source: "voice",
        audioPath: expect.stringMatching(/telegram-\d+\.ogg$/),
        error: "Whisper rate limited",
      }),
    );
  });

  it("handles audio messages (message.audio) same as voice", async () => {
    const audioData = Buffer.from("fake-ogg-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(
          audioData.buffer.slice(
            audioData.byteOffset,
            audioData.byteOffset + audioData.byteLength,
          ),
        ),
    });

    const stt = createMockStt();
    const adapter = createTelegramAdapter(factory);
    const messages: ChannelMessage[] = [];
    adapter.onMessage = (msg) => messages.push(msg);

    adapter.setVoiceContext({ homePath, stt });
    await adapter.start({ enabled: true, token: "test-token-123" });

    mockBot.triggerMessage({
      audio: { file_id: "audio_file_xyz", duration: 10 },
      from: { id: 123, first_name: "Hamed" },
      chat: { id: 456 },
    });

    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));

    expect(messages[0]!.text).toBe("Hello from voice note");
  });

  it("voice messages without voice context are silently ignored", async () => {
    const adapter = createTelegramAdapter(factory);
    const messages: ChannelMessage[] = [];
    adapter.onMessage = (msg) => messages.push(msg);

    // Do NOT set voice context
    await adapter.start({ enabled: true, token: "test-token-123" });

    mockBot.triggerMessage({
      voice: { file_id: "voice_abc", duration: 3 },
      from: { id: 123, first_name: "Hamed" },
      chat: { id: 456 },
    });

    // Give it a tick to process
    await new Promise((r) => setTimeout(r, 50));

    expect(messages).toHaveLength(0);
  });
});
