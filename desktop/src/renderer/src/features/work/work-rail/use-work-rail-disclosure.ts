import { useState } from "react";
import { useConnection } from "../../../stores/connection";

export const DEFAULT_RAIL_DISCLOSURE = { agents: true, pinned: true, projects: true, needsYou: true, working: true, done: true };
export type RailDisclosureKey = keyof typeof DEFAULT_RAIL_DISCLOSURE;
type Disclosure = Record<RailDisclosureKey, boolean>;

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
  const [stored, setStored] = useState(() => ({ identity, sections: readDisclosure(scope) }));
  // Like rail order, reset synchronously before painting a new viewer's preferences.
  let current = stored;
  if (stored.identity !== identity) {
    current = { identity, sections: readDisclosure(scope) };
    setStored(current);
  }
  const setExpanded = (key: RailDisclosureKey, expanded: boolean) => {
    const live = useConnection.getState();
    if (live.userId !== userId || live.platformHost !== host || live.runtimeSlot !== slot
      || live.authGeneration !== generation || (live.status === "signed-in") !== signedIn) return;
    // Retained rails share this scope; preserve their newer saved choices before changing one key.
    const next = { ...readDisclosure(scope, current.sections), [key]: expanded };
    setStored({ identity, sections: next });
    if (!scope) return;
    try { window.localStorage.setItem(scope, JSON.stringify(next)); }
    catch (error: unknown) { console.warn("[work] Rail disclosure save failed:", error instanceof Error ? error.name : "UnknownError"); }
  };
  return { sections: current.sections, setExpanded };
}
