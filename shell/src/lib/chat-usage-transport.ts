import { createChatUsageClient, ChatUsageUnavailable } from "@matrix-os/ui";
import { boundedProviderSettingsJson } from "./provider-settings-transport";
import { getGatewayUrl } from "./gateway";

export function createWebChatUsageClient(options: { fetcher?: typeof fetch; isIdentityCurrent: () => boolean }) {
  return createChatUsageClient(async input => {
    if (!options.isIdentityCurrent() || input.signal.aborted) throw new ChatUsageUnavailable();
    const response = await (options.fetcher ?? globalThis.fetch).call(globalThis, `${getGatewayUrl()}${input.path}`, {
      method: input.method, credentials: "include", cache: "no-store",
      headers: { Accept: "application/json", ...(input.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]),
    });
    try {
      if (!response.ok || !options.isIdentityCurrent() || input.signal.aborted) throw new ChatUsageUnavailable();
      return await boundedProviderSettingsJson(response, 262_144);
    } finally {
      if (!response.bodyUsed) await response.body?.cancel();
    }
  }, options.isIdentityCurrent);
}
