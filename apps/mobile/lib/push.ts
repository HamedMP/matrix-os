import * as Notifications from "expo-notifications";
import type { Router } from "expo-router";

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
