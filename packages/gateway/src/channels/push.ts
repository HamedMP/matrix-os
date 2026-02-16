import type { ChannelAdapter, ChannelConfig, ChannelMessage, ChannelReply } from "./types.js";

interface PushToken {
  token: string;
  platform: string;
  registeredAt: number;
}

interface PushSendResult {
  id: string;
  status: "ok" | "error";
  message?: string;
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

export function createPushAdapter(): ChannelAdapter & {
  registerToken(token: string, platform: string): void;
  removeToken(token: string): void;
  getTokens(): PushToken[];
} {
  const tokens: Map<string, PushToken> = new Map();
  const sendTimestamps: number[] = [];
  let messageHandler: (msg: ChannelMessage) => void = () => {};

  function isRateLimited(): boolean {
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    while (sendTimestamps.length > 0 && sendTimestamps[0] < cutoff) {
      sendTimestamps.shift();
    }
    return sendTimestamps.length >= RATE_LIMIT_MAX;
  }

  async function sendPush(
    pushTokens: string[],
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ): Promise<PushSendResult[]> {
    if (pushTokens.length === 0) return [];

    const messages = pushTokens.map((token) => ({
      to: token,
      title,
      body: body.length > 200 ? body.slice(0, 197) + "..." : body,
      sound: "default" as const,
      data: data ?? {},
      channelId: "default",
    }));

    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(messages),
    });

    if (!res.ok) {
      return messages.map((m) => ({
        id: m.to,
        status: "error" as const,
        message: `HTTP ${res.status}`,
      }));
    }

    const result = await res.json();
    return (result.data ?? []).map((d: { id: string; status: string; message?: string }) => ({
      id: d.id,
      status: d.status === "ok" ? ("ok" as const) : ("error" as const),
      message: d.message,
    }));
  }

  return {
    id: "push",

    registerToken(token: string, platform: string) {
      tokens.set(token, { token, platform, registeredAt: Date.now() });
    },

    removeToken(token: string) {
      tokens.delete(token);
    },

    getTokens(): PushToken[] {
      return Array.from(tokens.values());
    },

    async start(_config: ChannelConfig) {
      // Push adapter is always ready -- no polling needed
    },

    async stop() {
      tokens.clear();
    },

    async send(reply: ChannelReply) {
      if (isRateLimited()) return;

      sendTimestamps.push(Date.now());

      const allTokens = Array.from(tokens.values()).map((t) => t.token);
      if (allTokens.length === 0) return;

      await sendPush(allTokens, "Matrix OS", reply.text, {
        type: "message",
        chatId: reply.chatId,
      });
    },

    set onMessage(handler: (msg: ChannelMessage) => void) {
      messageHandler = handler;
    },
    get onMessage() {
      return messageHandler;
    },
  };
}
