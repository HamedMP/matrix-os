import { useEffect, useState } from "react";

/** How long a gate waits for PostHog before treating its flag as off. */
export const FEATURE_FLAG_TIMEOUT_MS = 4_000;

/** `enabled` is undefined when PostHog could not load flags. */
export type FeatureFlagListener = (enabled: boolean | undefined) => void;

/** A surface's PostHog client, narrowed to what a rollout gate reads. */
export interface FeatureFlagSource {
  /** Calls back once flags load and on every later change. Returns an unsubscribe. */
  subscribe(key: string, listener: FeatureFlagListener): () => void;
}

/** The part of posthog-js the subscription uses, so Web and Electron can pass their own builds. */
export interface PostHogFlagClient {
  onFeatureFlags(callback: (flags: string[], variants: Record<string, string | boolean>, context?: { errorsLoading?: boolean }) => void): () => void;
  isFeatureEnabled(key: string): boolean | undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Reports one flag from an initialized PostHog client. A flag missing from the project reads as off. */
export function subscribePostHogFlag(client: PostHogFlagClient, key: string, listener: FeatureFlagListener): () => void {
  try {
    return client.onFeatureFlags((_flags, _variants, context) => {
      listener(context?.errorsLoading ? undefined : client.isFeatureEnabled(key) === true);
    });
  } catch (error: unknown) {
    console.warn("[feature-flags] PostHog flags unavailable:", errorName(error));
    listener(undefined);
    return () => undefined;
  }
}

/**
 * Whether a rollout flag is on: null while PostHog loads, then false if it fails or takes longer
 * than `timeoutMs`. Once on it stays on for this mount, so a flag change never closes an open
 * surface. With no source (self-hosted, local dev, a build without PostHog) it is on, and the
 * server's own gate decides.
 */
export function useFeatureFlag(source: FeatureFlagSource | undefined, key: string, timeoutMs = FEATURE_FLAG_TIMEOUT_MS): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!source) return;
    const timer = setTimeout(() => setEnabled((current) => current ?? false), timeoutMs);
    const unsubscribe = source.subscribe(key, (next) => {
      clearTimeout(timer);
      setEnabled((current) => current === true || next === true);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [source, key, timeoutMs]);

  return source ? enabled : true;
}
