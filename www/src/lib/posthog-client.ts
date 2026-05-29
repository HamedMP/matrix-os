"use client";

import posthog from "posthog-js";
import {
  getPostHogClientConfig,
  resolvePostHogClientApiHost,
} from "@matrix-os/observability/client";

type ClientProperties = Record<string, string | number | boolean | undefined>;
type PostHogInitOptions = Parameters<typeof posthog.init>[1];

const config = getPostHogClientConfig({
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NEXT_PUBLIC_POSTHOG_API_HOST: process.env.NEXT_PUBLIC_POSTHOG_API_HOST ?? "/ingest",
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

function ensurePostHogInitialized(currentConfig: NonNullable<typeof config>) {
  if (initialized) return;
  const apiHost = resolvePostHogClientApiHost(currentConfig, { allowRelativeApiHost: true });
  posthog.init(currentConfig.token, {
    ...(apiHost ? { api_host: apiHost } : {}),
    ui_host: currentConfig.uiHost,
    defaults: "2026-01-30",
    capture_exceptions: true,
    debug: process.env.NODE_ENV === "development",
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
