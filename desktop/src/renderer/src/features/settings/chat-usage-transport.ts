import { createChatUsageClient } from "@matrix-os/ui";
import type { ApiClient } from "../../lib/api";

export function createDesktopChatUsageClient(api: ApiClient, isIdentityCurrent: () => boolean) {
  return createChatUsageClient(async input => {
    const options = { maxBytes: 262_144, timeoutMs: 10_000, signal: input.signal, cache: "no-store" as const, omitErrorBody: true };
    if (input.method === "GET") return api.get<unknown>(input.path, options);
    if (input.method === "PUT") return api.put<unknown>(input.path, input.body, options);
    return api.delete<unknown>(input.path, input.body, options);
  }, isIdentityCurrent);
}
