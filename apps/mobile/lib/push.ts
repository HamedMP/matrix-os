import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { Router } from "expo-router";
import type { GatewayClient } from "./gateway-client";

export type NotificationCategory = "message" | "task" | "cron" | "security";

export interface NotificationData {
  category?: NotificationCategory;
  taskId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function registerPushNotifications(client: GatewayClient): Promise<string | null> {
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") {
    return null;
  }

  const tokenData = await Notifications.getExpoPushTokenAsync();
  const token = tokenData.data;

  await client.registerPushToken(token, Platform.OS);

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Matrix OS",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#c2703a",
    });
  }

  return token;
}

export function getRouteForNotification(data: NotificationData): string {
  switch (data.category) {
    case "task":
      return "/(tabs)/mission-control";
    case "cron":
      return "/(tabs)/mission-control";
    case "message":
      return "/(tabs)/chat";
    case "security":
      return "/(tabs)/settings";
    default:
      return "/(tabs)/chat";
  }
}

export function handleNotificationTap(
  response: Notifications.NotificationResponse,
  router: Router,
): void {
  const data = (response.notification.request.content.data ?? {}) as NotificationData;
  const route = getRouteForNotification(data);
  router.navigate(route as any);
}

export function addNotificationResponseListener(
  handler: (response: Notifications.NotificationResponse) => void,
): Notifications.Subscription {
  return Notifications.addNotificationResponseReceivedListener(handler);
}

export function addNotificationReceivedListener(
  handler: (notification: Notifications.Notification) => void,
): Notifications.Subscription {
  return Notifications.addNotificationReceivedListener(handler);
}
