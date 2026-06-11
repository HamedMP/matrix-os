"use client";

import posthog from "posthog-js";
import {
  buildPostHogCookieConsentInitOptions,
  getPostHogClientConfig,
  resolvePostHogClientApiHost,
} from "@matrix-os/observability/client";

type ClientProperties = Record<string, string | number | boolean | undefined>;
type PostHogInitOptions = Parameters<typeof posthog.init>[1];
type PostHogLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
type PostHogWithLogger = typeof posthog & {
  logger?: Partial<Record<PostHogLogLevel, (message: string, properties?: Record<string, string | number | boolean>) => void>>;
};

const config = getPostHogClientConfig({
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NEXT_PUBLIC_POSTHOG_API_HOST: process.env.NEXT_PUBLIC_POSTHOG_API_HOST,
});
const CLIENT_ERROR_REPORT_TIMEOUT_MS = 10_000;
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

export function reportClientError(error: unknown, properties: ClientProperties = {}) {
  if (typeof window === "undefined") return;

  try {
    const payload = {
      errorId: typeof properties.errorId === "string" ? properties.errorId : undefined,
      source: typeof properties.source === "string" ? properties.source : undefined,
      digest: typeof properties.digest === "string" ? properties.digest : undefined,
      name: error instanceof Error ? error.name : typeof error,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      stack: error instanceof Error ? error.stack?.slice(0, 4_000) : undefined,
      path: `${window.location.pathname}${window.location.search}`.slice(0, 512),
      userAgent: window.navigator.userAgent.slice(0, 512),
      buildSha: process.env.NEXT_PUBLIC_MATRIX_BUILD_SHA,
    };

    if (!payload.errorId) return;

    void fetch("/api/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      signal: AbortSignal.timeout(CLIENT_ERROR_REPORT_TIMEOUT_MS),
      body: JSON.stringify(payload),
    }).catch((err: unknown) => {
      console.warn("[client-error-log] Failed to report client error:", err instanceof Error ? err.name : typeof err);
    });
  } catch (err: unknown) {
    console.warn("[client-error-log] Failed to prepare client error report:", err instanceof Error ? err.name : typeof err);
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

export function capturePostHogLog(
  level: PostHogLogLevel,
  message: string,
  properties: ClientProperties = {},
) {
  if (!config) return;
  try {
    ensurePostHogInitialized(config);
    const sanitized = sanitizeProperties(properties);
    const logger = (posthog as PostHogWithLogger).logger?.[level];
    if (logger) {
      logger(message.slice(0, 240), sanitized);
      return;
    }
    posthog.capture("shell_log", {
      ...sanitized,
      level,
      message: message.slice(0, 240),
    });
  } catch (err: unknown) {
    console.warn("[posthog] Failed to capture client log:", err instanceof Error ? err.name : typeof err);
  }
}

function ensurePostHogInitialized(currentConfig: NonNullable<typeof config>) {
  initializeShellPostHog(getPostHogVisitorCountry(), currentConfig);
}

export function initializeShellPostHog(
  visitorCountry?: string | null,
  currentConfig: typeof config = config,
) {
  if (!currentConfig || initialized) return;
  const apiHost = resolvePostHogClientApiHost(currentConfig, { allowRelativeApiHost: false });
  posthog.init(currentConfig.token, {
    // Shell has no local PostHog /ingest proxy, so an unset api_host lets
    // posthog-js use its default endpoint.
    ...(apiHost ? { api_host: apiHost } : {}),
    ui_host: currentConfig.uiHost,
    defaults: "2026-01-30",
    capture_exceptions: true,
    capture_dead_clicks: false,
    rageclick: false,
    disable_session_recording: true,
    debug: process.env.NODE_ENV === "development",
    logs: {
      captureConsoleLogs: false,
      serviceName: "matrix-shell",
      environment: process.env.NODE_ENV,
      serviceVersion: process.env.NEXT_PUBLIC_MATRIX_BUILD_SHA,
    },
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
