"use client";

import { useCallback } from "react";
import { BrowserSurface, type BrowserSurfaceKind } from "@matrix-os/ui";
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
  return <BrowserSurface key={`${gatewayUrl}:${surface}`} gatewayUrl={gatewayUrl} surface={surface} active={active}
    ensureSession={ensureSession} onOpenCloudDesktop={onOpenCloudDesktop} onOpenBrowser={onOpenBrowser}/>;
}
