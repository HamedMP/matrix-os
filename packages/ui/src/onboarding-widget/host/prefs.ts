import { ONBOARDING_FREEFORM_MAX_CHARS, ONBOARDING_TASK_IDS, type OnboardingWidgetInit } from "@matrix-os/contracts";
import { z } from "zod/v4";

const STORAGE_PREFIX = "matrix:onboarding-widget:v1";
const MAX_STORED_CHARS = 8_192;
const MAX_TITLE_CHARS = 200;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

const PendingRunSchema = z.strictObject({
  taskId: z.enum([...ONBOARDING_TASK_IDS, "custom"]),
  answer: z.string().max(ONBOARDING_FREEFORM_MAX_CHARS),
  appConnected: z.boolean(),
  simpler: z.boolean(),
  context: z.string().max(400).optional(),
  // Follow-ups keep their result's title, which can be a whole research topic; shorten it rather than drop the save.
  title: z.string().transform((title) => (title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title)).optional(),
  runId: z.string().min(1).max(128).regex(SAFE_ID),
});

const StoredPrefsSchema = z.strictObject({
  keepInCorner: z.boolean(),
  side: z.enum(["right", "left"]),
  showOnLogin: z.boolean(),
  firstTaskCompleted: z.boolean(),
  aiChoice: z.enum(["matrix", "claude", "codex"]),
  chatId: z.string().min(1).max(128).regex(SAFE_ID).nullable(),
  pendingRun: PendingRunSchema.nullable().default(null),
});

export type OnboardingStoredPrefs = z.infer<typeof StoredPrefsSchema>;

export const DEFAULT_ONBOARDING_PREFS: OnboardingStoredPrefs = {
  keepInCorner: false,
  side: "right",
  showOnLogin: true,
  firstTaskCompleted: false,
  aiChoice: "matrix",
  chatId: null,
  pendingRun: null,
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
  if (!raw || raw.length > MAX_STORED_CHARS) return null;
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

/** Auto-open until the first task finishes; afterwards "Show on every login" decides. */
export function onboardingLoginPresentation(prefs: OnboardingStoredPrefs): "corner" | "bubble" {
  if (!prefs.firstTaskCompleted) return "corner";
  return prefs.showOnLogin ? "corner" : "bubble";
}

export function onboardingSessionInit(prefs: OnboardingStoredPrefs): OnboardingWidgetInit {
  return {
    size: onboardingLoginPresentation(prefs),
    firstTaskCompleted: prefs.firstTaskCompleted,
    aiChoice: prefs.aiChoice,
    chatId: prefs.chatId,
    pendingRun: prefs.pendingRun,
  };
}
