import type { Kysely } from "kysely";
import type { PushAdapter } from "../channels/push.js";
import type { NotificationPreferenceStore } from "../notifications/preferences-store.js";
import type { NotificationDatabase } from "../notifications/schema.js";
import { createNotificationRouter } from "../notifications/router.js";

export function initializeCanonicalNotifications(options: {
  db: Kysely<NotificationDatabase> | null; push: PushAdapter; preferences: NotificationPreferenceStore;
}) {
  const ownerId = process.env.MATRIX_USER_ID || process.env.MATRIX_CLERK_USER_ID;
  // Unconfigured local runtimes keep the legacy path. Customer/preview hosts always name their owner and handle.
  if (!options.db || !ownerId || !process.env.MATRIX_HANDLE) return undefined;
  const router = createNotificationRouter({ db: options.db, ownerId,
    preferences: () => options.preferences.load({ userId: ownerId, source: "configured-container" }),
    transport: { send: notification => options.push.sendAttention(notification) },
    enabled: () => process.env.MATRIX_NOTIFICATIONS_ROUTER !== "off",
  });
  router.start();
  return router;
}
