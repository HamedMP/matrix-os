import type { GetStartedUpdate } from "@matrix-os/contracts";
import type { GetStartedPort } from "@matrix-os/ui";
import type { ApiClient } from "../../lib/api";

const PATH = "/api/settings/get-started";
const REQUEST_TIMEOUT_MS = 10_000;

/** Bound to the computer the wizard started on, so a queued save never lands on another runtime. */
export function createDesktopGetStartedPort(api: ApiClient, runtimeSlot: string): GetStartedPort {
  const runtime = api.forRuntime(runtimeSlot);
  return {
    load: (signal) => runtime.get<unknown>(PATH, { cache: "no-store", signal, timeoutMs: REQUEST_TIMEOUT_MS, omitErrorBody: true }),
    save: (update: GetStartedUpdate) => runtime.put<unknown>(PATH, update, { timeoutMs: REQUEST_TIMEOUT_MS, omitErrorBody: true }),
  };
}
