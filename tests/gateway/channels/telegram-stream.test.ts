import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createTelegramStream,
  type TelegramStreamOptions,
  type TelegramStream,
} from "../../../packages/gateway/src/channels/telegram-stream.js";
import type { TelegramBot } from "../../../packages/gateway/src/channels/telegram.js";

function createMockBot(): TelegramBot & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    sendMessage: [],
    editMessageText: [],
    sendChatAction: [],
  };

  return {
    on: vi.fn(),
    stopPolling: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    sendMessage: vi.fn(async (chatId: string, text: string, options?: Record<string, unknown>) => {
      calls.sendMessage.push([chatId, text, options]);
      return { message_id: 42 };
    }),
    editMessageText: vi.fn(async (_text: string, _options?: Record<string, unknown>) => {
      calls.editMessageText.push([_text, _options]);
      return {};
    }),
    sendChatAction: vi.fn(async (chatId: string | number, action: string) => {
      calls.sendChatAction.push([chatId, action]);
      return {};
    }),
    calls,
  };
}

function createStream(
  bot: TelegramBot,
  overrides: Partial<Omit<TelegramStreamOptions, "bot">> = {},
): TelegramStream {
  return createTelegramStream({
    chatId: "123",
    bot,
    throttleMs: 100,
    minInitialChars: 10,
    maxChars: 4096,
    ...overrides,
  });
}

describe("createTelegramStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("typing indicator", () => {
    it("sends typing action on startTyping", async () => {
      const bot = createMockBot();
      const stream = createStream(bot);

      stream.startTyping();

      expect(bot.sendChatAction).toHaveBeenCalledWith("123", "typing");
    });

    it("sends keepalive typing every 4 seconds", async () => {
      const bot = createMockBot();
      const stream = createStream(bot);

      stream.startTyping();
      expect(bot.sendChatAction).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4000);
      expect(bot.sendChatAction).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(4000);
      expect(bot.sendChatAction).toHaveBeenCalledTimes(3);
    });

    it("stops keepalive on stopTyping", async () => {
      const bot = createMockBot();
      const stream = createStream(bot);

      stream.startTyping();
      expect(bot.sendChatAction).toHaveBeenCalledTimes(1);

      stream.stopTyping();
      await vi.advanceTimersByTimeAsync(8000);
      expect(bot.sendChatAction).toHaveBeenCalledTimes(1);
    });

    it("stops typing on flush", async () => {
      const bot = createMockBot();
      const stream = createStream(bot);

      stream.startTyping();
      stream.append("Hello world! This is enough text.");
      await stream.flush();

      await vi.advanceTimersByTimeAsync(8000);
      // Should not have sent more typing actions after flush
      const typingCalls = (bot.sendChatAction as ReturnType<typeof vi.fn>).mock.calls;
      const typingAfterFlush = typingCalls.length;
      await vi.advanceTimersByTimeAsync(8000);
      expect((bot.sendChatAction as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        typingAfterFlush,
      );
    });

    it("handles typing errors gracefully without crashing", async () => {
      const bot = createMockBot();
      (bot.sendChatAction as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("401 Unauthorized"),
      );

      const stream = createStream(bot);
      // Should not throw
      stream.startTyping();
      await vi.advanceTimersByTimeAsync(4000);
      // Still alive, no crash
      expect(bot.sendChatAction).toHaveBeenCalled();
    });
  });

  describe("message accumulation and initial send", () => {
    it("does not send message before minInitialChars threshold", async () => {
      const bot = createMockBot();
      const stream = createStream(bot, { minInitialChars: 50 });

      stream.append("Hi");
      await vi.advanceTimersByTimeAsync(200);

      expect(bot.sendMessage).not.toHaveBeenCalled();
    });

    it("sends initial message after minInitialChars accumulated", async () => {
      const bot = createMockBot();
      const stream = createStream(bot, { minInitialChars: 10 });

      stream.append("Hello world! This is a test.");
      await vi.advanceTimersByTimeAsync(200);

      expect(bot.sendMessage).toHaveBeenCalledWith(
        "123",
        "Hello world! This is a test.",
        undefined,
      );
    });

    it("accumulates multiple append calls before threshold", async () => {
      const bot = createMockBot();
      const stream = createStream(bot, { minInitialChars: 20 });

      stream.append("Hello ");
      stream.append("world! ");
      stream.append("This is a test.");
      await vi.advanceTimersByTimeAsync(200);

      expect(bot.sendMessage).toHaveBeenCalledTimes(1);
      expect(bot.sendMessage).toHaveBeenCalledWith(
        "123",
        "Hello world! This is a test.",
        undefined,
      );
    });

    it("uses plain text for streaming (no parse_mode)", async () => {
      const bot = createMockBot();
      const stream = createStream(bot, { minInitialChars: 5 });

      stream.append("Hello **bold** world");
      await vi.advanceTimersByTimeAsync(200);

      // During streaming, sends as plain text (no parse_mode)
      expect(bot.sendMessage).toHaveBeenCalledWith(
        "123",
        "Hello **bold** world",
        undefined,
      );
    });
  });

  describe("throttled editing", () => {
    it("throttles editMessageText calls to throttleMs interval", async () => {
      const bot = createMockBot();
      const stream = createStream(bot, { throttleMs: 1000, minInitialChars: 5 });

      // Initial send
      stream.append("Hello world");
      await vi.advanceTimersByTimeAsync(100);
      expect(bot.sendMessage).toHaveBeenCalledTimes(1);

      // Rapid appends within throttle window
      stream.append(" one");
      stream.append(" two");
      stream.append(" three");
      await vi.advanceTimersByTimeAsync(500);

      // Should not have edited yet (within throttle window)
      expect(bot.editMessageText).toHaveBeenCalledTimes(0);

      // After throttle window expires
      await vi.advanceTimersByTimeAsync(600);
      expect(bot.editMessageText).toHaveBeenCalledTimes(1);
    });

    it("sends the latest accumulated text in each edit", async () => {
      const bot = createMockBot();
      const stream = createStream(bot, { throttleMs: 500, minInitialChars: 5 });

      stream.append("Hello world");
      await vi.advanceTimersByTimeAsync(100);

      stream.append(" update1");
      stream.append(" update2");
      await vi.advanceTimersByTimeAsync(600);

      expect(bot.editMessageText).toHaveBeenCalledWith(
        "Hello world update1 update2",
        expect.objectContaining({ chat_id: "123", message_id: 42 }),
      );
    });

    it("does not edit if text has not changed since last edit", async () => {
      const bot = createMockBot();
      const stream = createStream(bot, { throttleMs: 200, minInitialChars: 5 });

      stream.append("Hello world");
      await vi.advanceTimersByTimeAsync(100);
      expect(bot.sendMessage).toHaveBeenCalledTimes(1);

      // Wait for throttle, no new text
      await vi.advanceTimersByTimeAsync(300);
      expect(bot.editMessageText).toHaveBeenCalledTimes(0);
    });
  });

  describe("flush (finalization)", () => {
    it("sends final message with MarkdownV2 formatting", async () => {
      const bot = createMockBot();
      const stream = createStream(bot, { minInitialChars: 5 });

      stream.append("Hello **bold** world");
      await vi.advanceTimersByTimeAsync(100);
      expect(bot.sendMessage).toHaveBeenCalledTimes(1);

      await stream.flush();

      // Final edit should use MarkdownV2
      expect(bot.editMessageText).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          chat_id: "123",
          message_id: 42,
          parse_mode: "MarkdownV2",
        }),
      );
    });

    it("sends the complete text if no message was sent yet", async () => {
      const bot = createMockBot();
      const stream = createStream(bot, { minInitialChars: 999 });

      stream.append("Short");
      await stream.flush();

      // Should send as final message since nothing was sent during streaming
      expect(bot.sendMessage).toHaveBeenCalledWith(
        "123",
        expect.any(String),
        expect.objectContaining({ parse_mode: "MarkdownV2" }),
      );
    });

    it("stops typing indicator on flush", async () => {
      const bot = createMockBot();
      const stream = createStream(bot);

      stream.startTyping();
      stream.append("Hello world! Enough text here.");
      await stream.flush();

      const typingCountAfterFlush = (bot.sendChatAction as ReturnType<typeof vi.fn>).mock.calls
        .length;
      await vi.advanceTimersByTimeAsync(8000);
      expect((bot.sendChatAction as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        typingCountAfterFlush,
      );
    });

    it("handles empty text gracefully", async () => {
      const bot = createMockBot();
      const stream = createStream(bot);

      await stream.flush();

      expect(bot.sendMessage).not.toHaveBeenCalled();
      expect(bot.editMessageText).not.toHaveBeenCalled();
    });
  });

  describe("4096 char limit", () => {
    it("stops editing when text exceeds maxChars", async () => {
      const bot = createMockBot();
      const stream = createStream(bot, { minInitialChars: 5, maxChars: 100, throttleMs: 100 });

      // Send initial short message
      stream.append("Hello world");
      await vi.advanceTimersByTimeAsync(100);
      expect(bot.sendMessage).toHaveBeenCalledTimes(1);

      // Exceed the limit
      stream.append("x".repeat(200));
      await vi.advanceTimersByTimeAsync(200);

      // Should not have tried to edit with oversize text
      const editCalls = (bot.editMessageText as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of editCalls) {
        expect((call[0] as string).length).toBeLessThanOrEqual(100);
      }
    });

    it("final flush sends complete text even if over limit", async () => {
      const bot = createMockBot();
      const stream = createStream(bot, { minInitialChars: 5, maxChars: 50 });

      stream.append("Hello world");
      await vi.advanceTimersByTimeAsync(100);

      stream.append("x".repeat(100));
      await stream.flush();

      // flush should still send the final formatted text
      expect(bot.editMessageText).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("handles sendMessage errors gracefully", async () => {
      const bot = createMockBot();
      (bot.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Network error"),
      );

      const stream = createStream(bot, { minInitialChars: 5 });

      // Should not throw
      stream.append("Hello world test");
      await vi.advanceTimersByTimeAsync(200);

      // Should survive the error
      expect(bot.sendMessage).toHaveBeenCalled();
    });

    it("handles editMessageText errors gracefully", async () => {
      const bot = createMockBot();
      (bot.editMessageText as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Message not modified"),
      );

      const stream = createStream(bot, { minInitialChars: 5, throttleMs: 100 });

      stream.append("Hello world");
      await vi.advanceTimersByTimeAsync(100);

      stream.append(" more text");
      await vi.advanceTimersByTimeAsync(200);

      // Should have attempted the edit but not crashed
      expect(bot.editMessageText).toHaveBeenCalled();
    });

    it("flush still works after streaming errors", async () => {
      const bot = createMockBot();
      let callCount = 0;
      (bot.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error("First send fails");
        return { message_id: 42 };
      });

      const stream = createStream(bot, { minInitialChars: 5 });

      stream.append("Hello world");
      await vi.advanceTimersByTimeAsync(200);

      // First send failed, but flush should retry
      await stream.flush();
      // flush sends final message as new sendMessage since no messageId was captured
      expect(bot.sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe("integration-like scenarios", () => {
    it("full lifecycle: start typing -> stream chunks -> flush", async () => {
      const bot = createMockBot();
      const stream = createStream(bot, {
        throttleMs: 500,
        minInitialChars: 20,
      });

      // User sends message, start typing
      stream.startTyping();
      expect(bot.sendChatAction).toHaveBeenCalledTimes(1);

      // Kernel starts streaming small chunks
      stream.append("I'm ");
      stream.append("thinking ");
      stream.append("about ");
      await vi.advanceTimersByTimeAsync(200);
      // Below threshold, no message sent
      expect(bot.sendMessage).not.toHaveBeenCalled();

      // More chunks arrive, cross threshold
      stream.append("your question and here is my answer.");
      await vi.advanceTimersByTimeAsync(200);
      expect(bot.sendMessage).toHaveBeenCalledTimes(1);

      // Keepalive typing still running
      await vi.advanceTimersByTimeAsync(4000);
      // Typing should still be active since we haven't flushed

      // More streaming chunks
      stream.append(" Let me elaborate further on this topic.");
      await vi.advanceTimersByTimeAsync(600);
      expect(bot.editMessageText).toHaveBeenCalled();

      // Kernel completes, flush final
      await stream.flush();

      // Typing stopped after flush
      const typingCountAfterFlush = (bot.sendChatAction as ReturnType<typeof vi.fn>).mock.calls
        .length;
      await vi.advanceTimersByTimeAsync(8000);
      expect((bot.sendChatAction as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        typingCountAfterFlush,
      );
    });

    it("short response: start typing -> flush immediately (below threshold)", async () => {
      const bot = createMockBot();
      const stream = createStream(bot, { minInitialChars: 50 });

      stream.startTyping();
      stream.append("Ok.");
      await stream.flush();

      // Should still send the final message
      expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    });
  });
});
