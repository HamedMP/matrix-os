/** Start bounded channel adapters and preserve their message/session lifecycle. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Dispatcher } from "../dispatcher.js";
import type { ConversationStore } from "../conversations.js";
import type { CodingAgentThreadStore, CodingAgentTurnStore } from "../coding-agents/thread-store.js";
import { registerCodingAgentAttentionNotifications } from "../coding-agents/attention-notifications.js";
import { createCodingAgentNotificationPreferenceStore } from "../coding-agents/notification-preferences.js";
import { createChannelManager, type ChannelManager } from "../channels/manager.js";
import { createOutboundQueue } from "../security/outbound-queue.js";
import { createPushAdapter } from "../channels/push.js";
import { createSessionStore } from "../session-store.js";
import { createTelegramAdapter, type TelegramAdapter } from "../channels/telegram.js";
import { createTelegramStream } from "../channels/telegram-stream.js";
import { formatForChannel } from "../channels/format.js";
import type { ChannelConfig, ChannelId } from "../channels/types.js";

export interface GatewayChannelStartupOptions {
  homePath: string;
  configPath: string;
  dispatcher: Dispatcher;
  conversations: ConversationStore;
  codingAgentThreadStore: (CodingAgentThreadStore & CodingAgentTurnStore) | undefined;
  codingAgentNotificationPreferenceStore: ReturnType<typeof createCodingAgentNotificationPreferenceStore>;
  finalizeWithSummary(sessionId: string): Promise<void>;
  logBestEffortFailure(context: string, error: unknown): void;
  /** Speech-to-text used for Telegram voice notes. Required: without it voice messages
      silently stop transcribing, which no test covers. */
  channelStt: Parameters<TelegramAdapter["setVoiceContext"]>[0]["stt"];
}

export interface GatewayChannels {
  channelManager: ChannelManager;
  pushAdapter: ReturnType<typeof createPushAdapter>;
  codingAgentAttentionNotifications: ReturnType<typeof registerCodingAgentAttentionNotifications> | undefined;
}

export function initializeGatewayChannels(options: GatewayChannelStartupOptions): GatewayChannels {
  const { homePath, configPath, dispatcher, conversations, codingAgentThreadStore,
    codingAgentNotificationPreferenceStore, finalizeWithSummary, logBestEffortFailure,
    channelStt } = options;
  // Channel manager -- reads config, starts enabled adapters
  let channelsConfig: Partial<Record<ChannelId, ChannelConfig>> = {};
  try {
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      channelsConfig = cfg.channels ?? {};
    }
  } catch (err: unknown) {
    logBestEffortFailure("Failed to load channel config", err);
  }

  const outboundQueue = createOutboundQueue(homePath);

  const pushAdapter = createPushAdapter();

  const channelSessions = createSessionStore(join(homePath, "system", "sessions.json"));

  const telegramAdapter: TelegramAdapter = createTelegramAdapter();
  telegramAdapter.setVoiceContext({ homePath, stt: channelStt });

  const channelManager: ChannelManager = createChannelManager({
    config: channelsConfig,
    adapters: {
      telegram: telegramAdapter,
      push: pushAdapter,
    },
    outboundQueue,
    onMessage: (msg) => {
      const sessionKey = `${msg.source}:${msg.senderId}`;
      const existingSessionId = channelSessions.get(sessionKey);

      // Telegram streaming: use progressive message editing
      if (msg.source === "telegram") {
        const bot = telegramAdapter.getBot();
        if (bot) {
          const stream = createTelegramStream({
            chatId: msg.chatId,
            bot,
            throttleMs: 1000,
            minInitialChars: 50,
            maxChars: 4096,
          });

          stream.startTyping();

          const text = msg.text.startsWith("/") ? msg.text.slice(1) : msg.text;
          let lastToolName: string | undefined;

          dispatcher
            .dispatch(text, existingSessionId, (event) => {
              if (event.type === "init") {
                channelSessions.set(sessionKey, event.sessionId, {
                  channel: msg.source, senderId: msg.senderId,
                  senderName: msg.senderName, chatId: msg.chatId,
                });
                conversations.begin(event.sessionId);
                conversations.addUserMessage(event.sessionId, msg.text);
              } else if (event.type === "text") {
                stream.append(event.text);
                const sid = channelSessions.get(sessionKey);
                if (sid) conversations.appendAssistantText(sid, event.text);
              } else if (event.type === "tool_start") {
                lastToolName = event.tool;
                const sid = channelSessions.get(sessionKey);
                if (sid) conversations.addToolStart(sid, event.tool);
              } else if (event.type === "tool_end") {
                const sid = channelSessions.get(sessionKey);
                if (sid) conversations.addToolEnd(sid, lastToolName ?? "unknown", event.input);
              } else if (event.type === "result") {
                const sid = channelSessions.get(sessionKey);
                if (sid) finalizeWithSummary(sid);
              }
            }, {
              channel: msg.source,
              senderId: msg.senderId,
              senderName: msg.senderName,
              chatId: msg.chatId,
            })
            .then(() => stream.flush())
            .catch((err: Error) => {
              stream.stopTyping();
              channelManager.send({
                channelId: msg.source,
                chatId: msg.chatId,
                text: `Error: ${err.message}`,
              });
            });

          return;
        }
      }

      // Default path for non-telegram channels (or telegram without bot)
      let responseText = "";
      let lastToolName: string | undefined;

      dispatcher
        .dispatch(msg.text, existingSessionId, (event) => {
          if (event.type === "init") {
            channelSessions.set(sessionKey, event.sessionId, {
              channel: msg.source, senderId: msg.senderId,
              senderName: msg.senderName, chatId: msg.chatId,
            });
            conversations.begin(event.sessionId);
            conversations.addUserMessage(event.sessionId, msg.text);
          } else if (event.type === "text") {
            responseText += event.text;
            const sid = channelSessions.get(sessionKey);
            if (sid) conversations.appendAssistantText(sid, event.text);
          } else if (event.type === "tool_start") {
            lastToolName = event.tool;
            const sid = channelSessions.get(sessionKey);
            if (sid) conversations.addToolStart(sid, event.tool);
          } else if (event.type === "tool_end") {
            const sid = channelSessions.get(sessionKey);
            if (sid) conversations.addToolEnd(sid, lastToolName ?? "unknown", event.input);
          } else if (event.type === "result") {
            const sid = channelSessions.get(sessionKey);
            if (sid) finalizeWithSummary(sid);
          }
        }, {
          channel: msg.source,
          senderId: msg.senderId,
          senderName: msg.senderName,
          chatId: msg.chatId,
        })
        .then(() => {
          if (responseText) {
            const formatted = formatForChannel(msg.source, responseText);
            channelManager.send({
              channelId: msg.source,
              chatId: msg.chatId,
              text: formatted,
            });
          }
        })
        .catch((err: Error) => {
          channelManager.send({
            channelId: msg.source,
            chatId: msg.chatId,
            text: `Error: ${err.message}`,
          });
        });
    },
  });
  const codingAgentAttentionNotifications = codingAgentThreadStore
    ? registerCodingAgentAttentionNotifications({
      threads: codingAgentThreadStore,
      send: (reply) => channelManager.send(reply),
      preferences: codingAgentNotificationPreferenceStore,
    })
    : undefined;

  channelManager.start().then(() => {
    channelManager.replay().catch((err: unknown) => {
      logBestEffortFailure("Failed to replay queued channel messages", err);
    });

    // Register skills as Telegram slash commands
    const bot = telegramAdapter.getBot();
    if (bot?.setMyCommands) {
      try {
        const skillsDir = join(homePath, "agents", "skills");
        if (existsSync(skillsDir)) {
          const commands: Array<{ command: string; description: string }> = [];
          for (const f of readdirSync(skillsDir).filter((s) => s.endsWith(".md"))) {
            const content = readFileSync(join(skillsDir, f), "utf-8");
            const nameMatch = content.match(/^name:\s*(.+)$/m);
            const descMatch = content.match(/^description:\s*(.+)$/m);
            if (nameMatch) {
              commands.push({
                command: nameMatch[1].trim().replace(/\s+/g, "-").toLowerCase(),
                description: (descMatch?.[1]?.trim() ?? nameMatch[1].trim()).slice(0, 256),
              });
            }
          }
          if (commands.length > 0) {
            bot.setMyCommands(commands.slice(0, 100)).catch((err: unknown) => {
              logBestEffortFailure("Failed to set Telegram commands", err);
            });
          }
        }
      } catch (err: unknown) {
        logBestEffortFailure("Failed to register Telegram commands", err);
      }
    }
  });

  return { channelManager, pushAdapter, codingAgentAttentionNotifications };
}
