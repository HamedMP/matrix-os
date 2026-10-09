import { z } from "zod/v4";

const STORAGE_PREFIX = "matrix:onboarding-widget:v1";

const StoredPrefsSchema = z.strictObject({
  keepInCorner: z.boolean(),
  side: z.enum(["right", "left"]),
  showOnLogin: z.boolean(),
  firstTaskCompleted: z.boolean(),
  aiChoice: z.enum(["matrix", "claude", "codex"]),
  chatId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).nullable(),
});

export type OnboardingStoredPrefs = z.infer<typeof StoredPrefsSchema>;

export const DEFAULT_ONBOARDING_PREFS: OnboardingStoredPrefs = {
  keepInCorner: true,
  side: "right",
  showOnLogin: true,
  firstTaskCompleted: false,
  aiChoice: "matrix",
  chatId: null,
};

export function onboardingPrefsKey(handle: string, runtimeSlot: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(handle)}:${encodeURIComponent(runtimeSlot)}`;
}

/** Returns null when nothing usable is stored, so callers can tell a first visit apart. */
export function readOnboardingPrefs(key: string, storage: Pick<Storage, "getItem"> = localStorage): OnboardingStoredPrefs | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch (error: unknown) {
    console.warn("[onboarding-widget] prefs unavailable:", error instanceof Error ? error.name : typeof error);
    return null;
  }
  if (!raw || raw.length > 2_048) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
  const parsed = StoredPrefsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function writeOnboardingPrefs(key: string, prefs: OnboardingStoredPrefs, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(key, JSON.stringify(StoredPrefsSchema.parse(prefs)));
  } catch (error: unknown) {
    console.warn("[onboarding-widget] prefs not saved:", error instanceof Error ? error.name : typeof error);
  }
}

/** Auto-open until the first task finishes; afterwards the user's menu choices decide. */
export function onboardingLoginPresentation(prefs: OnboardingStoredPrefs): "corner" | "bubble" | "hidden" {
  if (!prefs.firstTaskCompleted) return "corner";
  if (!prefs.showOnLogin) return "hidden";
  return prefs.keepInCorner ? "corner" : "bubble";
}
