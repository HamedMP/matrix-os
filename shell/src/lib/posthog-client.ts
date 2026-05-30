"use client";

import posthog from "posthog-js";
import {
  getPostHogClientConfig,
  resolvePostHogClientApiHost,
} from "@matrix-os/observability/client";

type ClientProperties = Record<string, string | number | boolean | undefined>;
type PostHogInitOptions = Parameters<typeof posthog.init>[1];
type PostHogLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
type PostHogWithLogger = typeof posthog & {
  logger?: Partial<Record<PostHogLogLevel, (message: string, properties?: Record<string, string | number | boolean>) => void>>;
};
type PostHogLoadState = typeof posthog & { __loaded?: boolean };

const config = getPostHogClientConfig({
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NEXT_PUBLIC_POSTHOG_API_HOST: process.env.NEXT_PUBLIC_POSTHOG_API_HOST,
});
let initialized = false;
const posthogClient = posthog as PostHogLoadState;

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
  if (initialized || posthogClient.__loaded) {
    initialized = true;
    return;
  }
  const apiHost = resolvePostHogClientApiHost(currentConfig, { allowRelativeApiHost: false });
  posthog.init(currentConfig.token, {
    ...(apiHost ? { api_host: apiHost } : {}),
    ui_host: currentConfig.uiHost,
    defaults: "2026-01-30",
    capture_exceptions: true,
    debug: process.env.NODE_ENV === "development",
    logs: {
      captureConsoleLogs: false,
      serviceName: "matrix-shell",
      environment: process.env.NODE_ENV,
      serviceVersion: process.env.NEXT_PUBLIC_MATRIX_BUILD_SHA,
    },
  } as PostHogInitOptions);
  initialized = true;
}

function sanitizeProperties(properties: ClientProperties): Record<string, string | number | boolean> {
  const sanitized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    sanitized[key] = typeof value === "string" ? value.slice(0, 512) : value;
  }
  return sanitized;
}
