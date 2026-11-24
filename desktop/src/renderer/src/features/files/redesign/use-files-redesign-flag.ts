import { useSyncExternalStore } from "react";
import { FEATURE_FLAG_TIMEOUT_MS, type FeatureFlagSource } from "@matrix-os/ui/feature-flags";
import { createDesktopFeatureFlagSource } from "../../support/desktop-feature-flags";

/** PostHog flag that switches Electron Desktop Files to the redesigned UI (spec 2711). */
export const FILES_REDESIGN_FLAG = "desktop-files-redesign";

// Bound on components reading the flag at once (each open Files tab and its frame).
const MAX_FLAG_CONSUMERS = 128;

export interface SharedFlag {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => boolean | null;
}

/**
 * One PostHog subscription shared by every consumer. The desktop flag source
 * keeps only a few subscriptions and evicts the oldest, so per-component
 * subscriptions would silently stop updating once many tabs are open. The
 * value is null until PostHog answers and false if it has not answered after
 * `timeoutMs`. The subscription lives for the renderer's lifetime.
 */
export function createSharedFlag(source: FeatureFlagSource, key: string, timeoutMs = FEATURE_FLAG_TIMEOUT_MS): SharedFlag {
  let value: boolean | null = null;
  let started = false;
  const consumers = new Set<() => void>();
  const set = (next: boolean) => {
    if (value === next) return;
    value = next;
    for (const consumer of consumers) consumer();
  };
  const start = () => {
    if (started) return;
    started = true;
    const timer = setTimeout(() => { if (value === null) set(false); }, timeoutMs);
    source.subscribe(key, (enabled) => {
      clearTimeout(timer);
      set(enabled === true);
    });
  };
  return {
    subscribe(onChange) {
      if (consumers.size >= MAX_FLAG_CONSUMERS) {
        console.warn("[files] Too many Files flag readers; a reader will not see updates.");
        return () => undefined;
      }
      consumers.add(onChange);
      start();
      return () => { consumers.delete(onChange); };
    },
    getSnapshot: () => value,
  };
}

const source = createDesktopFeatureFlagSource();
const sharedFlag = source ? createSharedFlag(source, FILES_REDESIGN_FLAG) : null;
// Local opt-in for development builds, which usually have no PostHog project.
const devOptIn = import.meta.env.VITE_DESKTOP_FILES_REDESIGN === "1";
const noSource: SharedFlag = { subscribe: () => () => undefined, getSnapshot: () => null };

/**
 * The redesign is unfinished, so it is off unless PostHog turns the flag on or
 * a build sets VITE_DESKTOP_FILES_REDESIGN=1. Builds without PostHog
 * (self-hosted, CI) keep the current Files layout. null while PostHog loads.
 */
export function resolveFilesRedesign({ flag, hasSource, devOptIn: optIn }: { flag: boolean | null; hasSource: boolean; devOptIn: boolean }): boolean | null {
  if (optIn) return true;
  if (!hasSource) return false;
  return flag;
}

export function useFilesRedesignFlag(): boolean | null {
  const store = sharedFlag ?? noSource;
  const flag = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return resolveFilesRedesign({ flag, hasSource: sharedFlag !== null, devOptIn });
}
