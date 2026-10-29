"use client";

/**
 * Web Desktop and Web Canvas host for the Getting started app (spec 639):
 * the gateway port, one shared state for the desktop, the toast and the
 * window body that DesktopWindow and CanvasWindow render for `__getting-started__`.
 */
import {
  GettingStartedAppAutoOpenResponseSchema,
  GettingStartedAppAwardResponseSchema,
  GettingStartedAppProgressSchema,
  type GettingStartedAppAwardableTaskId,
} from "@matrix-os/contracts";
import {
  GettingStartedAppProvider,
  GettingStartedAppView,
  useGetStartedEnded,
  useGettingStartedApp,
  type GettingStartedAppAction,
  type GettingStartedAppPort,
} from "@matrix-os/ui";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import { ShellNotificationCard } from "@/components/ShellNotificationCard";
import { ShellNotificationPortal } from "@/components/ShellNotificationPortal";
import { loadWebGettingStartedResults, type GettingStartedDestination, type GettingStartedSettingsSection } from "../onboarding/GettingStartedPopover";

export const GETTING_STARTED_APP_PATH = "__getting-started__";
export const GETTING_STARTED_APP_TITLE = "Getting started";

const REQUEST_TIMEOUT_MS = 10_000;
const TOAST_MS = 4_000;

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function request(path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<Response> {
  return fetch(`${getGatewayUrl()}${path}`, {
    cache: "no-store",
    credentials: "include",
    ...init,
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
    signal: withTimeout(init.signal),
  });
}

export function createWebGettingStartedAppPort(): GettingStartedAppPort {
  return {
    loadResults: (signal) => loadWebGettingStartedResults((input, init) => fetch(input, { ...init, signal: withTimeout(signal) }), signal),
    async loadProgress(signal) {
      const response = await request("/api/getting-started/progress", { signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("getting_started_progress_unavailable");
      return GettingStartedAppProgressSchema.parse(await response.json());
    },
    async award(taskId: GettingStartedAppAwardableTaskId, silent: boolean) {
      const response = await request("/api/getting-started/awards", { method: "POST", body: JSON.stringify({ taskId, silent }) });
      if (!response.ok) throw new Error("getting_started_award_failed");
      return GettingStartedAppAwardResponseSchema.parse(await response.json());
    },
    async claimAutoOpen() {
      const response = await request("/api/getting-started/auto-open", { method: "POST", body: "{}" });
      if (!response.ok) throw new Error("getting_started_auto_open_failed");
      return GettingStartedAppAutoOpenResponseSchema.parse(await response.json()).open;
    },
  };
}

const ActionContext = createContext<((action: GettingStartedAppAction) => void) | null>(null);

/** Window body for `__getting-started__` in Web Desktop and Web Canvas. */
export function WebGettingStartedAppWindow() {
  const onAction = useContext(ActionContext);
  const state = useGettingStartedApp();
  if (!onAction) return null;
  if (state && !state.enabled) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">Getting started is not available on this computer yet.</div>;
  }
  return <GettingStartedAppView onAction={onAction} />;
}

export function WebGettingStartedAppHost({
  children,
  onOpenSettings,
  onOpenWork,
  onOpenSupport,
  onOpenApp,
  onEnabledChange,
}: {
  children: ReactNode;
  onOpenSettings(section: GettingStartedSettingsSection): void;
  onOpenWork(destination?: GettingStartedDestination): void;
  onOpenSupport(): void;
  /** Opens or focuses the app window; on first open it is also placed on the desktop. */
  onOpenApp(options: { addToDesktop: boolean }): void;
  onEnabledChange(enabled: boolean): void;
}) {
  const port = useMemo(() => createWebGettingStartedAppPort(), []);
  const getStartedEnded = useGetStartedEnded();
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const showToast = useCallback((text: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const openFromSummary = useCallback(() => onOpenApp({ addToDesktop: false }), [onOpenApp]);

  const onAction = useCallback((action: GettingStartedAppAction) => {
    switch (action.type) {
      case "chat":
        onOpenWork(action.prompt ? { kind: "chat", prompt: action.prompt } : { kind: "chat" });
        return;
      case "app-gallery":
        onOpenWork({ kind: "app-gallery" });
        return;
      case "settings":
        onOpenSettings(action.section);
        return;
      case "external":
        window.open(action.url, "_blank", "noopener,noreferrer");
        return;
      case "support":
        onOpenSupport();
        return;
    }
  }, [onOpenSettings, onOpenSupport, onOpenWork]);

  return (
    <GettingStartedAppProvider
      port={port}
      onToast={showToast}
      autoOpenEligible={getStartedEnded}
      onAutoOpen={() => onOpenApp({ addToDesktop: true })}
      onOpen={openFromSummary}
    >
      <EnabledReporter onEnabledChange={onEnabledChange} />
      <ActionContext value={onAction}>{children}</ActionContext>
      {toast ? (
        <ShellNotificationPortal>
          <ShellNotificationCard role="status" aria-live="polite">
            <div className="ml-auto w-fit rounded-lg bg-[#171717] px-3 py-2 text-xs text-white shadow-lg">{toast}</div>
          </ShellNotificationCard>
        </ShellNotificationPortal>
      ) : null}
    </GettingStartedAppProvider>
  );
}

function EnabledReporter({ onEnabledChange }: { onEnabledChange(enabled: boolean): void }) {
  const enabled = useGettingStartedApp()?.enabled ?? false;
  useEffect(() => {
    onEnabledChange(enabled);
  }, [enabled, onEnabledChange]);
  return null;
}
