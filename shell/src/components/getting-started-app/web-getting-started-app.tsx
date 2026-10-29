"use client";

/**
 * Web Desktop and Web Canvas host for the Getting started app (spec 639):
 * one shared state for the desktop, the toasts and the
 * window body that DesktopWindow and CanvasWindow render for `__getting-started__`.
 */
import {
  GettingStartedAppProvider,
  GettingStartedAppView,
  useGetStartedEnded,
  useGettingStartedApp,
  GettingStartedAppToastView,
  type GettingStartedAppAction,
  type GettingStartedAppToast,
} from "@matrix-os/ui";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ShellNotificationCard } from "@/components/ShellNotificationCard";
import { ShellNotificationPortal } from "@/components/ShellNotificationPortal";
import type { GettingStartedDestination, GettingStartedSettingsSection } from "../onboarding/GettingStartedPopover";
import { useDesktopConfigStore } from "@/stores/desktop-config";
import { GETTING_STARTED_APP_PATH, createWebGettingStartedAppPort } from "./web-getting-started-app-port";

const TOAST_MS = 4_000;
/** Several tasks can finish between polls; each gets its own toast, newest last. */
const MAX_TOASTS = 3;

interface QueuedToast {
  id: number;
  toast: GettingStartedAppToast;
}

const ActionContext = createContext<((action: GettingStartedAppAction) => void) | null>(null);

/** Window body for `__getting-started__` in Web Desktop and Web Canvas; `visible` is false while minimized. */
export function WebGettingStartedAppWindow({ visible = true }: { visible?: boolean }) {
  const onAction = useContext(ActionContext);
  const state = useGettingStartedApp();
  if (!onAction) return null;
  if (state && !state.enabled) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">Getting started is not available on this computer yet.</div>;
  }
  return <GettingStartedAppView onAction={onAction} visible={visible} />;
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
  /** Opens or focuses the app window. */
  onOpenApp(): void;
  onEnabledChange(enabled: boolean): void;
}) {
  const port = useMemo(() => createWebGettingStartedAppPort(), []);
  // Spec 639: the icon goes on every owner's desktop once, after the saved layout has loaded.
  const desktopIconsLoaded = useDesktopConfigStore((state) => state.desktopIcons !== undefined);
  const placeDesktopIcon = useCallback(async () => {
    const result = await useDesktopConfigStore.getState().addDesktopIcon(GETTING_STARTED_APP_PATH);
    if (result === "failed" || result === "desktop-full") console.warn("[getting-started-app] desktop icon not placed:", result);
    return result;
  }, []);
  const getStartedEnded = useGetStartedEnded();
  const [toasts, setToasts] = useState<QueuedToast[]>([]);
  // One timer per toast, removed when it fires; at most nine awardable tasks exist, all cleared on unmount.
  const toastTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextToastId = useRef(0);

  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const dismissToast = useCallback((id: number) => {
    const timer = toastTimers.current.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((toast: GettingStartedAppToast) => {
    const id = nextToastId.current;
    nextToastId.current = (id + 1) % Number.MAX_SAFE_INTEGER;
    setToasts((current) => [...current, { id, toast }].slice(-MAX_TOASTS));
    toastTimers.current.set(id, setTimeout(() => dismissToast(id), TOAST_MS));
  }, [dismissToast]);


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
      onAutoOpen={onOpenApp}
      onOpen={onOpenApp}
      desktopIconReady={desktopIconsLoaded}
      onPlaceDesktopIcon={placeDesktopIcon}
      onEnabledChange={onEnabledChange}
    >
      <ActionContext value={onAction}>{children}</ActionContext>
      {toasts.length > 0 ? (
        <ShellNotificationPortal>
          <ShellNotificationCard role="status" aria-live="polite">
            <div className="ml-auto flex w-fit flex-col items-end gap-2">
              {toasts.map((queued) => (
                <GettingStartedAppToastView key={queued.id} toast={queued.toast} />
              ))}
            </div>
          </ShellNotificationCard>
        </ShellNotificationPortal>
      ) : null}
    </GettingStartedAppProvider>
  );
}
