/** Gateway port for the Getting started app on Web Desktop and Web Canvas (spec 639). */
import {
  GettingStartedAppAutoOpenResponseSchema,
  GettingStartedAppAwardResponseSchema,
  GettingStartedAppDesktopIconResponseSchema,
  GettingStartedAppProgressSchema,
  type GettingStartedAppAwardableTaskId,
} from "@matrix-os/contracts";
import type { GettingStartedAppPort } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
import { loadWebGettingStartedResults } from "../onboarding/GettingStartedPopover";

export const GETTING_STARTED_APP_PATH = "__getting-started__";
export const GETTING_STARTED_APP_TITLE = "Getting started";

const REQUEST_TIMEOUT_MS = 10_000;

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
  };
}
