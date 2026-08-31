import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { z } from "zod/v4";

import { updatePushRegistration } from "@/lib/requests/settings";

// expo-router 57 renamed the exported `Router` type to `ImperativeRouter`.
// A type-only `typeof import(...)` alias tracks the router shape without a
// runtime import and stays correct across future renames.
type Router = typeof import("expo-router").router;

export const NotificationCategorySchema = z.enum(["message", "task", "cron", "security", "agent"]);
export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;

const NotificationDataSchema = z.object({
  category: NotificationCategorySchema.optional(),
  taskId: z.unknown().optional(),
  sessionId: z.unknown().optional(),
  threadId: z.unknown().optional(),
}).passthrough();

export type NotificationData = z.input<typeof NotificationDataSchema>;

const PUSH_TOKEN_KEY = "matrix_os_expo_push_token";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

function parseNotificationData(data: unknown): z.infer<typeof NotificationDataSchema> {
  const parsed = NotificationDataSchema.safeParse(data);
  return parsed.success ? parsed.data : {};
}

export function getRouteForNotification(data: unknown): string {
  const notification = parseNotificationData(data);

  switch (notification.category) {
    case "task":
      return "/(drawer)";
    case "cron":
      return "/(drawer)";
    case "message":
      return "/(drawer)";
    case "security":
      return "/(drawer)";
    case "agent":
      return "/(drawer)";
    default:
      return "/(drawer)";
  }
}

export function handleNotificationTap(
  response: Notifications.NotificationResponse,
  router: Router,
): void {
  const data = response.notification.request.content.data ?? {};
  const route = getRouteForNotification(data);
  router.navigate(route as any);
}

export function addNotificationResponseListener(
  handler: (response: Notifications.NotificationResponse) => void,
): Notifications.Subscription {
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
