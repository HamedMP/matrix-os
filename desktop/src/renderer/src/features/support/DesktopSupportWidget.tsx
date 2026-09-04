import "posthog-js/dist/conversations";
import posthog from "posthog-js/dist/module.no-external";
import {
  buildSupportChatProperties,
  SupportIdentityResponseSchema,
  type SupportChatProperties,
} from "@matrix-os/contracts";
import {
  DESKTOP_ANALYTICS_EVENT,
  DesktopAnalyticsDetailSchema,
  type DesktopAnalyticsDetail,
} from "../../lib/desktop-analytics";
import type { ApiClient } from "../../lib/api";
import { invoke, onEvent } from "../../lib/operator";
import { useEffect } from "react";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";

type PostHogInitOptions = Parameters<typeof posthog.init>[1];

let initialized = false;
let activeIdentity: string | null = null;
let activeApiHost: string | null = null;
let allowPostHogWidget = false;
let launcherObserver: MutationObserver | null = null;
let openSupportPromise: Promise<boolean> | null = null;
let supportLifecycleGeneration = 0;
let cancelPendingElementWait: (() => void) | null = null;
let supportOverlayHeld = false;
let supportPanelTracked = false;
let applicationOpenTracked = false;

const POSTHOG_WIDGET_ID = "ph-conversations-widget-container";
const POSTHOG_LAUNCHER_SELECTOR = 'button[aria-label^="Open chat"]';
const POSTHOG_CLOSE_SELECTOR = 'button[aria-label="Close"]';
const SUPPORT_OPEN_TIMEOUT_MS = 10_000;
const QUIT_CAPTURE_TIMEOUT_MS = 500;

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function configuredToken(): string | null {
  const token = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN?.trim();
  return token || null;
}

function isDesktopSupportConfigured(): boolean {
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

async function loadDesktopSupportProperties(api: ApiClient): Promise<SupportChatProperties> {
  const [systemInfoResult, desktopVersionResult] = await Promise.allSettled([
    api.get<unknown>("/api/system/info"),
    invoke("app:get-version", {}),
  ]);
  if (systemInfoResult.status === "rejected") {
    console.warn(
      "[desktop-support] Runtime metadata unavailable:",
      errorKind(systemInfoResult.reason),
    );
  }
  if (desktopVersionResult.status === "rejected") {
    console.warn(
      "[desktop-support] Native app version unavailable:",
      errorKind(desktopVersionResult.reason),
    );
  }
  return buildSupportChatProperties({
    client: "desktop",
    systemInfo: systemInfoResult.status === "fulfilled" ? systemInfoResult.value : undefined,
    desktopVersion: desktopVersionResult.status === "fulfilled"
      ? desktopVersionResult.value.version
      : undefined,
  });
}

function applyDesktopSupportProperties(properties: SupportChatProperties): void {
  if (!properties.matrix_bundle_version) posthog.unregister("matrix_bundle_version");
  if (!properties.matrix_desktop_version) posthog.unregister("matrix_desktop_version");
  posthog.register(properties);
  posthog.setPersonProperties(properties);
}

function captureActive(
  detail: DesktopAnalyticsDetail,
): ReturnType<typeof posthog.capture> {
  if (!initialized || activeIdentity === null) return;
  try {
    const properties = {
      ...("appKind" in detail && detail.appKind
        ? { app_kind: detail.appKind }
        : {}),
      ...(detail.name === "desktop_launcher_toggled" ? { open: detail.open } : {}),
      ...(detail.name === "desktop_support_send_failed"
        ? { failure_kind: detail.failureKind }
        : {}),
      ...("chatScope" in detail ? { chat_scope: detail.chatScope } : {}),
      ...("hasAttachments" in detail ? { has_attachments: detail.hasAttachments } : {}),
      ...("harness" in detail ? { harness: detail.harness } : {}),
      ...("modelProvider" in detail ? { model_provider: detail.modelProvider } : {}),
      ...("model" in detail ? { model: detail.model } : {}),
      ...("responseCharacterCount" in detail
        ? { response_character_count: detail.responseCharacterCount }
        : {}),
      ...(detail.name === "desktop_chat_message_send_failed"
        ? { failure_kind: detail.failureKind }
        : {}),
      matrix_client: "desktop",
    };
    return posthog.capture(detail.name, properties);
  } catch (error: unknown) {
    console.warn("[desktop-support] Analytics capture unavailable:", errorKind(error));
  }
}

async function sendCapturedQuitEvent(payload: NonNullable<ReturnType<typeof posthog.capture>>): Promise<void> {
  if (!activeApiHost) return;
  const response = await fetch(`${activeApiHost}/i/v0/e/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(QUIT_CAPTURE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("quit capture failed");
}

function closeTrackedSupportPanel(): void {
  if (!supportPanelTracked) return;
  supportPanelTracked = false;
  captureActive({ name: "desktop_support_closed" });
}

function hidePostHogWidget(): void {
  try {
    posthog.conversations.hide();
  } catch (error: unknown) {
    console.warn("[desktop-support] Failed to hide PostHog widget:", errorKind(error));
  }
}

function acquireSupportOverlay(): void {
  if (supportOverlayHeld) return;
  supportOverlayHeld = true;
  useUi.getState().acquireRendererOverlay();
}

function releaseSupportOverlay(): void {
  if (!supportOverlayHeld) return;
  supportOverlayHeld = false;
  useUi.getState().releaseRendererOverlay();
}

function suppressDefaultLauncher(): void {
  const widget = document.getElementById(POSTHOG_WIDGET_ID);
  const launcher = widget?.querySelector(POSTHOG_LAUNCHER_SELECTOR);
  const panel = widget?.querySelector(POSTHOG_CLOSE_SELECTOR);

  if (allowPostHogWidget) {
    if (openSupportPromise || panel) return;
    allowPostHogWidget = false;
    closeTrackedSupportPanel();
    releaseSupportOverlay();
  }
  if (!launcher && !panel) return;
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

function findPostHogButton(selector: string): HTMLButtonElement | null {
  return document.getElementById(POSTHOG_WIDGET_ID)?.querySelector<HTMLButtonElement>(selector) ?? null;
}

async function waitForSupportReady(generation: number): Promise<boolean> {
  const deadline = Date.now() + SUPPORT_OPEN_TIMEOUT_MS;
  while (Date.now() < deadline && generation === supportLifecycleGeneration) {
    if (supportOpenIsCurrent(generation)) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  return false;
}

function waitForElement(selector: string, generation: number): Promise<HTMLButtonElement | null> {
  if (!supportOpenIsCurrent(generation)) return Promise.resolve(null);
  const existing = findPostHogButton(selector);
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
      const element = findPostHogButton(selector);
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
  if (!await waitForSupportReady(generation) || !await waitForConversations(generation)) return false;

  allowPostHogWidget = true;
  try {
    if (!supportOpenIsCurrent(generation)) return false;
    posthog.conversations.show();

    let closeButton = findPostHogButton(POSTHOG_CLOSE_SELECTOR);
    if (!closeButton) {
      const launcher = await waitForElement(POSTHOG_LAUNCHER_SELECTOR, generation);
      if (!launcher || !supportOpenIsCurrent(generation)) return false;
      launcher.click();
      closeButton = await waitForElement(POSTHOG_CLOSE_SELECTOR, generation);
    }
    if (!closeButton || !supportOpenIsCurrent(generation)) return false;

    return true;
  } finally {
    if (generation === supportLifecycleGeneration && !findPostHogButton(POSTHOG_CLOSE_SELECTOR)) {
      allowPostHogWidget = false;
      suppressDefaultLauncher();
    }
  }
}

export function openDesktopSupport(): Promise<boolean> {
  if (!isDesktopSupportConfigured()) return Promise.resolve(false);
  if (!openSupportPromise) {
    acquireSupportOverlay();
    const generation = supportLifecycleGeneration;
    const promise = openSupportPanel(generation)
      .catch((error: unknown) => {
        console.warn("[desktop-support] Support chat unavailable:", errorKind(error));
        return false;
      })
      .then((opened) => {
        if (opened) {
          supportPanelTracked = true;
          captureActive({ name: "desktop_support_opened" });
        } else {
          releaseSupportOverlay();
        }
        return opened;
      })
      .finally(() => {
        if (openSupportPromise === promise) openSupportPromise = null;
      });
    openSupportPromise = promise;
  }
  return openSupportPromise;
}

function clearActivePostHogIdentity(
  eventName: "desktop_sign_out" | "desktop_identity_reset",
): void {
  if (activeIdentity === null) return;
  closeTrackedSupportPanel();
  captureActive({ name: eventName });
  try {
    posthog.clearIdentity();
  } catch (error: unknown) {
    console.warn("[desktop-support] Failed to clear Conversations identity:", errorKind(error));
  }
  try {
    posthog.reset();
  } catch (error: unknown) {
    console.warn("[desktop-support] Failed to reset PostHog identity:", errorKind(error));
  }
  activeIdentity = null;
}

function hideAndResetSupport(): void {
  invalidatePendingSupportOpen();
  allowPostHogWidget = false;
  releaseSupportOverlay();
  if (!initialized) return;
  hidePostHogWidget();
  clearActivePostHogIdentity("desktop_sign_out");
}

export default function DesktopSupportWidget() {
  const status = useConnection((state) => state.status);
  const handle = useConnection((state) => state.handle);
  const userId = useConnection((state) => state.userId);
  const displayName = useConnection((state) => state.displayName);
  const email = useConnection((state) => state.email);
  const platformHost = useConnection((state) => state.platformHost);
  const authGeneration = useConnection((state) => state.authGeneration);
  const api = useConnection((state) => state.api);

  useEffect(() => {
    let cancelled = false;
    const token = configuredToken();
    const apiHost = relayUrl(platformHost);
    if (!token || status !== "signed-in" || !handle || !userId || !apiHost || !api) {
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
        clearActivePostHogIdentity("desktop_identity_reset");
        posthog.set_config({ api_host: apiHost });
        activeApiHost = apiHost;
      } catch (error: unknown) {
        console.warn("[desktop-support] PostHog relay rebind failed:", errorKind(error));
        return;
      }
    }

    const identity = `${userId}:${authGeneration}`;
    if (activeIdentity === identity) {
      try {
        posthog.setPersonProperties({
          $name: displayName ?? handle,
          email: email ?? null,
        });
      } catch (error: unknown) {
        console.warn("[desktop-support] PostHog profile update failed:", errorKind(error));
      }
      return;
    }
    if (activeIdentity !== null) {
      invalidatePendingSupportOpen();
      allowPostHogWidget = false;
      hidePostHogWidget();
      clearActivePostHogIdentity("desktop_identity_reset");
    }
    const generation = supportLifecycleGeneration;

    void Promise.all([
      loadDesktopSupportProperties(api),
      invoke("support:get-identity", {}).catch((error: unknown) => {
        console.warn("[desktop-support] Verified identity unavailable:", errorKind(error));
        return { status: "unavailable" as const };
      }),
    ]).then(([properties, rawSupportIdentity]) => {
      if (cancelled || generation !== supportLifecycleGeneration) return;
      try {
        applyDesktopSupportProperties(properties);
        posthog.identify(userId, {
          $name: displayName ?? handle,
          email: email ?? null,
          ...properties,
        });
        activeIdentity = identity;
        const supportIdentity = SupportIdentityResponseSchema.safeParse(rawSupportIdentity);
        if (
          supportIdentity.success &&
          supportIdentity.data.status === "verified" &&
          supportIdentity.data.distinctId === userId
        ) {
          posthog.setIdentity(
            supportIdentity.data.distinctId,
            supportIdentity.data.identityHash,
          );
        } else {
          captureActive({ name: "desktop_support_identity_unavailable" });
        }
        captureActive({ name: "desktop_auth_completed" });
        if (!applicationOpenTracked) {
          applicationOpenTracked = true;
          captureActive({ name: "desktop_application_opened" });
        }
        hidePostHogWidget();
        suppressDefaultLauncher();
      } catch (error: unknown) {
        console.warn("[desktop-support] PostHog identification failed:", errorKind(error));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [api, authGeneration, displayName, email, handle, platformHost, status, userId]);

  useEffect(() => {
    const capture = (event: Event) => {
      const parsed = DesktopAnalyticsDetailSchema.safeParse(
        (event as CustomEvent<unknown>).detail,
      );
      if (!parsed.success) return;
      captureActive(parsed.data);
    };
    const removeMainAnalyticsListener = onEvent("analytics:capture", (detail) => {
      captureActive(detail);
    });
    window.addEventListener(DESKTOP_ANALYTICS_EVENT, capture);
    return () => {
      removeMainAnalyticsListener();
      window.removeEventListener(DESKTOP_ANALYTICS_EVENT, capture);
    };
  }, []);

  useEffect(() => onEvent("analytics:flush-requested", () => {
    const flush = async () => {
      if (initialized && activeIdentity !== null) {
        const payload = captureActive({ name: "desktop_application_quit_requested" });
        if (payload) {
          try {
            await sendCapturedQuitEvent(payload);
          } catch (error: unknown) {
            console.warn("[desktop-support] Quit analytics delivery unavailable:", errorKind(error));
          }
        }
        try {
          await posthog.shutdown();
        } catch (error: unknown) {
          console.warn("[desktop-support] PostHog shutdown unavailable:", errorKind(error));
        }
      }
      try {
        await invoke("analytics:flush-complete", {});
      } catch (error: unknown) {
        console.warn("[desktop-support] Analytics flush acknowledgement failed:", errorKind(error));
      }
    };
    void flush();
  }), []);

  useEffect(() => () => {
    invalidatePendingSupportOpen();
    allowPostHogWidget = false;
    releaseSupportOverlay();
    stopLauncherObserver();
  }, []);

  return null;
}
