import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelMessage,
  ChannelReply,
} from "./types.js";

export interface TelegramBot {
  on(event: string, handler: (msg: TelegramMessage) => void): void;
  stopPolling(): Promise<void>;
  sendMessage(chatId: string, text: string, options?: Record<string, unknown>): Promise<{ message_id: number }>;
  editMessageText(text: string, options?: Record<string, unknown>): Promise<unknown>;
  sendChatAction(chatId: string | number, action: string): Promise<unknown>;
}

export interface TelegramMessage {
  text?: string;
  from?: { id: number; first_name?: string };
  chat: { id: number };
}

export type TelegramBotFactory = (token: string, options: Record<string, unknown>) => TelegramBot;

export interface TelegramAdapter extends ChannelAdapter {
  getBot(): TelegramBot | null;
}

export function createTelegramAdapter(botFactory?: TelegramBotFactory): TelegramAdapter {
  let bot: TelegramBot | null = null;
  let allowFrom: string[] = [];

  const adapter: TelegramAdapter = {
    id: "telegram",

    onMessage: () => {},

    getBot() {
      return bot;
    },

    async start(config: ChannelConfig) {
      if (!config.token) throw new Error("Telegram token required");

      allowFrom = config.allowFrom ?? [];

      if (botFactory) {
        bot = botFactory(config.token, { polling: true });
      } else {
        const TelegramBotApi = (await import("node-telegram-bot-api")).default;
        bot = new TelegramBotApi(config.token, { polling: true });
      }

      bot.on("message", (msg: TelegramMessage) => {
        if (!msg.text) return;
        if (!msg.from) return;

        const senderId = String(msg.from.id);

        if (allowFrom.length > 0 && !allowFrom.includes(senderId)) {
          return;
        }

        const channelMessage: ChannelMessage = {
          source: "telegram",
          senderId,
          senderName: msg.from.first_name,
          text: msg.text,
          chatId: String(msg.chat.id),
        };

        adapter.onMessage(channelMessage);
      });
    },

    async stop() {
      if (bot) {
        await bot.stopPolling();
        bot = null;
      }
    },

    async send(reply: ChannelReply) {
      if (!bot) return;
      await bot.sendMessage(reply.chatId, reply.text, {
        parse_mode: "MarkdownV2",
      });
    },
  };

  return adapter;
}
