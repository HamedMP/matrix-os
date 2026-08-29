import "posthog-js/dist/conversations";
import posthog from "posthog-js/dist/module.no-external";
import { useEffect } from "react";
import { useConnection } from "../../stores/connection";

type PostHogInitOptions = Parameters<typeof posthog.init>[1];

let initialized = false;
let activeIdentity: string | null = null;
let activeApiHost: string | null = null;
let allowPostHogWidget = false;
let launcherObserver: MutationObserver | null = null;
let openSupportPromise: Promise<boolean> | null = null;
let supportLifecycleGeneration = 0;
let cancelPendingElementWait: (() => void) | null = null;

const POSTHOG_WIDGET_ID = "ph-conversations-widget-container";
const POSTHOG_LAUNCHER_SELECTOR = 'button[aria-label^="Open chat"]';
const POSTHOG_CLOSE_SELECTOR = 'button[aria-label="Close"]';
const SUPPORT_OPEN_TIMEOUT_MS = 10_000;

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function configuredToken(): string | null {
  const token = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN?.trim();
  return token || null;
}

export function isDesktopSupportConfigured(): boolean {
  return configuredToken() !== null;
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

function hidePostHogWidget(): void {
  try {
    posthog.conversations.hide();
  } catch (error: unknown) {
    console.warn("[desktop-support] Failed to hide PostHog widget:", errorKind(error));
  }
}

function suppressDefaultLauncher(): void {
  const widget = document.getElementById(POSTHOG_WIDGET_ID);
  const launcher = widget?.querySelector(POSTHOG_LAUNCHER_SELECTOR);
  const panel = widget?.querySelector(POSTHOG_CLOSE_SELECTOR);
  if (!launcher && !panel) return;

  if (allowPostHogWidget) {
    if (openSupportPromise || panel) return;
    allowPostHogWidget = false;
  }
  hidePostHogWidget();
}

function startLauncherObserver(): void {
  if (launcherObserver || !document.body) return;
  launcherObserver = new MutationObserver(suppressDefaultLauncher);
  launcherObserver.observe(document.body, { childList: true, subtree: true });
  suppressDefaultLauncher();
}

function stopLauncherObserver(): void {
  launcherObserver?.disconnect();
  launcherObserver = null;
}

function invalidatePendingSupportOpen(): void {
  supportLifecycleGeneration += 1;
  cancelPendingElementWait?.();
  cancelPendingElementWait = null;
  openSupportPromise = null;
}

function supportOpenIsCurrent(generation: number): boolean {
  return generation === supportLifecycleGeneration && initialized && activeIdentity !== null;
}

function waitForElement(selector: string, generation: number): Promise<HTMLButtonElement | null> {
  if (!supportOpenIsCurrent(generation)) return Promise.resolve(null);
  const existing = document.querySelector<HTMLButtonElement>(selector);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (element: HTMLButtonElement | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timeoutId);
      if (cancelPendingElementWait === cancel) cancelPendingElementWait = null;
      resolve(element);
    };
    const cancel = () => finish(null);
    const observer = new MutationObserver(() => {
      if (!supportOpenIsCurrent(generation)) {
        finish(null);
        return;
      }
      const element = document.querySelector<HTMLButtonElement>(selector);
      if (element) finish(element);
    });
    const timeoutId = window.setTimeout(() => finish(null), SUPPORT_OPEN_TIMEOUT_MS);
    cancelPendingElementWait = cancel;
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

async function waitForConversations(generation: number): Promise<boolean> {
  const deadline = Date.now() + SUPPORT_OPEN_TIMEOUT_MS;
  while (Date.now() < deadline && supportOpenIsCurrent(generation)) {
    if (posthog.conversations.isAvailable()) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  return false;
}

async function openSupportPanel(generation: number): Promise<boolean> {
  if (!supportOpenIsCurrent(generation) || !await waitForConversations(generation)) return false;

  allowPostHogWidget = true;
  try {
    if (!supportOpenIsCurrent(generation)) return false;
    posthog.conversations.show();

    let closeButton = document.querySelector<HTMLButtonElement>(POSTHOG_CLOSE_SELECTOR);
    if (!closeButton) {
      const launcher = await waitForElement(POSTHOG_LAUNCHER_SELECTOR, generation);
      if (!launcher || !supportOpenIsCurrent(generation)) return false;
      launcher.click();
      closeButton = await waitForElement(POSTHOG_CLOSE_SELECTOR, generation);
    }
    if (!closeButton || !supportOpenIsCurrent(generation)) return false;

    return true;
  } finally {
    if (generation === supportLifecycleGeneration && !document.querySelector(POSTHOG_CLOSE_SELECTOR)) {
      allowPostHogWidget = false;
      suppressDefaultLauncher();
    }
  }
}

export function openDesktopSupport(): Promise<boolean> {
  if (!openSupportPromise) {
    const generation = supportLifecycleGeneration;
    const promise = openSupportPanel(generation)
      .catch((error: unknown) => {
        console.warn("[desktop-support] Support chat unavailable:", errorKind(error));
        return false;
      })
      .finally(() => {
        if (openSupportPromise === promise) openSupportPromise = null;
      });
    openSupportPromise = promise;
  }
  return openSupportPromise;
}

function hideAndResetSupport(): void {
  invalidatePendingSupportOpen();
  allowPostHogWidget = false;
  if (!initialized) return;
  hidePostHogWidget();
  if (activeIdentity === null) return;
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

    startLauncherObserver();

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
        activeApiHost = apiHost;
      } catch (error: unknown) {
        console.warn("[desktop-support] PostHog initialization failed:", errorKind(error));
        return;
      }
    }

    if (activeApiHost !== apiHost) {
      invalidatePendingSupportOpen();
      allowPostHogWidget = false;
      hidePostHogWidget();
      try {
        if (activeIdentity !== null) posthog.reset();
        activeIdentity = null;
        posthog.set_config({ api_host: apiHost });
        activeApiHost = apiHost;
      } catch (error: unknown) {
        console.warn("[desktop-support] PostHog relay rebind failed:", errorKind(error));
        return;
      }
    }

    const identity = `${handle}:${authGeneration}`;
    if (activeIdentity === identity) return;
    try {
      if (activeIdentity !== null) {
        invalidatePendingSupportOpen();
        allowPostHogWidget = false;
        hidePostHogWidget();
        posthog.reset();
        activeIdentity = null;
      }
      posthog.identify(handle, {
        $name: displayName ?? handle,
        matrix_client: "desktop",
      });
      activeIdentity = identity;
      hidePostHogWidget();
      suppressDefaultLauncher();
    } catch (error: unknown) {
      console.warn("[desktop-support] PostHog identification failed:", errorKind(error));
    }
  }, [authGeneration, displayName, handle, platformHost, status]);

  useEffect(() => () => {
    invalidatePendingSupportOpen();
    allowPostHogWidget = false;
    stopLauncherObserver();
  }, []);

  return null;
}
