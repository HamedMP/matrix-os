"use client";

import {
  buildPostHogCookieConsentInitOptions,
  getPostHogClientConfig,
  resolvePostHogClientApiHost,
} from "@matrix-os/observability/client";

type ClientProperties = Record<string, string | number | boolean | undefined>;
type PostHogClient = typeof import("posthog-js").default;
type PostHogInitOptions = Parameters<PostHogClient["init"]>[1];

// Replay kill switch. NEXT_PUBLIC_* is inlined at build time, so the build
// flag alone needs a rebuild to change. The layout additionally exposes the
// server's runtime POSTHOG_DISABLE_REPLAY env as a data attribute, so a
// redeploy with the env set suppresses replay without code changes.
const buildTimeReplayDisabled = Boolean(process.env.NEXT_PUBLIC_POSTHOG_DISABLE_REPLAY);

function isSessionReplayDisabled(): boolean {
  if (buildTimeReplayDisabled) return true;
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.posthogDisableReplay === "1";
}

const config = getPostHogClientConfig({
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NEXT_PUBLIC_POSTHOG_API_HOST: process.env.NEXT_PUBLIC_POSTHOG_API_HOST ?? "/relay",
});
let initialized = false;
let posthogClientPromise: Promise<PostHogClient> | null = null;

function loadPostHogClient(): Promise<PostHogClient> {
  posthogClientPromise ??= import("posthog-js").then((module) => module.default);
  return posthogClientPromise;
}

export function capturePostHogException(error: unknown, properties: ClientProperties = {}) {
  if (!config) return;
  void loadPostHogClient()
    .then((posthog) => {
      ensurePostHogInitialized(posthog, config);
      posthog.captureException(error, sanitizeProperties(properties));
    })
    .catch((err: unknown) => {
      console.warn("[posthog] Failed to capture client exception:", err instanceof Error ? err.name : typeof err);
    });
}

export function capturePostHogEvent(event: string, properties: ClientProperties = {}) {
  if (!config) return;
  void loadPostHogClient()
    .then((posthog) => {
      ensurePostHogInitialized(posthog, config);
      posthog.capture(event, sanitizeProperties(properties));
    })
    .catch((err: unknown) => {
      console.warn("[posthog] Failed to capture client event:", err instanceof Error ? err.name : typeof err);
    });
}

export function identifyPostHogUser(
  distinctId: string,
  properties: ClientProperties = {},
  currentConfig: typeof config = config,
) {
  if (!currentConfig || !distinctId) return;
  void loadPostHogClient()
    .then((posthog) => {
      ensurePostHogInitialized(posthog, currentConfig);
      posthog.identify(distinctId, sanitizeProperties(properties));
    })
    .catch((err: unknown) => {
      console.warn("[posthog] Failed to identify user:", err instanceof Error ? err.name : typeof err);
    });
}

export function resetPostHogIdentity(currentConfig: typeof config = config) {
  if (!currentConfig || !initialized) return;
  void loadPostHogClient()
    .then((posthog) => {
      // Only reset provably identified sessions; resetting an anonymous session
      // would rotate its distinct id on every signed-out page load. If the
      // identity check is unavailable, skip the reset rather than risk it.
      const withIdentity = posthog as PostHogClient & { _isIdentified?: () => boolean };
      if (typeof withIdentity._isIdentified !== "function" || !withIdentity._isIdentified()) return;
      posthog.reset();
    })
    .catch((err: unknown) => {
      console.warn("[posthog] Failed to reset identity:", err instanceof Error ? err.name : typeof err);
    });
}

function ensurePostHogInitialized(posthog: PostHogClient, currentConfig: NonNullable<typeof config>) {
  initializeLoadedPostHog(posthog, getPostHogVisitorCountry(), currentConfig);
}

export function initializeWwwPostHog(
  visitorCountry?: string | null,
  currentConfig: typeof config = config,
) {
  if (!currentConfig || initialized) return Promise.resolve();
  return loadPostHogClient()
    .then((posthog) => initializeLoadedPostHog(posthog, visitorCountry, currentConfig))
    .catch((err: unknown) => {
      console.warn("[posthog] Failed to initialize client:", err instanceof Error ? err.name : typeof err);
    });
}

function initializeLoadedPostHog(
  posthog: PostHogClient,
  visitorCountry?: string | null,
  currentConfig: typeof config = config,
) {
  if (!currentConfig || initialized) return;
  const apiHost = resolvePostHogClientApiHost(currentConfig, { allowRelativeApiHost: true });
  posthog.init(currentConfig.token, {
    ...(apiHost ? { api_host: apiHost } : {}),
    ui_host: currentConfig.uiHost,
    defaults: "2026-01-30",
    autocapture: false,
    capture_pageview: "history_change",
    capture_exceptions: true,
    // Masked session replay: every input is masked by default so signup and
    // billing failures can be replayed without capturing what users typed.
    disable_session_recording: isSessionReplayDisabled(),
    session_recording: {
      maskAllInputs: true,
    },
    enable_recording_console_log: true,
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
