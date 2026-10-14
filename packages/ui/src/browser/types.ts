import type { SharedBrowserControl, SharedBrowserState } from "@matrix-os/contracts";

export type BrowserSurfaceKind = "browser" | "desktop";
export type BrowserControlAction = "restore-chrome" | "show-desktop" | "open-files" | "open-terminal";
export type BrowserAutomationAction = SharedBrowserControl["action"];
export type BrowserAutomationStatus = SharedBrowserState;
export interface BrowserSessionOptions { force?: boolean }
export interface BrowserStatus {
  available: boolean;
  chrome: { present: boolean; minimized: boolean };
  humanControlAvailable: boolean;
  automation?: BrowserAutomationStatus;
}
export interface BrowserSurfaceProps {
  gatewayUrl: string;
  surface: BrowserSurfaceKind;
  active?: boolean;
  ensureSession(signal: AbortSignal, options?: BrowserSessionOptions): Promise<void>;
  onOpenCloudDesktop?: () => void;
  onOpenBrowser?: () => void;
}
export type BrowserConnection = "connecting" | "connected" | "disconnected" | "unavailable" | "inactive";
export interface BrowserSurfaceState {
  scope: string;
  status: BrowserStatus | null;
  connection: BrowserConnection;
  viewerUrl: string;
  busy: boolean;
  automationAction?: BrowserAutomationAction;
  error: string;
}
