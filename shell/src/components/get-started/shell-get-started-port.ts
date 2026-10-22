import type { GetStartedUpdate } from "@matrix-os/contracts";
import type { GetStartedPort } from "@matrix-os/ui";

const REQUEST_TIMEOUT_MS = 10_000;

class GetStartedRequestError extends Error {
  override readonly name = "GetStartedRequestError";
  constructor(readonly status: number) {
    super(`GetStartedRequestFailed:${status}`);
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new GetStartedRequestError(response.status);
  return await response.json();
}

export function createShellGetStartedPort(gatewayUrl: string): GetStartedPort {
  const url = `${gatewayUrl}/api/settings/get-started`;
  return {
    load: async (signal) => readJson(await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })),
    save: async (update: GetStartedUpdate) => readJson(await fetch(url, {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(update),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })),
  };
}
