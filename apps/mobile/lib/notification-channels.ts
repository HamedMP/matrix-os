import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

type ChannelInput = Parameters<typeof Notifications.setNotificationChannelAsync>[1];

/**
 * Android notification channels (spec 652). From release A6 on, pushes name
 * `replies` or `attention`. Pushes sent before that name no channel and land
 * on `default`, so it stays as it was.
 */
function channels(): Record<string, ChannelInput> {
  return {
    default: {
      name: "Matrix OS",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#2B3715",
    },
    replies: {
      name: "Replies",
      description: "When an agent finishes a reply or a run fails",
      importance: Notifications.AndroidImportance.DEFAULT,
    },
    attention: {
      name: "Approvals and questions",
      description: "When an agent is waiting for your approval or an answer",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#2B3715",
    },
  };
}

/**
 * Creates the Android channels, or updates their names. Runs before any
 * permission or push token request: Android 13 and later only show the
 * notification prompt once a channel exists.
 */
export async function ensureNotificationChannels(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Promise.all(
    Object.entries(channels()).map(([id, channel]) => Notifications.setNotificationChannelAsync(id, channel)),
  );
}

/** Creates the channels at launch, so a JS update's new channel reaches phones that already have push on. */
export function createNotificationChannelsAtStartup(): void {
  ensureNotificationChannels().catch((err: unknown) => {
    console.warn(
      "[mobile] Notification channels could not be created:",
      err instanceof Error ? err.message : "unknown",
    );
  });
}
