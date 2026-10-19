import { ONBOARDING_FREEFORM_MAX_CHARS, ONBOARDING_TASK_IDS, type OnboardingWidgetInit } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { DEFAULT_ONBOARDING_POSITION, ONBOARDING_POSITION_MAX, onboardingCornerPosition } from "../position.js";

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

const PositionOffsetSchema = z.number().int().min(0).max(ONBOARDING_POSITION_MAX);

/** Prefs saved before the widget could move freely held only `side`; read that as its bottom corner. */
function withLegacySide(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value) || "position" in value) return value;
  const { side, ...rest } = value as Record<string, unknown>;
  return side === "left" || side === "right" ? { ...rest, position: onboardingCornerPosition(side) } : value;
}

const StoredPrefsSchema = z.preprocess(withLegacySide, z.strictObject({
  keepInCorner: z.boolean(),
  position: z.strictObject({
    x: z.enum(["left", "right"]),
    y: z.enum(["top", "bottom"]),
    dx: PositionOffsetSchema,
    dy: PositionOffsetSchema,
  }),
  showOnLogin: z.boolean(),
  firstTaskCompleted: z.boolean(),
  aiChoice: z.enum(["matrix", "claude", "codex"]),
  chatId: z.string().min(1).max(128).regex(SAFE_ID).nullable(),
  pendingRun: PendingRunSchema.nullable().default(null),
}));

export type OnboardingStoredPrefs = z.infer<typeof StoredPrefsSchema>;

export const DEFAULT_ONBOARDING_PREFS: OnboardingStoredPrefs = {
  keepInCorner: false,
  position: DEFAULT_ONBOARDING_POSITION,
  showOnLogin: true,
  firstTaskCompleted: false,
  aiChoice: "matrix",
  chatId: null,
  pendingRun: null,
};

/** Pass the signed-in account wherever one browser profile can hold several accounts' prefs. */
export function onboardingPrefsKey(handle: string, runtimeSlot: string, account?: string): string {
  const scope = `${encodeURIComponent(handle)}:${encodeURIComponent(runtimeSlot)}`;
  return account === undefined ? `${STORAGE_PREFIX}:${scope}` : `${STORAGE_PREFIX}:${encodeURIComponent(account)}:${scope}`;
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
