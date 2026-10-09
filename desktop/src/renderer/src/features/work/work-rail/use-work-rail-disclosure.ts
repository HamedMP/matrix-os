import { useState } from "react";
import { useConnection } from "../../../stores/connection";

export const DEFAULT_RAIL_DISCLOSURE = { agents: true, pinned: true, projects: true, needsYou: true, working: true, done: true };
export type RailDisclosureKey = keyof typeof DEFAULT_RAIL_DISCLOSURE;
type Disclosure = Record<RailDisclosureKey, boolean>;
type StoredDisclosure = { identity: string; sections: Disclosure; unsaved: Partial<Disclosure> };

function readDisclosure(scope: string | null, fallback: Disclosure = DEFAULT_RAIL_DISCLOSURE): Disclosure {
  if (!scope) return { ...fallback };
  try {
    const raw = window.localStorage.getItem(scope);
    const parsed: unknown = raw && raw.length <= 512 ? JSON.parse(raw) : null;
    const result = { ...fallback };
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const key of Object.keys(result) as RailDisclosureKey[]) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === "boolean") result[key] = value;
      }
    }
    return result;
  } catch (error: unknown) {
    console.warn("[work] Rail disclosure unavailable:", error instanceof Error ? error.name : "UnknownError");
    return { ...fallback };
  }
}

/** Presentation preferences use the same trusted viewer/Computer scope as rail order. */
export function useWorkRailDisclosure() {
  const userId = useConnection(state => state.userId);
  const host = useConnection(state => state.platformHost);
  const slot = useConnection(state => state.runtimeSlot);
  const generation = useConnection(state => state.authGeneration);
  const signedIn = useConnection(state => state.status === "signed-in");
  const scope = signedIn && userId ? `matrix-chat-rail-disclosure:${JSON.stringify([host, userId, slot])}` : null;
  const identity = JSON.stringify([scope, generation]);
  const [stored, setStored] = useState<StoredDisclosure>(() => ({ identity, sections: readDisclosure(scope), unsaved: {} }));
  // Like rail order, reset synchronously before painting a new viewer's preferences.
  let current = stored;
  if (stored.identity !== identity) {
    current = { identity, sections: readDisclosure(scope), unsaved: {} };
    setStored(current);
  }
  const setExpanded = (key: RailDisclosureKey, expanded: boolean) => {
    const live = useConnection.getState();
    if (live.userId !== userId || live.platformHost !== host || live.runtimeSlot !== slot
      || live.authGeneration !== generation || (live.status === "signed-in") !== signedIn) return;
    // Retained rails share this scope; preserve their newer saved choices before changing one key.
    const pending = { ...current.unsaved, [key]: expanded };
    const next = { ...readDisclosure(scope, current.sections), ...pending };
    let unsaved: Partial<Disclosure> = scope ? pending : {};
    if (scope) {
      try { window.localStorage.setItem(scope, JSON.stringify(next)); unsaved = {}; }
      catch (error: unknown) { console.warn("[work] Rail disclosure save failed:", error instanceof Error ? error.name : "UnknownError"); }
    }
    // Readable storage may still contain old choices after a failed write.
    // Retain only unsaved keys until persisted or the authenticated scope resets.
    setStored({ identity, sections: next, unsaved });
  };
  return { sections: current.sections, setExpanded };
}
