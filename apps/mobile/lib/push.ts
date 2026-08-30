import * as Notifications from "expo-notifications";
import { z } from "zod/v4";

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
