import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Remembers that a user's computer was last seen ready, so the next launch can
 * open the shell straight away and confirm with the platform in the
 * background instead of holding the whole app behind that request.
 *
 * This is a hint about where to land, not an entitlement: the platform checks
 * machine access and billing on every request the shell goes on to make.
 */

interface JourneyCacheStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const STORAGE_KEY = "matrix_os_journey_ready_v1";
// Someone away for longer than this can wait for a fresh answer.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function failureName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/** True when `userId` reached a connectable phase recently enough to trust for one launch. */
export async function wasJourneyConnectable(
  userId: string,
  storage: JourneyCacheStorage = AsyncStorage,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const raw = await storage.getItem(STORAGE_KEY);
    if (raw === null) return false;
    const saved = JSON.parse(raw) as { userId?: unknown; savedAt?: unknown };
    return saved.userId === userId
      && typeof saved.savedAt === "number"
      && now - saved.savedAt <= MAX_AGE_MS;
  } catch (error: unknown) {
    console.warn("[mobile] remembered journey unavailable", failureName(error));
    return false;
  }
}

export async function rememberJourneyConnectable(
  userId: string,
  storage: JourneyCacheStorage = AsyncStorage,
  now: number = Date.now(),
): Promise<void> {
  try {
    await storage.setItem(STORAGE_KEY, JSON.stringify({ userId, savedAt: now }));
  } catch (error: unknown) {
    console.warn("[mobile] journey could not be remembered", failureName(error));
  }
}

/** Forgets the remembered answer: `userId`'s only, or whoever's it is when null (signed out). */
export async function forgetJourneyConnectable(
  userId: string | null = null,
  storage: JourneyCacheStorage = AsyncStorage,
): Promise<void> {
  try {
    if (userId !== null) {
      const raw = await storage.getItem(STORAGE_KEY);
      if (raw === null || (JSON.parse(raw) as { userId?: unknown }).userId !== userId) return;
    }
    await storage.removeItem(STORAGE_KEY);
  } catch (error: unknown) {
    console.warn("[mobile] remembered journey could not be cleared", failureName(error));
  }
}
