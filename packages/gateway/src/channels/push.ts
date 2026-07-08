import type { ChannelAdapter, ChannelConfig, ChannelMessage, ChannelReply } from "./types.js";
import { z } from "zod/v4";

interface PushToken {
  token: string;
  platform: string;
  ownerId?: string;
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
const MAX_PUSH_METADATA_KEYS = 10;
const DEFAULT_MAX_REGISTERED_TOKENS = 16;
const DEFAULT_MAX_REGISTERED_OWNERS = 2_048;
const DEFAULT_MAX_FANOUT_TOKENS = 32;
const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface PushAdapterOptions {
  now?: () => number;
  maxRegisteredTokens?: number;
  maxRegisteredOwners?: number;
  maxFanoutTokens?: number;
  tokenTtlMs?: number;
}

const PushDataValueSchema = z.union([
  z.string().max(160),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const PushMetadataSchema = z.record(z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/), PushDataValueSchema);

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(min, Math.min(Math.floor(value), max));
}

function safePushData(reply: ChannelReply): Record<string, unknown> {
  const parsed = PushMetadataSchema.safeParse(reply.metadata ?? {});
  const metadata = parsed.success
    ? Object.fromEntries(Object.entries(parsed.data).slice(0, MAX_PUSH_METADATA_KEYS))
    : {};
  return {
    ...metadata,
    type: "message",
    chatId: reply.chatId,
  };
}

export function createPushAdapter(): ChannelAdapter & {
  registerToken(token: string, platform: string, ownerId?: string): void;
  removeToken(token: string, ownerId?: string): void;
  getTokens(): PushToken[];
};
export function createPushAdapter(options: PushAdapterOptions): ChannelAdapter & {
  registerToken(token: string, platform: string, ownerId?: string): void;
  removeToken(token: string, ownerId?: string): void;
  getTokens(): PushToken[];
};
export function createPushAdapter(options: PushAdapterOptions = {}): ChannelAdapter & {
  registerToken(token: string, platform: string, ownerId?: string): void;
  removeToken(token: string, ownerId?: string): void;
  getTokens(): PushToken[];
} {
  const tokens: Map<string, PushToken> = new Map();
  const sendTimestamps: number[] = [];
  let messageHandler: (msg: ChannelMessage) => void = () => {};
  const now = options.now ?? (() => Date.now());
  const maxRegisteredTokens = clampInteger(options.maxRegisteredTokens, DEFAULT_MAX_REGISTERED_TOKENS, 1, 64);
  const maxRegisteredOwners = clampInteger(options.maxRegisteredOwners, DEFAULT_MAX_REGISTERED_OWNERS, 1, 2_048);
  const maxFanoutTokens = clampInteger(options.maxFanoutTokens, DEFAULT_MAX_FANOUT_TOKENS, 1, 256);
  const tokenTtlMs = clampInteger(options.tokenTtlMs, DEFAULT_TOKEN_TTL_MS, 60_000, 90 * 24 * 60 * 60 * 1000);

  function ownerKey(ownerId: string | undefined): string {
    return ownerId ?? "__anonymous__";
  }

  function tokenKey(token: string, ownerId: string | undefined): string {
    return JSON.stringify([ownerId ?? null, token]);
  }

  function sweepExpiredTokens(currentTime = now()): void {
    const cutoff = currentTime - tokenTtlMs;
    for (const [key, registered] of tokens) {
      if (registered.registeredAt < cutoff) tokens.delete(key);
    }
  }

  function ownerExists(ownerId: string | undefined): boolean {
    for (const registered of tokens.values()) {
      if (registered.ownerId === ownerId) return true;
    }
    return false;
  }

  function ownerCount(): number {
    const ownerKeys = new Set<string>();
    for (const registered of tokens.values()) {
      ownerKeys.add(ownerKey(registered.ownerId));
      if (ownerKeys.size >= maxRegisteredOwners) break;
    }
    return ownerKeys.size;
  }

  function canRegisterOwner(ownerId: string | undefined): boolean {
    return ownerExists(ownerId) || ownerCount() < maxRegisteredOwners;
  }

  function evictOldestTokensForOwner(ownerId: string | undefined): void {
    while (Array.from(tokens.values()).filter((registered) => registered.ownerId === ownerId).length > maxRegisteredTokens) {
      let oldestKey: string | null = null;
      let oldestRegisteredAt = Number.POSITIVE_INFINITY;
      for (const [key, registered] of tokens) {
        if (registered.ownerId !== ownerId) continue;
        if (registered.registeredAt < oldestRegisteredAt) {
          oldestKey = key;
          oldestRegisteredAt = registered.registeredAt;
        }
      }
      if (!oldestKey) break;
      tokens.delete(oldestKey);
    }
  }

  function activeTokensForOwner(ownerId: string | undefined): string[] {
    sweepExpiredTokens();
    const newestByToken = new Map<string, PushToken>();
    for (const registered of tokens.values()) {
      if (ownerId !== undefined && registered.ownerId !== ownerId) continue;
      const previous = newestByToken.get(registered.token);
      if (!previous || registered.registeredAt > previous.registeredAt) {
        newestByToken.set(registered.token, registered);
      }
    }
    return Array.from(newestByToken.values())
      .sort((a, b) => b.registeredAt - a.registeredAt)
      .slice(0, maxFanoutTokens)
      .map((registered) => registered.token);
  }

  function isRateLimited(): boolean {
    const currentTime = now();
    const cutoff = currentTime - RATE_LIMIT_WINDOW_MS;
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
      signal: AbortSignal.timeout(10_000),
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

    registerToken(token: string, platform: string, ownerId?: string) {
      sweepExpiredTokens();
      if (!canRegisterOwner(ownerId)) return;
      tokens.set(tokenKey(token, ownerId), { token, platform, ownerId, registeredAt: now() });
      evictOldestTokensForOwner(ownerId);
    },

    removeToken(token: string, ownerId?: string) {
      if (ownerId !== undefined) {
        tokens.delete(tokenKey(token, ownerId));
        return;
      }
      for (const [key, registered] of tokens) {
        if (registered.token === token) tokens.delete(key);
      }
    },

    getTokens(): PushToken[] {
      sweepExpiredTokens();
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

      sendTimestamps.push(now());

      const uniqueTokens = activeTokensForOwner(reply.ownerId);
      if (uniqueTokens.length === 0) return;

      await sendPush(uniqueTokens, "Matrix OS", reply.text, safePushData(reply));
    },

    set onMessage(handler: (msg: ChannelMessage) => void) {
      messageHandler = handler;
    },
    get onMessage() {
      return messageHandler;
    },
  };
}
