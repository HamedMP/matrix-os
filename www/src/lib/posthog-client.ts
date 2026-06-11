"use client";

import posthog from "posthog-js";
import {
  buildPostHogCookieConsentInitOptions,
  getPostHogClientConfig,
  resolvePostHogClientApiHost,
} from "@matrix-os/observability/client";

type ClientProperties = Record<string, string | number | boolean | undefined>;
type PostHogInitOptions = Parameters<typeof posthog.init>[1];

const config = getPostHogClientConfig({
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NEXT_PUBLIC_POSTHOG_API_HOST: process.env.NEXT_PUBLIC_POSTHOG_API_HOST ?? "/relay",
});
let initialized = false;

export function capturePostHogException(error: unknown, properties: ClientProperties = {}) {
  if (!config) return;
  try {
    ensurePostHogInitialized(config);
    posthog.captureException(error, sanitizeProperties(properties));
  } catch (err: unknown) {
    console.warn("[posthog] Failed to capture client exception:", err instanceof Error ? err.name : typeof err);
  }
}

export function capturePostHogEvent(event: string, properties: ClientProperties = {}) {
  if (!config) return;
  try {
    ensurePostHogInitialized(config);
    posthog.capture(event, sanitizeProperties(properties));
  } catch (err: unknown) {
    console.warn("[posthog] Failed to capture client event:", err instanceof Error ? err.name : typeof err);
  }
}

export function identifyPostHogUser(
  distinctId: string,
  properties: ClientProperties = {},
  currentConfig: typeof config = config,
) {
  if (!currentConfig || !distinctId) return;
  try {
    ensurePostHogInitialized(currentConfig);
    posthog.identify(distinctId, sanitizeProperties(properties));
  } catch (err: unknown) {
    console.warn("[posthog] Failed to identify user:", err instanceof Error ? err.name : typeof err);
  }
}

export function resetPostHogIdentity(currentConfig: typeof config = config) {
  if (!currentConfig || !initialized) return;
  try {
    // Only reset identified sessions; resetting an anonymous session would
    // rotate its distinct id on every signed-out page load.
    const withIdentity = posthog as typeof posthog & { _isIdentified?: () => boolean };
    if (typeof withIdentity._isIdentified === "function" && !withIdentity._isIdentified()) return;
    posthog.reset();
  } catch (err: unknown) {
    console.warn("[posthog] Failed to reset identity:", err instanceof Error ? err.name : typeof err);
  }
}

function ensurePostHogInitialized(currentConfig: NonNullable<typeof config>) {
  initializeWwwPostHog(getPostHogVisitorCountry(), currentConfig);
}

export function initializeWwwPostHog(
  visitorCountry?: string | null,
  currentConfig: typeof config = config,
) {
  if (!currentConfig || initialized) return;
  const apiHost = resolvePostHogClientApiHost(currentConfig, { allowRelativeApiHost: true });
  posthog.init(currentConfig.token, {
    ...(apiHost ? { api_host: apiHost } : {}),
    ui_host: currentConfig.uiHost,
    defaults: "2026-01-30",
    capture_exceptions: true,
    debug: process.env.NODE_ENV === "development",
    ...buildPostHogCookieConsentInitOptions(visitorCountry),
  } as PostHogInitOptions);
  initialized = true;
}

function getPostHogVisitorCountry(): string | null {
  if (typeof document === "undefined") return null;
  return document.documentElement.dataset.posthogVisitorCountry ?? null;
}

function sanitizeProperties(properties: ClientProperties): Record<string, string | number | boolean> {
  const sanitized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    sanitized[key] = typeof value === "string" ? value.slice(0, 512) : value;
  }
  return sanitized;
}
