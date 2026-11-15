import React, { type ReactNode } from "react";
import { currentPlatform, isMacPlatform } from "../../lib/platform-labels";
/** Clears the hidden-titlebar macOS window buttons drawn at trafficLightPosition { x: 14, y: 13 }. */
export const MAC_TRAFFIC_LIGHT_INSET_PX = 80;
/** index.css class that clears the Windows titleBarOverlay caption buttons on the right. */
export const WINDOWS_CAPTION_INSET_CLASS = "status-banner-windows";
/** Slim top-of-window identity strip shared by preview-pair and dev-run banners. */
export function StatusBanner({ children, platform = currentPlatform() }: { children: ReactNode; platform?: string }) {
  const paddingLeft = isMacPlatform(platform) ? MAC_TRAFFIC_LIGHT_INSET_PX : undefined;
  const insetClass = /^Win/i.test(platform) ? ` ${WINDOWS_CAPTION_INSET_CLASS}` : "";
  return <div role="status" className={`titlebar-drag shrink-0 truncate border-b px-4 py-2 text-right text-xs${insetClass}`} style={{ paddingLeft, borderColor: "var(--border-default)", background: "var(--bg-overlay)", color: "var(--text-primary)" }}>
    {children}
  </div>;
}
