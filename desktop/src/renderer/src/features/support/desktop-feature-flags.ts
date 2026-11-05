import posthog from "posthog-js/dist/module.no-external";
import { subscribePostHogFlag, type FeatureFlagListener, type FeatureFlagSource, type PostHogFlagClient } from "@matrix-os/ui/feature-flags";

/** Bound mounted gates across client replacement; evict the oldest subscription first. */
export const MAX_PENDING_FLAG_LISTENERS = 8;

let activeClient: PostHogFlagClient | null = null;
type Subscription = { start(): void; stop(): void };
const subscriptions = new Set<Subscription>();

/**
 * Support owns the live client. Gates wait for initialization and rebind when account or relay
 * changes replace that client. Passing null detaches callbacks while Support is signed out.
 */
export function markDesktopFeatureFlagsReady(client: PostHogFlagClient | null = posthog): void {
  if (activeClient === client) return;
  activeClient = client;
  for (const subscription of subscriptions) {
    subscription.stop();
    subscription.start();
  }
}

function subscribe(key: string, listener: FeatureFlagListener): () => void {
  let closed = false;
  let stop: (() => void) | null = null;
  let generation = 0;
  const subscription: Subscription = {
    start() {
      const client = activeClient;
      if (closed || !client) return;
      const current = generation;
      stop = subscribePostHogFlag(client, key, enabled => {
        if (!closed && current === generation && client === activeClient) listener(enabled);
      });
    },
    stop() {
      generation += 1;
      stop?.();
      stop = null;
    },
  };
  if (subscriptions.size >= MAX_PENDING_FLAG_LISTENERS) {
    const oldest = subscriptions.values().next().value;
    if (oldest) {
      oldest.stop();
      subscriptions.delete(oldest);
    }
  }
  subscriptions.add(subscription);
  subscription.start();
  return () => {
    closed = true;
    subscriptions.delete(subscription);
    subscription.stop();
  };
}

/** Electron Desktop's PostHog flags; undefined in builds without a PostHog project, where the gateway decides. */
export function createDesktopFeatureFlagSource(): FeatureFlagSource | undefined {
  if (!import.meta.env.VITE_POSTHOG_PROJECT_TOKEN?.trim()) return undefined;
  return { subscribe };
}
