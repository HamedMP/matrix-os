import type { GetStartedBotNamesRequest, GetStartedUpdate } from "@matrix-os/contracts";
import type { GetStartedGalleryPort, GetStartedPort } from "@matrix-os/ui";
import { appIconUrl } from "../apps/app-icons";
import type { ApiClient } from "../../lib/api";

const PATH = "/api/settings/get-started";
const REQUEST_TIMEOUT_MS = 10_000;
/** The wizard gives up on name suggestions after 12 s and shows built-in names. */
const BOT_NAMES_TIMEOUT_MS = 12_000;

/** Bound to the computer the wizard started on, so a queued save never lands on another runtime. */
export function createDesktopGetStartedPort(api: ApiClient, runtimeSlot: string): GetStartedPort {
  const runtime = api.forRuntime(runtimeSlot);
  return {
    load: (signal) => runtime.get<unknown>(PATH, { cache: "no-store", signal, timeoutMs: REQUEST_TIMEOUT_MS, omitErrorBody: true }),
    save: (update: GetStartedUpdate) => runtime.put<unknown>(PATH, update, { timeoutMs: REQUEST_TIMEOUT_MS, omitErrorBody: true }),
    suggestBotNames: (request: GetStartedBotNamesRequest, signal) => runtime.post<unknown>(`${PATH}/bot-names`, request, { signal, timeoutMs: BOT_NAMES_TIMEOUT_MS, omitErrorBody: true }),
  };
}

const GALLERY_APP_ID = /^[a-z][a-z0-9-]{0,47}$/;

/** App Gallery for the wizard's "Apps that work with your tools" step, on the wizard's runtime. */
export function createDesktopGetStartedGalleryPort(api: ApiClient, runtimeSlot: string, platformHost: string): GetStartedGalleryPort {
  const runtime = api.forRuntime(runtimeSlot);
  return {
    list: (signal) => runtime.get<unknown>("/api/app-gallery", { cache: "no-store", signal, timeoutMs: REQUEST_TIMEOUT_MS, omitErrorBody: true }),
    install: async (id) => {
      if (!GALLERY_APP_ID.test(id)) throw new Error("InvalidGalleryAppId");
      return runtime.post<unknown>(`/api/app-gallery/${id}/install`, {}, { timeoutMs: REQUEST_TIMEOUT_MS, omitErrorBody: true });
    },
    iconUrl: (id) => appIconUrl(platformHost, `gallery-${id}`, runtimeSlot) ?? "",
  };
}
