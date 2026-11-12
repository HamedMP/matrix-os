import type { ChannelAdapter, ChannelConfig, ChannelMessage, ChannelReply } from "./types.js";
import { z } from "zod/v4";
import { MatrixComputerHandleSchema } from "@matrix-os/contracts";
import type { PushTokenStore } from "../notifications/push-tokens.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const MAX_PUSH_METADATA_KEYS = 10;
const DEFAULT_MAX_REGISTERED_TOKENS = 16;
const DEFAULT_MAX_FANOUT_TOKENS = 32;
const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** The owner database was missing at startup: a server misconfiguration, not "no devices". */
export class PushTokenStorageUnavailableError extends Error {
  constructor() {
    super("Push token storage is unavailable");
    this.name = "PushTokenStorageUnavailableError";
  }
}

export interface PushAdapterOptions {
  /** Owner Postgres token storage, resolved once at startup; null when the owner database is missing. */
  tokens: PushTokenStore | null;
  /** This computer's MATRIX_HANDLE. Every push names it so the phone can switch to this computer. */
  handle?: string;
  now?: () => number;
  maxRegisteredTokens?: number;
  maxFanoutTokens?: number;
  tokenTtlMs?: number;
}

export interface PushAdapter extends ChannelAdapter {
  registerToken(token: string, platform: string, ownerId: string): Promise<void>;
  removeToken(token: string, ownerId: string): Promise<void>;
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

  async function sendPush(store: PushTokenStore, pushTokens: string[], body: string, data: Record<string, unknown>): Promise<void> {
    const messages = pushTokens.map((token) => ({
      to: token,
      title: "Matrix OS",
      body: body.length > 200 ? body.slice(0, 197) + "..." : body,
      sound: "default" as const,
      data,
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
      console.warn(`[push] Expo push request failed with HTTP ${res.status}`);
      return;
    }
    const tickets: unknown = await res.json().catch((err: unknown) => {
      console.warn("[push] Expo push response was not JSON:", err instanceof Error ? err.name : "UnknownError");
      return null;
    });
    await removeUnregisteredDevices(store, pushTokens, tickets);
  }

  return {
    id: "push",

    async registerToken(token: string, platform: string, ownerId: string) {
      await requireTokens().register({ token, platform, ownerId, seenAt: new Date(now()), maxPerOwner: maxRegisteredTokens });
    },

    async removeToken(token: string, ownerId: string) {
      await requireTokens().remove({ token, ownerId });
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
      if (isRateLimited()) return;

      sendTimestamps.push(now());

      const recipients = await tokens.listRecent({ ownerId: reply.ownerId, seenSince: tokenCutoff(), limit: maxFanoutTokens });
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
