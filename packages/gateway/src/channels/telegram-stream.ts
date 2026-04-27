import type { TelegramBot } from "./telegram.js";
import { formatForChannel } from "./format.js";

const TYPING_KEEPALIVE_MS = 4000;

export interface TelegramStreamOptions {
  chatId: string;
  bot: TelegramBot;
  throttleMs?: number;
  minInitialChars?: number;
  maxChars?: number;
}

export interface TelegramStream {
  append(text: string): void;
  flush(): Promise<void>;
  startTyping(): void;
  stopTyping(): void;
}

export function createTelegramStream(opts: TelegramStreamOptions): TelegramStream {
  const {
    chatId,
    bot,
    throttleMs = 1000,
    minInitialChars = 50,
    maxChars = 4096,
  } = opts;

  let accumulated = "";
  let messageId: number | undefined;
  let sendingInitial = false;
  let lastSentText = "";
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  let throttleTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function sendTypingAction() {
    bot.sendChatAction(chatId, "typing").catch((err: unknown) => {
      console.warn("[telegram] Could not send typing action:", err instanceof Error ? err.message : String(err));
    });
  }

  function startTyping() {
    sendTypingAction();
    stopTypingTimer();
    typingTimer = setInterval(sendTypingAction, TYPING_KEEPALIVE_MS);
  }

  function stopTyping() {
    stopTypingTimer();
  }

  function stopTypingTimer() {
    if (typingTimer !== undefined) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
  }

  function clearThrottleTimer() {
    if (throttleTimer !== undefined) {
      clearTimeout(throttleTimer);
      throttleTimer = undefined;
    }
  }

  async function sendInitialMessage(text: string): Promise<void> {
    try {
      const result = await bot.sendMessage(chatId, text, undefined);
      messageId = result.message_id;
      lastSentText = text;
    } catch (err: unknown) {
      console.warn("[telegram] Initial stream send failed:", err instanceof Error ? err.message : String(err));
    }
  }

  async function editMessage(text: string): Promise<void> {
    if (messageId === undefined) return;
    if (text === lastSentText) return;
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
      });
      lastSentText = text;
    } catch (err: unknown) {
      console.warn("[telegram] Stream edit failed:", err instanceof Error ? err.message : String(err));
    }
  }

  function scheduleEdit() {
    if (throttleTimer !== undefined) return;
    throttleTimer = setTimeout(async () => {
      throttleTimer = undefined;
      if (stopped) return;
      if (accumulated.length <= maxChars && accumulated !== lastSentText) {
        await editMessage(accumulated);
      }
    }, throttleMs);
  }

  function append(text: string) {
    if (stopped) return;
    accumulated += text;

    if (messageId === undefined) {
      if (!sendingInitial && accumulated.length >= minInitialChars) {
        sendingInitial = true;
        sendInitialMessage(accumulated).then(() => {
          if (!stopped && accumulated !== lastSentText && accumulated.length <= maxChars) {
            scheduleEdit();
          }
        });
      }
      return;
    }

    // Already sent initial, schedule throttled edit
    if (accumulated.length <= maxChars) {
      scheduleEdit();
    }
  }

  async function flush(): Promise<void> {
    stopped = true;
    stopTyping();
    clearThrottleTimer();

    if (!accumulated) return;

    const formatted = formatForChannel("telegram", accumulated);

    if (messageId === undefined) {
      // Never sent during streaming, send final message
      try {
        await bot.sendMessage(chatId, formatted, { parse_mode: "MarkdownV2" });
      } catch (err: unknown) {
        console.warn("[telegram] Final stream send failed:", err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // Edit existing message with formatted final text
    try {
      await bot.editMessageText(formatted, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "MarkdownV2",
      });
    } catch (err: unknown) {
      console.warn("[telegram] Final stream edit failed:", err instanceof Error ? err.message : String(err));
    }
  }

  return { append, flush, startTyping, stopTyping };
}
