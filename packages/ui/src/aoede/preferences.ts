/**
 * Durable Aoede presentation preferences: turn mode, spoken language and
 * device selections. Mirrors the bounded, schema-validated localStorage
 * pattern used for the canonical chat provider selection — never throws,
 * never trusts stored shape, tolerates absent storage (SSR/jsdom).
 */
import { z } from "zod/v4";

export const AOEDE_PREFERENCES_STORAGE_KEY = "matrix:aoede-preferences";

export const AOEDE_SPEECH_LANGUAGES = [
  { code: "auto", label: "Automatic" },
  { code: "en", label: "English" },
  { code: "ar", label: "Arabic" },
  { code: "zh", label: "Chinese" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "hi", label: "Hindi" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "pt", label: "Portuguese" },
  { code: "es", label: "Spanish" },
  { code: "ur", label: "Urdu" },
] as const;
export const AoedeSpeechLanguageSchema = z.enum(AOEDE_SPEECH_LANGUAGES.map(language => language.code));
export type AoedeSpeechLanguage = z.infer<typeof AoedeSpeechLanguageSchema>;

/** Stored bytes are capped before parse so hostile entries cannot bloat reads. */
const MAX_PREFERENCE_BYTES = 4_096;

const AoedePreferencesSchema = z.object({
  turnMode: z.enum(["hands_free", "push_to_talk"]).optional(),
  preferredLanguage: AoedeSpeechLanguageSchema.optional(),
  inputDeviceId: z.string().max(256).optional().nullable(),
  outputDeviceId: z.string().max(256).optional().nullable(),
}).strict();

export interface AoedePreferences {
  turnMode?: "hands_free" | "push_to_talk";
  /** Expected input language; Automatic deliberately omits the provider hint. */
  preferredLanguage?: AoedeSpeechLanguage;
  /** Explicit capture device; `null` records a deliberate "System default". */
  inputDeviceId?: string | null;
  /** Explicit playback device; `null` records a deliberate "System default". */
  outputDeviceId?: string | null;
}

function localStore(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch (error: unknown) {
    console.warn("[aoede] preferences storage unavailable", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export function loadAoedePreferences(): AoedePreferences {
  const store = localStore();
  if (!store) return {};
  try {
    const raw = store.getItem(AOEDE_PREFERENCES_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PREFERENCE_BYTES) return {};
    const parsed = AoedePreferencesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch (error: unknown) {
    console.warn("[aoede] preferences ignored", error instanceof Error ? error.name : "UnknownError");
    return {};
  }
}

export function saveAoedePreferences(preferences: AoedePreferences): void {
  const store = localStore();
  if (!store) return;
  try {
    // Normalize first: only declared keys with valid shapes may persist.
    const normalized = AoedePreferencesSchema.parse({
      ...(preferences.turnMode === undefined ? {} : { turnMode: preferences.turnMode }),
      ...(preferences.preferredLanguage === undefined ? {} : { preferredLanguage: preferences.preferredLanguage }),
      ...(preferences.inputDeviceId === undefined ? {} : { inputDeviceId: preferences.inputDeviceId }),
      ...(preferences.outputDeviceId === undefined ? {} : { outputDeviceId: preferences.outputDeviceId }),
    });
    const json = JSON.stringify(normalized);
    if (json.length > MAX_PREFERENCE_BYTES) return;
    store.setItem(AOEDE_PREFERENCES_STORAGE_KEY, json);
  } catch (error: unknown) {
    console.warn("[aoede] preferences could not persist", error instanceof Error ? error.name : "UnknownError");
  }
}
