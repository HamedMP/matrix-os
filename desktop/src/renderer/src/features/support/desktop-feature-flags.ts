import posthog from "posthog-js/dist/module.no-external";
import { subscribePostHogFlag, type FeatureFlagListener, type FeatureFlagSource } from "@matrix-os/ui/feature-flags";

/** Gates mounted before PostHog starts; oldest dropped first, and a dropped gate falls back to its timeout. */
export const MAX_PENDING_FLAG_LISTENERS = 8;

let ready = false;
const pending = new Set<() => void>();

/**
 * DesktopSupportWidget starts PostHog once a computer is signed in, usually after the Get started
 * gate has mounted. A listener added before `init` only ever hears a load error, so subscriptions
 * wait here until the widget reports PostHog is up.
 */
export function markDesktopFeatureFlagsReady(): void {
  ready = true;
  const starts = [...pending];
  pending.clear();
  for (const start of starts) start();
}

function subscribe(key: string, listener: FeatureFlagListener): () => void {
  let closed = false;
  let stop: (() => void) | null = null;
  const start = () => {
    pending.delete(start);
    if (!closed) stop = subscribePostHogFlag(posthog, key, listener);
  };
  if (ready) {
    start();
  } else {
    if (pending.size >= MAX_PENDING_FLAG_LISTENERS) {
      const oldest = pending.values().next().value;
      if (oldest) pending.delete(oldest);
    }
    pending.add(start);
  }
  return () => {
    closed = true;
    pending.delete(start);
    stop?.();
  };
}

/** Electron Desktop's PostHog flags; undefined in builds without a PostHog project, where the gateway decides. */
export function createDesktopFeatureFlagSource(): FeatureFlagSource | undefined {
  if (!import.meta.env.VITE_POSTHOG_PROJECT_TOKEN?.trim()) return undefined;
  return { subscribe };
}
