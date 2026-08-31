import posthog from "posthog-js/dist/module.no-external";
import { useEffect } from "react";
import { DESKTOP_ANALYTICS_EVENT, isDesktopAnalyticsName, type DesktopAnalyticsDetail } from "../../lib/desktop-analytics";
import { useConnection } from "../../stores/connection";

type PostHogInitOptions = Parameters<typeof posthog.init>[1];

let initialized = false;
let activeIdentity: string | null = null;
let activeApiHost: string | null = null;

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

function resetDesktopAnalytics(): void {
  if (!initialized || activeIdentity === null) return;
  try {
    posthog.reset();
  } catch (error: unknown) {
    console.warn("[desktop-analytics] Failed to reset PostHog identity:", errorKind(error));
  }
  activeIdentity = null;
}

export default function DesktopPostHogAnalytics() {
  const status = useConnection((state) => state.status);
  const handle = useConnection((state) => state.handle);
  const displayName = useConnection((state) => state.displayName);
  const platformHost = useConnection((state) => state.platformHost);
  const authGeneration = useConnection((state) => state.authGeneration);

  useEffect(() => {
    const token = configuredToken();
    const apiHost = relayUrl(platformHost);
    if (!token || status !== "signed-in" || !handle || !apiHost) {
      resetDesktopAnalytics();
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
          disable_conversations: true,
          disable_external_dependency_loading: true,
          disable_session_recording: true,
          disable_surveys: true,
          disable_surveys_automatic_display: true,
          disable_web_experiments: true,
          enable_recording_console_log: false,
          persistence: "localStorage",
          persistence_name: "matrix_os_desktop_analytics",
          person_profiles: "identified_only",
          rageclick: false,
        } as PostHogInitOptions);
        initialized = true;
        activeApiHost = apiHost;
      } catch (error: unknown) {
        console.warn("[desktop-analytics] PostHog initialization failed:", errorKind(error));
        return;
      }
    }

    if (activeApiHost !== apiHost) {
      try {
        if (activeIdentity !== null) posthog.reset();
        activeIdentity = null;
        posthog.set_config({ api_host: apiHost });
        activeApiHost = apiHost;
      } catch (error: unknown) {
        console.warn("[desktop-analytics] PostHog relay rebind failed:", errorKind(error));
        return;
      }
    }

    const identity = `${handle}:${authGeneration}`;
    if (activeIdentity === identity) return;
    try {
      if (activeIdentity !== null) {
        posthog.reset();
        activeIdentity = null;
      }
      posthog.identify(handle, {
        $name: displayName ?? handle,
        matrix_client: "desktop",
      });
      activeIdentity = identity;
    } catch (error: unknown) {
      console.warn("[desktop-analytics] PostHog identification failed:", errorKind(error));
    }
  }, [authGeneration, displayName, handle, platformHost, status]);

  useEffect(() => {
    const capture = (event: Event) => {
      const detail = (event as CustomEvent<DesktopAnalyticsDetail>).detail;
      if (!initialized || activeIdentity === null || !isDesktopAnalyticsName(detail?.name)) return;
      posthog.capture(detail.name, {
        ...(detail.appKind ? { app_kind: detail.appKind } : {}),
        ...(typeof detail.open === "boolean" ? { open: detail.open } : {}),
        matrix_client: "desktop",
      });
    };
    window.addEventListener(DESKTOP_ANALYTICS_EVENT, capture);
    return () => window.removeEventListener(DESKTOP_ANALYTICS_EVENT, capture);
  }, []);

  return null;
}
