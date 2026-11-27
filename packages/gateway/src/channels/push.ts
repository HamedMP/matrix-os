import type { ChannelAdapter, ChannelConfig, ChannelMessage, ChannelReply } from "./types.js";
import { z } from "zod/v4";
import { MatrixComputerHandleSchema } from "@matrix-os/contracts";
import type { PushRegistrationStatus, PushTokenStore } from "../notifications/push-tokens.js";
import { SAFE_PRINCIPAL_USER_ID } from "../request-principal.js";
import { AttentionPushSchema, AttentionPhoneDataSchema, type AttentionPush } from "../notifications/copy.js";
import type { PushDeliveryReceipts } from "../notifications/delivery-receipts.js";
import { NotificationDeferredError } from "../notifications/copy.js";
import { createHash } from "node:crypto";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const MAX_PUSH_METADATA_KEYS = 10;
const DEFAULT_MAX_REGISTERED_TOKENS = 16;
const DEFAULT_MAX_FANOUT_TOKENS = 32;
const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
// notification_push_tokens.owner_id holds at most 128 characters.
const MAX_OWNER_ID_LENGTH = 128;

/** The owner database was missing at startup: a server misconfiguration, not "no devices". */
export class PushTokenStorageUnavailableError extends Error {
  constructor() {
    super("Push token storage is unavailable");
    this.name = "PushTokenStorageUnavailableError";
  }
}

export interface PushAdapterOptions {
  attentionReceipts?: PushDeliveryReceipts;
  /** Owner Postgres token storage, resolved once at startup; null when the owner database is missing. */
  tokens: PushTokenStore | null;
  /** This computer's MATRIX_HANDLE. Every push names it so the phone can switch to this computer. */
  handle?: string;
  /**
   * This computer's owner (MATRIX_USER_ID, else MATRIX_CLERK_USER_ID). A push that names no owner,
   * such as a scheduled message, goes only to this owner's tokens, and to nobody when it is unset.
   */
  ownerId?: string;
  now?: () => number;
  maxRegisteredTokens?: number;
  maxFanoutTokens?: number;
  tokenTtlMs?: number;
}

export interface PushAdapter extends ChannelAdapter {
  sendAttention(notification: AttentionPush): Promise<void>;
  registerToken(token: string, platform: string, ownerId: string, identity?: string): Promise<void>;
  registerLegacyToken(token: string, platform: string, ownerId: string, identity?: string): Promise<boolean>;
  refreshToken(token: string, platform: string, ownerId: string, identity?: string): Promise<boolean>;
  removeToken(token: string, ownerId: string, deliveryToken?: string): Promise<void>;
  getRegistrationStatus(identity: string, ownerId: string): Promise<PushRegistrationStatus>;
  /** Deletes tokens unseen for the TTL. Runs hourly until `dispose()`. */
  sweepExpiredTokens(): Promise<number>;
  dispose(): void;
}

const PushDataValueSchema = z.union([
  z.string().max(160),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const PushMetadataSchema = z.record(z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/), PushDataValueSchema);
const ExpoTicketsSchema = z.object({
  data: z.array(z.object({
    status: z.string(),
    details: z.object({ error: z.string().optional() }).optional(),
  })).max(DEFAULT_MAX_FANOUT_TOKENS * 8),
});

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(min, Math.min(Math.floor(value), max));
}

/** Bounded log text for storage failures: the error class and SQLSTATE, never the message. */
export function describePushStorageError(err: unknown): string {
  if (!(err instanceof Error)) return "UnknownError";
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? `${err.name} ${code}` : err.name;
}

function resolvePushHandle(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = MatrixComputerHandleSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.warn("[push] MATRIX_HANDLE is not a valid computer handle; pushes will not name this computer");
  return undefined;
}

function resolvePushOwner(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (SAFE_PRINCIPAL_USER_ID.test(value) && value.length <= MAX_OWNER_ID_LENGTH) return value;
  console.warn("[push] This computer's owner is not a valid user id; pushes that name no owner will not be sent");
  return undefined;
}

function safePushData(reply: ChannelReply, handle: string | undefined): Record<string, unknown> {
  const parsed = PushMetadataSchema.safeParse(reply.metadata ?? {});
  const metadata = parsed.success
    ? Object.fromEntries(Object.entries(parsed.data).filter(([key]) => key !== "handle").slice(0, MAX_PUSH_METADATA_KEYS))
    : {};
  return {
    ...metadata,
    type: "message",
    chatId: reply.chatId,
    ...(handle ? { handle } : {}),
  };
}

export function createPushAdapter(options: PushAdapterOptions): PushAdapter {
  const tokens = options.tokens;
  const handle = resolvePushHandle(options.handle);
  const computerOwnerId = resolvePushOwner(options.ownerId);
  const sendTimestamps: number[] = [];
  let messageHandler: (msg: ChannelMessage) => void = () => {};
  const now = options.now ?? (() => Date.now());
  const maxRegisteredTokens = clampInteger(options.maxRegisteredTokens, DEFAULT_MAX_REGISTERED_TOKENS, 1, 64);
  const maxFanoutTokens = clampInteger(options.maxFanoutTokens, DEFAULT_MAX_FANOUT_TOKENS, 1, 256);
  const tokenTtlMs = clampInteger(options.tokenTtlMs, DEFAULT_TOKEN_TTL_MS, 60_000, 90 * 24 * 60 * 60 * 1000);

  if (!tokens) console.error("[push] Owner database unavailable; push tokens cannot be stored or read");

  function requireTokens(): PushTokenStore {
    if (!tokens) throw new PushTokenStorageUnavailableError();
    return tokens;
  }

  function tokenCutoff(): Date {
    return new Date(now() - tokenTtlMs);
  }

  async function sweepExpiredTokens(): Promise<number> {
    return requireTokens().deleteUnseenBefore(tokenCutoff());
  }

  let sweeping = false;
  let sweepTimer: ReturnType<typeof setInterval> | null = tokens
    ? setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      void sweepExpiredTokens()
        .catch((err: unknown) => {
          console.warn("[push] Push token sweep failed:", describePushStorageError(err));
        })
        .finally(() => { sweeping = false; });
    }, TOKEN_SWEEP_INTERVAL_MS)
    : null;
  sweepTimer?.unref?.();

  function isRateLimited(): boolean {
    const currentTime = now();
    const cutoff = currentTime - RATE_LIMIT_WINDOW_MS;
    while (sendTimestamps.length > 0 && sendTimestamps[0] < cutoff) {
      sendTimestamps.shift();
    }
    return sendTimestamps.length >= RATE_LIMIT_MAX;
  }

  async function removeUnregisteredDevices(store: PushTokenStore, sent: readonly string[], body: unknown): Promise<void> {
    const tickets = ExpoTicketsSchema.safeParse(body);
    if (!tickets.success || tickets.data.data.length !== sent.length) return;
    const gone = sent.filter((_, index) => tickets.data.data[index].details?.error === "DeviceNotRegistered");
    if (gone.length === 0) return;
    try {
      await store.removeDeviceTokens(gone);
    } catch (err: unknown) {
      console.warn("[push] Failed to remove unregistered push tokens:", describePushStorageError(err));
    }
  }

  async function sendPush(store: PushTokenStore, pushTokens: string[], body: string, data: Record<string, unknown>, attention?: AttentionPush): Promise<void> {
    const messages = pushTokens.map((token) => ({
      to: token,
      title: "Matrix OS",
      body: body.length > 200 ? body.slice(0, 197) + "..." : body,
      sound: "default" as const,
      data,
      channelId: "default",
      ...(attention ? { title: attention.title, sound: attention.sound ? "default" : null,
        channelId: "attention", interruptionLevel: attention.timeSensitive ? "time-sensitive" : "active",
        collapseId: attention.id, priority: "high", ttl: Math.max(0, Math.floor((Date.parse(attention.expiresAt) - now()) / 1000)) } : {}),
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
      if (attention) throw new Error("Push transport unavailable");
      console.warn(`[push] Expo push request failed with HTTP ${res.status}`);
      return;
    }
    const tickets: unknown = await res.json().catch((err: unknown) => {
      console.warn("[push] Expo push response was not JSON:", err instanceof Error ? err.name : "UnknownError");
      return null;
    });
    await removeUnregisteredDevices(store, pushTokens, tickets);
    if (attention) {
      const parsed = ExpoTicketsSchema.safeParse(tickets);
      if (!parsed.success || parsed.data.data.length !== pushTokens.length) throw new Error("Push transport unavailable");
      const accepted = pushTokens.filter((_, index) => parsed.data.data[index]!.status === "ok");
      // Persist known accepts before retrying any rejected device; tokens themselves never enter the journal.
      await options.attentionReceipts?.remember(attention.id, attention.ownerId, accepted.map(token => createHash("sha256").update(token).digest("hex")));
      if (parsed.data.data.some(ticket => ticket.status !== "ok" && ticket.details?.error !== "DeviceNotRegistered")) throw new Error("Push transport unavailable");
    }
  }

  return {
    id: "push",

    async sendAttention(input) {
      const notification = AttentionPushSchema.parse(input);
      const data = AttentionPhoneDataSchema.parse({ v: 1, notificationId: notification.id, handle, target: notification.target });
      if (computerOwnerId !== notification.ownerId) throw new Error("Push owner unavailable");
      if (Date.parse(notification.expiresAt) <= now()) return;
      if (isRateLimited()) throw new NotificationDeferredError(sendTimestamps[0]! + RATE_LIMIT_WINDOW_MS + 1);
      const store = requireTokens();
      const delivered = await options.attentionReceipts?.delivered(notification.id, notification.ownerId) ?? [];
      const recipients = (await store.listRecent({ ownerId: notification.ownerId, seenSince: tokenCutoff(), limit: maxFanoutTokens }))
        .filter(token => !delivered.includes(createHash("sha256").update(token).digest("hex")));
      if (!recipients.length) return;
      sendTimestamps.push(now());
      await sendPush(store, recipients, notification.body, data, notification);
    },

    async registerToken(token: string, platform: string, ownerId: string, identity = token) {
      await requireTokens().register({ token, identity, platform, ownerId, seenAt: new Date(now()), maxPerOwner: maxRegisteredTokens });
    },

    async registerLegacyToken(token: string, platform: string, ownerId: string, identity = token) {
      return requireTokens().registerLegacy({ token, identity, platform, ownerId, seenAt: new Date(now()), maxPerOwner: maxRegisteredTokens });
    },

    async refreshToken(token: string, platform: string, ownerId: string, identity = token) {
      return requireTokens().refresh({ token, identity, platform, ownerId, seenAt: new Date(now()), maxPerOwner: maxRegisteredTokens });
    },

    async removeToken(token: string, ownerId: string, deliveryToken?: string) {
      await requireTokens().remove({ token, ownerId, ...(deliveryToken ? { deliveryToken } : {}), seenAt: new Date(now()) });
    },

    async getRegistrationStatus(identity: string, ownerId: string) {
      return requireTokens().status({ identity, ownerId, seenSince: tokenCutoff() });
    },

    sweepExpiredTokens,

    async start(_config: ChannelConfig) {
      // Push adapter is always ready -- no polling needed
    },

    async stop() {
      // Tokens are owner data in Postgres: stopping the channel must not forget devices.
    },

    dispose() {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
    },

    async send(reply: ChannelReply) {
      if (!tokens) {
        console.error("[push] Owner database unavailable; push not sent");
        return;
      }
      const ownerId = reply.ownerId ?? computerOwnerId;
      if (ownerId === undefined) {
        console.warn("[push] Push names no owner and this computer's owner is unknown; push not sent");
        return;
      }
      if (isRateLimited()) return;

      sendTimestamps.push(now());

      const recipients = await tokens.listRecent({ ownerId, seenSince: tokenCutoff(), limit: maxFanoutTokens });
      if (recipients.length === 0) return;

      await sendPush(tokens, recipients, reply.text, safePushData(reply, handle));
    },

    set onMessage(handler: (msg: ChannelMessage) => void) {
      messageHandler = handler;
    },
    get onMessage() {
      return messageHandler;
    },
  };
}
