/**
 * Durable Aoede presentation preferences: persisted turn mode and input/output
 * device selections. Mirrors the bounded, schema-validated localStorage
 * pattern used for the canonical chat provider selection — never throws,
 * never trusts stored shape, tolerates absent storage (SSR/jsdom).
 */
import { z } from "zod/v4";

export const AOEDE_PREFERENCES_STORAGE_KEY = "matrix:aoede-preferences";

/** Stored bytes are capped before parse so hostile entries cannot bloat reads. */
const MAX_PREFERENCE_BYTES = 4_096;

const AoedePreferencesSchema = z.object({
  turnMode: z.enum(["hands_free", "push_to_talk"]).optional(),
  inputDeviceId: z.string().max(256).optional().nullable(),
  outputDeviceId: z.string().max(256).optional().nullable(),
}).strict();

export interface AoedePreferences {
  turnMode?: "hands_free" | "push_to_talk";
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
