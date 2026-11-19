"use client";

import { useCallback, useMemo, useRef } from "react";
import type { BrowserChromeAction } from "@matrix-os/contracts";
import { BrowserSurface, BrowserTitleBarControls, createBrowserSetupTransport, type BrowserChromeHost, type BrowserSurfaceKind } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
import { useWindowTitleBarActions } from "./window/WindowTitleBarActions";

export function RemoteBrowserView({ surface, active = true, onOpenCloudDesktop, onOpenBrowser }: {
  surface: BrowserSurfaceKind; active?: boolean; onOpenCloudDesktop?: () => void; onOpenBrowser?: () => void;
}) {
  const gatewayUrl = getGatewayUrl();
  const ensureSession = useCallback(async (signal: AbortSignal) => {
    const response = await fetch(`${gatewayUrl}/api/apps/browser-lab/session`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}",
      redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("Browser session unavailable");
  }, [gatewayUrl]);
  const setup = useMemo(() => createBrowserSetupTransport(gatewayUrl), [gatewayUrl]);
  // Inside a Web Desktop or Web Canvas window, the toolbar moves into the window title bar.
  const setTitleBarActions = useWindowTitleBarActions();
  const actionHandler = useRef<((action: BrowserChromeAction) => void) | null>(null);
  const chromeHost = useMemo<BrowserChromeHost | undefined>(() => setTitleBarActions ? {
    publish: (model) => setTitleBarActions(model
      ? <BrowserTitleBarControls model={model} onAction={(action) => actionHandler.current?.(action)} />
      : null),
    onAction: (handler) => {
      actionHandler.current = handler;
      return () => { if (actionHandler.current === handler) actionHandler.current = null; };
    },
  } : undefined, [setTitleBarActions]);
  return <BrowserSurface key={`${gatewayUrl}:${surface}`} gatewayUrl={gatewayUrl} surface={surface} active={active}
    ensureSession={ensureSession} setup={setup} onOpenCloudDesktop={onOpenCloudDesktop} onOpenBrowser={onOpenBrowser}
    chromeHost={chromeHost} />;
}
