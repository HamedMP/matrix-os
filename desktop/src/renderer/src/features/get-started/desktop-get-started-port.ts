import type { GetStartedUpdate } from "@matrix-os/contracts";
import type { GetStartedPort } from "@matrix-os/ui";
import type { ApiClient } from "../../lib/api";

const PATH = "/api/settings/get-started";
const REQUEST_TIMEOUT_MS = 10_000;

export function createDesktopGetStartedPort(api: ApiClient): GetStartedPort {
  return {
    load: (signal) => api.get<unknown>(PATH, { cache: "no-store", signal, timeoutMs: REQUEST_TIMEOUT_MS, omitErrorBody: true }),
    save: (update: GetStartedUpdate) => api.put<unknown>(PATH, update, { timeoutMs: REQUEST_TIMEOUT_MS, omitErrorBody: true }),
  };
}
