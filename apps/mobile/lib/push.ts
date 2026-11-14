import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { z } from "zod/v4";
import { CanonicalChatIdSchema, MatrixComputerHandleSchema, ThreadIdSchema } from "@matrix-os/contracts";

import { updatePushRegistration } from "@/lib/requests/settings";

const PUSH_TOKEN_KEY = "matrix_os_expo_push_token";

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
 * Shows a notification that arrives while the app is open, unless it is about
 * the chat or thread already on screen. `threadTerminal` finds the terminal a
 * coding-agent thread runs in; the answer must come within three seconds or
 * the notification shows anyway.
 */
export function createNotificationHandler(input: {
  screen: () => NotificationScreen | null;
  threadTerminal: (threadId: string) => Promise<string | null>;
}): Notifications.NotificationHandler {
  return {
    handleNotification: async (notification) => {
      const destination = parseNotificationDestination(notification.request.content.data);
      return (await isOnScreen(destination, input)) ? QUIET : SHOWN;
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

export async function isPushNotificationsEnabled(): Promise<boolean> {
  return Boolean(await SecureStore.getItemAsync(PUSH_TOKEN_KEY));
}

export async function enablePushNotifications(input: {
  clerkToken: string;
  gatewayUrl: string;
}): Promise<void> {
  const existing = await Notifications.getPermissionsAsync();
  const permission = existing.granted ? existing : await Notifications.requestPermissionsAsync();
  if (!permission.granted) throw new Error("Push notification permission was not granted.");

  const projectId = Constants.easConfig?.projectId
    ?? (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId;
  const token = (await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  )).data;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Matrix OS",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#2B3715",
    });
  }

  await updatePushRegistration({
    clerkToken: input.clerkToken,
    gatewayUrl: input.gatewayUrl,
    expoPushToken: token,
    platform: Platform.OS,
    enabled: true,
  });
  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
}

export async function disablePushNotifications(input: {
  clerkToken: string;
  gatewayUrl: string;
}): Promise<void> {
  const token = await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
  if (!token) return;
  await updatePushRegistration({
    clerkToken: input.clerkToken,
    gatewayUrl: input.gatewayUrl,
    expoPushToken: token,
    platform: Platform.OS,
    enabled: false,
  });
  await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY);
}
