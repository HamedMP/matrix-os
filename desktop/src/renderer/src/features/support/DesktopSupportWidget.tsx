import "posthog-js/dist/conversations";
import posthog from "posthog-js/dist/module.no-external";
import { useEffect } from "react";
import { useConnection } from "../../stores/connection";

type PostHogInitOptions = Parameters<typeof posthog.init>[1];

let initialized = false;
let activeIdentity: string | null = null;

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function configuredToken(): string | null {
  const token = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN?.trim();
  return token || null;
}

function configuredUiHost(): string {
  return import.meta.env.VITE_POSTHOG_HOST?.trim() || "https://eu.posthog.com";
}

function relayUrl(platformHost: string): string | null {
  try {
    const platformUrl = new URL(platformHost);
    if (platformUrl.protocol !== "https:" && platformUrl.protocol !== "http:") return null;
    return new URL("/relay", platformUrl.origin).toString().replace(/\/$/, "");
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function hideAndResetSupport(): void {
  if (!initialized || activeIdentity === null) return;
  try {
    posthog.conversations.hide();
  } catch (error: unknown) {
    console.warn("[desktop-support] Failed to hide PostHog widget:", errorKind(error));
  }
  try {
    posthog.reset();
  } catch (error: unknown) {
    console.warn("[desktop-support] Failed to reset PostHog identity:", errorKind(error));
  }
  activeIdentity = null;
}

export default function DesktopSupportWidget() {
  const status = useConnection((state) => state.status);
  const handle = useConnection((state) => state.handle);
  const displayName = useConnection((state) => state.displayName);
  const platformHost = useConnection((state) => state.platformHost);
  const authGeneration = useConnection((state) => state.authGeneration);

  useEffect(() => {
    const token = configuredToken();
    const apiHost = relayUrl(platformHost);
    if (!token || status !== "signed-in" || !handle || !apiHost) {
      hideAndResetSupport();
      return;
    }

    if (!initialized) {
      try {
        posthog.init(token, {
          api_host: apiHost,
          ui_host: configuredUiHost(),
          defaults: "2026-01-30",
          autocapture: false,
          capture_dead_clicks: false,
          capture_exceptions: false,
          capture_heatmaps: false,
          capture_pageleave: false,
          capture_pageview: false,
          capture_performance: false,
          disable_external_dependency_loading: true,
          disable_session_recording: true,
          disable_surveys: true,
          disable_surveys_automatic_display: true,
          disable_web_experiments: true,
          enable_recording_console_log: false,
          persistence: "localStorage",
          persistence_name: "matrix_os_desktop_support",
          person_profiles: "identified_only",
          rageclick: false,
        } as PostHogInitOptions);
        initialized = true;
      } catch (error: unknown) {
        console.warn("[desktop-support] PostHog initialization failed:", errorKind(error));
        return;
      }
    }

    const identity = `${handle}:${authGeneration}`;
    if (activeIdentity === identity) return;
    try {
      posthog.identify(handle, {
        $name: displayName ?? handle,
        matrix_client: "desktop",
      });
      activeIdentity = identity;
    } catch (error: unknown) {
      console.warn("[desktop-support] PostHog identification failed:", errorKind(error));
    }
  }, [authGeneration, displayName, handle, platformHost, status]);

  return null;
}
