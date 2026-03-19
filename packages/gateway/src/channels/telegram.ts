import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelMessage,
  ChannelReply,
} from "./types.js";
import { handleVoiceNote } from "../voice/channel-voice.js";
import type { SttProvider } from "../voice/stt/base.js";

export interface TelegramBot {
  on(event: string, handler: (msg: TelegramMessage) => void): void;
  stopPolling(): Promise<void>;
  sendMessage(chatId: string, text: string, options?: Record<string, unknown>): Promise<{ message_id: number }>;
  editMessageText(text: string, options?: Record<string, unknown>): Promise<unknown>;
  sendChatAction(chatId: string | number, action: string): Promise<unknown>;
  setMyCommands?(commands: Array<{ command: string; description: string }>): Promise<unknown>;
  getFile?(fileId: string): Promise<{ file_path: string }>;
}

export interface TelegramMessage {
  text?: string;
  voice?: { file_id: string; duration: number };
  audio?: { file_id: string; duration: number };
  from?: { id: number; first_name?: string };
  chat: { id: number };
}

export interface VoiceContext {
  homePath: string;
  stt: SttProvider | null;
}

export type TelegramBotFactory = (token: string, options: Record<string, unknown>) => TelegramBot;

export interface TelegramAdapter extends ChannelAdapter {
  getBot(): TelegramBot | null;
  setVoiceContext(ctx: VoiceContext): void;
}

export function createTelegramAdapter(botFactory?: TelegramBotFactory): TelegramAdapter {
  let bot: TelegramBot | null = null;
  let allowFrom: string[] = [];
  let token: string | null = null;
  let voiceCtx: VoiceContext | null = null;

  const adapter: TelegramAdapter = {
    id: "telegram",

    onMessage: () => {},

    getBot() {
      return bot;
    },

    setVoiceContext(ctx: VoiceContext) {
      voiceCtx = ctx;
    },

    async start(config: ChannelConfig) {
      if (!config.token) throw new Error("Telegram token required");

      token = config.token;
      allowFrom = config.allowFrom ?? [];

      if (botFactory) {
        bot = botFactory(config.token, { polling: true });
      } else {
        const TelegramBotApi = (await import("node-telegram-bot-api")).default;
        bot = new TelegramBotApi(config.token, { polling: true });
      }

      bot.on("message", (msg: TelegramMessage) => {
        if (!msg.from) return;

        const senderId = String(msg.from.id);

        if (allowFrom.length > 0 && !allowFrom.includes(senderId)) {
          return;
        }

        const voiceFile = msg.voice ?? msg.audio;
        if (voiceFile) {
          if (!voiceCtx || !bot?.getFile || !token) return;

          const currentBot = bot;
          const currentToken = token;
          const ctx = voiceCtx;

          currentBot.getFile!(voiceFile.file_id).then((fileInfo) => {
            const audioUrl = `https://api.telegram.org/file/bot${currentToken}/${fileInfo.file_path}`;
            return handleVoiceNote({
              audioUrl,
              channel: "telegram",
              homePath: ctx.homePath,
              stt: ctx.stt,
              extension: "ogg",
            });
          }).then((result) => {
            const text = result.transcript ?? "[Voice message - transcription failed]";
            const metadata: Record<string, unknown> = {
              source: "voice",
              audioPath: result.filePath,
            };
            if (result.error) metadata.error = result.error;

            const channelMessage: ChannelMessage = {
              source: "telegram",
              senderId,
              senderName: msg.from!.first_name,
              text,
              chatId: String(msg.chat.id),
              metadata,
            };

            adapter.onMessage(channelMessage);
          }).catch(() => {
            const channelMessage: ChannelMessage = {
              source: "telegram",
              senderId,
              senderName: msg.from!.first_name,
              text: "[Voice message - transcription failed]",
              chatId: String(msg.chat.id),
              metadata: { source: "voice" },
            };

            adapter.onMessage(channelMessage);
          });

          return;
        }

        if (!msg.text) return;

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
