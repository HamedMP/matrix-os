import { useEffect } from "react";
import { Alert, AppState } from "react-native";
import * as Updates from "expo-updates";
import { capture } from "@/lib/analytics";

const FOREGROUND_CHECK_INTERVAL_MS = 15 * 60 * 1000;

// Native rejects with these codes when this build can never check for updates
// (updates disabled, or a development client), so retrying is pointless.
const UNSUPPORTED_CHECK_CODES = new Set(["ERR_UPDATES_DISABLED", "ERR_NOT_AVAILABLE_IN_DEV_CLIENT"]);

// Session state lives at module scope rather than in refs: the prompt remounts
// with the shell (for example when the biometric gate re-locks), and a remount
// must neither re-prompt for the same update nor reset the check throttle.
let promptedKey: string | null = null;
// expo-updates already checks on launch, so the first foreground check waits a
// full interval.
let lastCheckAt = Date.now();
let checkInFlight = false;
let reloadInFlight = false;
let checksUnsupported = false;

/** Test-only: forget everything remembered about this app session. */
export function resetOtaUpdatePromptSession(): void {
  promptedKey = null;
  lastCheckAt = Date.now();
  checkInFlight = false;
  reloadInFlight = false;
  checksUnsupported = false;
}

function errorLabel(error: unknown): string {
  // expo-updates errors carry a stable `code` (ERR_UPDATES_CHECK, ...). Log that
  // or the error name, never the message.
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "unknown";
}

// A roll back to the embedded update has no id, so it is keyed by its timestamp.
function promptKey(update: Updates.UpdateInfo): string {
  if (update.type === Updates.UpdateInfoType.ROLLBACK) return `rollback:${update.createdAt.getTime()}`;
  return update.updateId || `new:${update.createdAt.getTime()}`;
}

function restartIntoUpdate(updateType: Updates.UpdateInfoType): void {
  if (reloadInFlight) return;
  reloadInFlight = true;
  capture("mobile_ota_update_accepted", { update_type: updateType });

  void Updates.reloadAsync()
    .catch((error: unknown) => {
      console.warn("[mobile] OTA update restart failed", errorLabel(error));
      capture("mobile_ota_update_reload_failed", { update_type: updateType });
      Alert.alert("Couldn’t restart", "The update will apply the next time you open the app.");
    })
    .finally(() => {
      reloadInFlight = false;
    });
}

// The system alert is a deliberate interim choice: it needs no design work and
// behaves correctly on both platforms. A custom in-app surface is planned.
function promptToRestart(updateType: Updates.UpdateInfoType): void {
  capture("mobile_ota_update_prompt_shown", { update_type: updateType });
  Alert.alert(
    "Update ready",
    "A new version of Matrix OS is ready. Restart now to use it, or it’ll apply the next time you open the app.",
    [
      {
        text: "Later",
        style: "cancel",
        onPress: () => capture("mobile_ota_update_deferred", { update_type: updateType }),
      },
      { text: "Update now", onPress: () => restartIntoUpdate(updateType) },
    ],
  );
}

async function checkForUpdateOnForeground(): Promise<void> {
  if (checksUnsupported || checkInFlight) return;
  if (Date.now() - lastCheckAt < FOREGROUND_CHECK_INTERVAL_MS) return;
  checkInFlight = true;
  lastCheckAt = Date.now();

  try {
    const result = await Updates.checkForUpdateAsync();
    // The download surfaces through useUpdates(), which raises the prompt.
    if (result.isAvailable || result.isRollBackToEmbedded) await Updates.fetchUpdateAsync();
  } catch (error: unknown) {
    const label = errorLabel(error);
    if (UNSUPPORTED_CHECK_CODES.has(label)) checksUnsupported = true;
    console.warn("[mobile] OTA update check failed", label);
  } finally {
    checkInFlight = false;
  }
}

/**
 * Offers to restart into an over-the-air update once it has finished
 * downloading, and looks for a newer one whenever the app returns to the
 * foreground. Declining is safe: expo-updates applies a downloaded update on the
 * next cold start by itself.
 */
export function useOtaUpdatePrompt(): void {
  const { currentlyRunning, downloadedUpdate, isUpdatePending } = Updates.useUpdates();
  const runningUpdateId = currentlyRunning.updateId;

  useEffect(() => {
    // `isUpdatePending` is also set when a fetch finds nothing new, so the
    // downloaded update itself is what decides whether there is anything to offer.
    if (!isUpdatePending || !downloadedUpdate) return;
    const key = promptKey(downloadedUpdate);
    if (key === promptedKey || key === runningUpdateId) return;
    promptedKey = key;
    promptToRestart(downloadedUpdate.type);
  }, [isUpdatePending, downloadedUpdate, runningUpdateId]);

  useEffect(() => {
    if (!Updates.isEnabled) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void checkForUpdateOnForeground();
    });
    return () => subscription.remove();
  }, []);
}
