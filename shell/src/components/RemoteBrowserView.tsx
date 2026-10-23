"use client";

import { useCallback, useMemo } from "react";
import { BrowserSurface, createBrowserSetupTransport, type BrowserSurfaceKind } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";

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
  return <BrowserSurface key={`${gatewayUrl}:${surface}`} gatewayUrl={gatewayUrl} surface={surface} active={active}
    ensureSession={ensureSession} setup={setup} onOpenCloudDesktop={onOpenCloudDesktop} onOpenBrowser={onOpenBrowser}/>;
}
