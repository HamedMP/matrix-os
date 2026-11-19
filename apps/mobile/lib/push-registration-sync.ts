import * as Notifications from "expo-notifications";

import {
  disablePushNotifications,
  enablePushNotifications,
  isPushNotificationsEnabled,
} from "@/lib/push";

export type PushRegistrationResult = "off" | "registered" | "denied";

// The tail of the push changes waiting to run. It never rejects.
let pushChanges: Promise<unknown> = Promise.resolve();

/**
 * Runs one push change after the ones before it have finished: the push switch
 * and the re-registration on launch and foreground both save and remove the
 * same token, so overlapping runs could undo each other (a sync that read "on"
 * registering again just after the switch turned push off). Every step of a
 * change is bounded (the token fetch and the gateway call have time limits) or
 * waits on the system permission prompt, which covers the app until answered.
 */
export function queuePushChange<T>(change: () => Promise<T>): Promise<T> {
  const run = pushChanges.then(change);
  pushChanges = Promise.allSettled([run]);
  return run;
}

type PushTurnedOffListener = () => void;

// Only open App settings screens listen, so a few slots are plenty.
const MAX_PUSH_TURNED_OFF_LISTENERS = 8;
let pushTurnedOffListeners: PushTurnedOffListener[] = [];

/**
 * Calls `listener` when re-registration turns push off because permission was
 * refused, so a screen showing the push switch can follow. Returns the
 * function that stops listening.
 */
export function subscribePushTurnedOff(listener: PushTurnedOffListener): () => void {
  pushTurnedOffListeners = [...pushTurnedOffListeners, listener].slice(-MAX_PUSH_TURNED_OFF_LISTENERS);
  return () => {
    pushTurnedOffListeners = pushTurnedOffListeners.filter((current) => current !== listener);
  };
}

function notifyPushTurnedOff() {
  for (const listener of pushTurnedOffListeners) {
    try {
      listener();
    } catch (error: unknown) {
      console.warn("[mobile] Push state listener failed:", error instanceof Error ? error.message : "unknown");
    }
  }
}

/**
 * Brings this phone's push registration in line with its push switch, which is
 * on whenever a token is saved. iOS keeps that token in the Keychain after the
 * app is deleted, so a new install can start with push on, never asked for
 * permission and never registered. And the computer forgets a token it has not
 * seen for 30 days. So while push is on this asks for permission if it may
 * still ask, then registers again; without permission it turns push off, so
 * the switch shows what the phone can get.
 */
export function syncPushRegistration(session: {
  clerkToken: string;
  gatewayUrl: string;
}): Promise<PushRegistrationResult> {
  return queuePushChange(async () => {
    if (!(await isPushNotificationsEnabled())) return "off";

    const existing = await Notifications.getPermissionsAsync();
    const permission = existing.granted || !existing.canAskAgain
      ? existing
      : await Notifications.requestPermissionsAsync();
    if (!permission.granted) {
      await disablePushNotifications(session);
      notifyPushTurnedOff();
      return "denied";
    }

    await enablePushNotifications(session);
    return "registered";
  });
}
