/** Gateway port for the Getting started app on Web Desktop and Web Canvas (spec 639). */
import {
  GettingStartedAppAutoOpenResponseSchema,
  GettingStartedAppAwardResponseSchema,
  GettingStartedAppDesktopIconResponseSchema,
  GettingStartedAppProgressSchema,
  gettingStartedAppLogos,
  type GettingStartedAppAwardableTaskId,
} from "@matrix-os/contracts";
import type { GettingStartedAppPort } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
import { currentRuntimeSlot, loadWebGettingStartedResults } from "../onboarding/GettingStartedPopover";

export const GETTING_STARTED_APP_PATH = "__getting-started__";
export const GETTING_STARTED_APP_TITLE = "Getting started";

const REQUEST_TIMEOUT_MS = 10_000;

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export interface WebGettingStartedComputer {
  gatewayUrl: string;
  runtimeSlot: string;
}

export function currentWebGettingStartedComputer(): WebGettingStartedComputer {
  return { gatewayUrl: getGatewayUrl(), runtimeSlot: currentRuntimeSlot() };
}

async function requestFrom(gatewayUrl: string, path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<Response> {
  return fetch(`${gatewayUrl}${path}`, {
    cache: "no-store",
    credentials: "include",
    ...init,
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
    signal: withTimeout(init.signal),
  });
}

export function createWebGettingStartedAppPort(computer: WebGettingStartedComputer): GettingStartedAppPort {
  const request = (path: string, init?: RequestInit & { signal?: AbortSignal }) => requestFrom(computer.gatewayUrl, path, init);
  return {
    loadResults: (signal) => loadWebGettingStartedResults((input, init) => fetch(input, { ...init, signal: withTimeout(signal) }), signal, computer),
    async loadProgress(signal) {
      const response = await request("/api/getting-started/progress", { signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("getting_started_progress_unavailable");
      return GettingStartedAppProgressSchema.parse(await response.json());
    },
    async award(taskId: GettingStartedAppAwardableTaskId, silent: boolean, signal?: AbortSignal) {
      const response = await request("/api/getting-started/awards", { method: "POST", body: JSON.stringify({ taskId, silent }), signal });
      if (!response.ok) throw new Error("getting_started_award_failed");
      return GettingStartedAppAwardResponseSchema.parse(await response.json());
    },
    async claimAutoOpen(signal?: AbortSignal) {
      const response = await request("/api/getting-started/auto-open", { method: "POST", body: "{}", signal });
      if (!response.ok) throw new Error("getting_started_auto_open_failed");
      return GettingStartedAppAutoOpenResponseSchema.parse(await response.json()).open;
    },
    async desktopIconPlaced(signal?: AbortSignal) {
      const response = await request("/api/getting-started/desktop-icon", { signal });
      if (!response.ok) throw new Error("getting_started_desktop_icon_unavailable");
      return GettingStartedAppDesktopIconResponseSchema.parse(await response.json()).placed;
    },
    async markDesktopIconPlaced(signal?: AbortSignal) {
      const response = await request("/api/getting-started/desktop-icon", { method: "POST", body: "{}", signal });
      if (!response.ok) throw new Error("getting_started_desktop_icon_failed");
      GettingStartedAppDesktopIconResponseSchema.parse(await response.json());
    },
    async loadLogos(signal: AbortSignal) {
      const response = await request("/api/integrations/available", { signal });
      if (!response.ok) throw new Error("getting_started_logos_unavailable");
      return gettingStartedAppLogos(await response.json());
    },
  };
}

/**
 * Whether the Getting started window is on screen in Web Desktop or Web Canvas. A minimized window,
 * one covered by another fullscreen window, or one panned out of view is not, so awards get the
 * corner toast. Fullscreen fills the viewport wherever the window's saved position is.
 */
export function webGettingStartedAppVisible(
  win: { id: string; minimized?: boolean },
  fullscreenWindowId: string | null,
  onScreen = true,
): boolean {
  if (win.minimized) return false;
  return fullscreenWindowId === null ? onScreen : fullscreenWindowId === win.id;
}

/** Whether any part of a Web Canvas window is inside the viewport at the current pan and zoom. */
export function webGettingStartedWindowOnScreen(
  win: { x: number; y: number; width: number; height: number },
  view: { zoom: number; panX: number; panY: number; viewportWidth: number; viewportHeight: number },
): boolean {
  const left = (win.x + view.panX) * view.zoom;
  const top = (win.y + view.panY) * view.zoom;
  const right = left + win.width * view.zoom;
  const bottom = top + win.height * view.zoom;
  return right > 0 && bottom > 0 && left < view.viewportWidth && top < view.viewportHeight;
}
