import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { z } from "zod/v4";
import { CanonicalChatIdSchema, MatrixComputerHandleSchema, ThreadIdSchema } from "@matrix-os/contracts";

import { fetchPushRegistrationStatus, refreshPushRegistration, updatePushRegistration } from "@/lib/requests/settings";
import { ensureNotificationChannels } from "@/lib/notification-channels";
import type { RequestToken } from "@/lib/requests/http";

const PUSH_TOKEN_KEY = "matrix_os_expo_push_token";
const PUSH_IDENTITY_KEY = "matrix_os_push_identity";

export const NotificationTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chat"), chatId: CanonicalChatIdSchema }),
  z.object({ type: z.literal("thread"), threadId: ThreadIdSchema }),
]);
export type NotificationTarget = z.infer<typeof NotificationTargetSchema>;

/**
 * Where tapping a notification leads: the chat or coding-agent thread it is
 * about, and the computer it came from when the payload names one. A null
 * target opens the chat list.
 */
export interface NotificationDestination {
  handle: string | null;
  target: NotificationTarget | null;
}

// Spec 652's payload carries ids only, never a URL to open.
const NotificationPayloadV1Schema = z.object({
  v: z.literal(1),
  notificationId: z.uuid(),
  handle: MatrixComputerHandleSchema,
  target: NotificationTargetSchema,
});

// What gateways send until the notifications router: coding-agent pushes carry
// `{ category: "agent", threadId, chatId: "coding-agents" }`, where `chatId`
// names the push channel's own chat rather than a Matrix chat. Spec 652's A2
// adds the sending computer's `handle`; older computers leave it out.
const PreRouterPayloadSchema = z.object({
  threadId: z.unknown().optional(),
  chatId: z.unknown().optional(),
  handle: MatrixComputerHandleSchema.optional(),
});

const CHAT_LIST: NotificationDestination = { handle: null, target: null };

export function parseNotificationDestination(data: unknown): NotificationDestination {
  if (typeof data === "object" && data !== null && "v" in data) {
    const payload = NotificationPayloadV1Schema.safeParse(data);
    return payload.success ? { handle: payload.data.handle, target: payload.data.target } : CHAT_LIST;
  }
  const payload = PreRouterPayloadSchema.safeParse(data);
  if (!payload.success) return CHAT_LIST;
  const handle = payload.data.handle ?? null;
  const threadId = ThreadIdSchema.safeParse(payload.data.threadId);
  if (threadId.success) return { handle, target: { type: "thread", threadId: threadId.data } };
  const chatId = CanonicalChatIdSchema.safeParse(payload.data.chatId);
  return chatId.success ? { handle, target: { type: "chat", chatId: chatId.data } } : CHAT_LIST;
}

/** A tap on the notification itself, rather than one of its actions or a dismissal. */
export function isNotificationTap(response: Notifications.NotificationResponse): boolean {
  return response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER;
}

/** What is on screen that a notification could be about, and on which computer. */
export type NotificationScreen =
  | { kind: "chat"; handle: string | null; chatId: string }
  /** A terminal tab, named `workspaceId:tabId` as the terminal screen names it. */
  | { kind: "terminal"; handle: string | null; session: string };

const SHOWN: Notifications.NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: true,
};
const QUIET: Notifications.NotificationBehavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

export const defaultNotificationHandler: Notifications.NotificationHandler = {
  handleNotification: async () => SHOWN,
};

// Until the shell's notification router takes over, every notification shows.
Notifications.setNotificationHandler(defaultNotificationHandler);

/**
 * Expo drops a notification it gets no answer about within three seconds, so
 * the check gives up well before that, token refresh and lookup included.
 */
const FOREGROUND_DECISION_MS = 2_000;

/** `promise`'s value, or `fallback` once `ms` have passed without one. */
function within<T>(ms: number, promise: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Fetching the push token has no time limit of its own and can hang when the
 * phone cannot reach Apple or Google. Push changes run one at a time, so one
 * that never ends would hold the switch and every later re-registration.
 */
const PUSH_TOKEN_TIMEOUT_MS = 15_000;

/** Expo's push token for this install, or an error once the time limit passes. */
async function expoPushToken(
  options: Notifications.ExpoPushTokenOptions | undefined,
): Promise<Notifications.ExpoPushToken> {
  const token = await within(PUSH_TOKEN_TIMEOUT_MS, Notifications.getExpoPushTokenAsync(options), null);
  if (!token) throw new Error("Push token unavailable.");
  return token;
}

/**
 * Shows a notification that arrives while the app is open, unless it is about
 * the chat or thread already on screen. `threadTerminal` finds the terminal a
 * coding-agent thread runs in; a notification it cannot place in time shows.
 */
export function createNotificationHandler(input: {
  screen: () => NotificationScreen | null;
  threadTerminal: (threadId: string) => Promise<string | null>;
}): Notifications.NotificationHandler {
  return {
    handleNotification: async (notification) => {
      const destination = parseNotificationDestination(notification.request.content.data);
      return (await within(FOREGROUND_DECISION_MS, isOnScreen(destination, input), false)) ? QUIET : SHOWN;
    },
  };
}

async function isOnScreen(
  { handle, target }: NotificationDestination,
  { screen, threadTerminal }: Parameters<typeof createNotificationHandler>[0],
): Promise<boolean> {
  const shown = screen();
  if (!target || !shown) return false;
  // Ids are per computer: a notification that names one is about this screen
  // only when this screen is known to be on it.
  if (handle !== null && shown.handle !== handle) return false;
  if (target.type === "chat") return shown.kind === "chat" && shown.chatId === target.chatId;
  if (shown.kind !== "terminal") return false;
  try {
    return (await threadTerminal(target.threadId)) === shown.session;
  } catch (err: unknown) {
    console.warn("[mobile] Notification thread lookup failed:", err instanceof Error ? err.message : "unknown");
    return false;
  }
}

export function addNotificationResponseListener(
  handler: (response: Notifications.NotificationResponse) => void,
): Notifications.EventSubscription {
  return Notifications.addNotificationResponseReceivedListener(handler);
}

export interface PushRegistrationSession {
  clerkToken: RequestToken;
  gatewayUrl: string;
  /** Client-only account/computer identity for stale-response and event guards. */
  scopeKey?: string;
}

export class PushIdentityUnavailableError extends Error {
  constructor() {
    super("Push registration identity unavailable.");
    this.name = "PushIdentityUnavailableError";
  }
}

async function readExpoPushIdentity(): Promise<string> {
  const projectId = Constants.easConfig?.projectId
    ?? (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId;
  return (await expoPushToken(projectId ? { projectId } : undefined)).data;
}

async function pushIdentity(currentDelivery?: string): Promise<string> {
  const identity = await SecureStore.getItemAsync(PUSH_IDENTITY_KEY);
  if (identity) return identity;
  const cached = await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
  const retained = cached ?? currentDelivery;
  if (retained) {
    await SecureStore.setItemAsync(PUSH_IDENTITY_KEY, retained);
    return retained;
  }
  // Older opt-out deleted the shared cache while other computers could still
  // have this phone registered. A cache miss is not proof of revocation.
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) throw new PushIdentityUnavailableError();
  await ensureNotificationChannels();
  const token = await readExpoPushIdentity();
  await SecureStore.setItemAsync(PUSH_IDENTITY_KEY, token);
  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
  return token;
}

/** null requires a deliberate per-computer choice; cached identity is not consent. */
export async function isPushNotificationsEnabled(input: PushRegistrationSession): Promise<boolean | null> {
  const token = await pushIdentity();
  return fetchPushRegistrationStatus({ ...input, expoPushToken: token });
}

export async function enablePushNotifications(input: PushRegistrationSession): Promise<void> {
  await ensureNotificationChannels();
  const existing = await Notifications.getPermissionsAsync();
  const permission = existing.granted ? existing : await Notifications.requestPermissionsAsync();
  if (!permission.granted) throw new Error("Push notification permission was not granted.");

  const token = await readExpoPushIdentity();
  const identity = await pushIdentity(token);

  // A saved identity is not opt-in. Persist it before the remote write so a
  // lost response or storage failure cannot leave an unidentifiable device row.
  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
  await updatePushRegistration({
    clerkToken: input.clerkToken,
    gatewayUrl: input.gatewayUrl,
    expoPushToken: token,
    identity,
    platform: Platform.OS,
    enabled: true,
  });
}

/** Refresh delivery for an existing consent; the server makes the final check. */
export async function refreshPushNotifications(input: PushRegistrationSession, isCurrent = () => true): Promise<boolean> {
  const identity = await pushIdentity();
  if (!isCurrent()) return false;
  const token = await readExpoPushIdentity();
  if (!isCurrent()) return false;
  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
  if (!isCurrent()) return false;
  return refreshPushRegistration({ ...input, identity, expoPushToken: token, platform: Platform.OS });
}

export async function disablePushNotifications(input: PushRegistrationSession): Promise<void> {
  const token = await pushIdentity();
  const cached = await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
  await updatePushRegistration({
    clerkToken: input.clerkToken,
    gatewayUrl: input.gatewayUrl,
    expoPushToken: token,
    platform: Platform.OS,
    enabled: false,
    ...(cached && cached !== token ? { deliveryToken: cached } : {}),
  });
  // The identity is shared across computers, but this gateway records the
  // explicit opt-out and removes all delivery tokens linked to it.
}
