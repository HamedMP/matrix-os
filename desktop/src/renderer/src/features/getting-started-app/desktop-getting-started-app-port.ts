/** Gateway port and tab for the Getting started app on Electron Desktop (spec 639). */
import {
  GettingStartedAppAutoOpenResponseSchema,
  GettingStartedAppAwardResponseSchema,
  GettingStartedAppDesktopIconResponseSchema,
  GettingStartedAppProgressSchema,
  gettingStartedAppLogos,
} from "@matrix-os/contracts";
import type { GettingStartedAppPort } from "@matrix-os/ui";
import type { ApiClient } from "../../lib/api";
import { bundledDesktopIconForPath } from "../desktop-shell/bundled-app-icons";
import { loadGettingStartedResults } from "../onboarding/getting-started";

export const GETTING_STARTED_PATH = "__getting-started__";

export const GETTING_STARTED_TAB = {
  kind: "getting-started" as const,
  title: "Getting started",
  icon: bundledDesktopIconForPath(GETTING_STARTED_PATH),
};

function httpStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && "httpStatus" in error && typeof error.httpStatus === "number"
    ? error.httpStatus
    : undefined;
}

export function createDesktopGettingStartedAppPort(api: Pick<ApiClient, "get" | "post" | "forRuntime">): GettingStartedAppPort {
  return {
    loadResults: (signal) => loadGettingStartedResults(api, signal),
    async loadProgress(signal) {
      try {
        return GettingStartedAppProgressSchema.parse(await api.get("/api/getting-started/progress", { signal }));
      } catch (error: unknown) {
        if (httpStatus(error) === 404) return null;
        throw error;
      }
    },
    async award(taskId, silent, signal) {
      return GettingStartedAppAwardResponseSchema.parse(await api.post("/api/getting-started/awards", { taskId, silent }, signal ? { signal } : undefined));
    },
    async claimAutoOpen(signal) {
      return GettingStartedAppAutoOpenResponseSchema.parse(await api.post("/api/getting-started/auto-open", {}, signal ? { signal } : undefined)).open;
    },
    async desktopIconPlaced(signal) {
      return GettingStartedAppDesktopIconResponseSchema.parse(await api.get("/api/getting-started/desktop-icon", signal ? { signal } : undefined)).placed;
    },
    async markDesktopIconPlaced(signal) {
      GettingStartedAppDesktopIconResponseSchema.parse(await api.post("/api/getting-started/desktop-icon", {}, signal ? { signal } : undefined));
    },
    async loadLogos(signal) {
      return gettingStartedAppLogos(await api.get("/api/integrations/available", { signal }));
    },
  };
}
