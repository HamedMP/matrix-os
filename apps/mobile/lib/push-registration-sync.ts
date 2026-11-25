import * as Notifications from "expo-notifications";
import { ensureNotificationChannels } from "@/lib/notification-channels";

import {
  disablePushNotifications,
  refreshPushNotifications,
  isPushNotificationsEnabled,
  type PushRegistrationSession,
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

type PushTurnedOffListener = (scopeKey: string | undefined) => void;

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

function notifyPushTurnedOff(scopeKey: string | undefined) {
  for (const listener of pushTurnedOffListeners) {
    try {
      listener(scopeKey);
    } catch (error: unknown) {
      console.warn("[mobile] Push state listener failed:", error instanceof Error ? error.message : "unknown");
    }
  }
}

/**
 * Restores delivery while durable owner/computer consent remains on. Token
 * expiry and Expo cleanup do not revoke consent; explicit opt-out does.
 * Conditional refresh cannot grant consent, including after a stale read.
 */
export function syncPushRegistration(session: PushRegistrationSession, isCurrent = () => true): Promise<PushRegistrationResult> {
  return queuePushChange(async () => {
    if (!isCurrent() || !(await isPushNotificationsEnabled(session)) || !isCurrent()) return "off";

    await ensureNotificationChannels();
    const existing = await Notifications.getPermissionsAsync();
    const permission = existing.granted || !existing.canAskAgain
      ? existing
      : await Notifications.requestPermissionsAsync();
    if (!isCurrent()) return "off";
    if (!permission.granted) {
      await disablePushNotifications(session);
      notifyPushTurnedOff(session.scopeKey);
      return "denied";
    }

    const registered = await refreshPushNotifications(session, isCurrent);
    if (!isCurrent()) return "off";
    if (!registered) notifyPushTurnedOff(session.scopeKey);
    return registered ? "registered" : "off";
  });
}
