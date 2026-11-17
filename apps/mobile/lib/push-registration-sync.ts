import * as Notifications from "expo-notifications";

import {
  disablePushNotifications,
  enablePushNotifications,
  isPushNotificationsEnabled,
} from "@/lib/push";

export type PushRegistrationResult = "off" | "registered" | "denied";

/**
 * How long a push change waits for the one before it. Fetching the push token
 * has no time limit of its own, and one that hangs must not hold the switch.
 */
const PREVIOUS_CHANGE_WAIT_MS = 20_000;

// The tail of the push changes waiting to run. It never rejects.
let pushChanges: Promise<unknown> = Promise.resolve();

/**
 * Runs one push change after the ones before it: the push switch and the
 * re-registration on launch and foreground both save and remove the same
 * token, so overlapping runs could undo each other (a sync that read "on"
 * registering again just after the switch turned push off).
 */
export function queuePushChange<T>(change: () => Promise<T>): Promise<T> {
  const run = settledOrLate(pushChanges, PREVIOUS_CHANGE_WAIT_MS).then(change);
  pushChanges = Promise.allSettled([run]);
  return run;
}

/** Resolves once `previous` settles, or after `ms` if it is still running. */
function settledOrLate(previous: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([Promise.allSettled([previous]).then(() => undefined), late])
    .finally(() => clearTimeout(timer));
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
      return "denied";
    }

    await enablePushNotifications(session);
    return "registered";
  });
}
