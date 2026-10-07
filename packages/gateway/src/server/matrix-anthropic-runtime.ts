import type { Context, Hono } from "hono";
import { createMatrixAnthropicSourceStore } from "../ai-providers/matrix-anthropic-source.js";
import { createMatrixAnthropicConnectionService } from "../ai-providers/matrix-anthropic-connection.js";
import { createMatrixAnthropicConnectionRoutes } from "../ai-providers/matrix-anthropic-connection-routes.js";
import type { NativeProviderProfileGuard } from "../ai-providers/native-provider-profile-guard.js";
import type { AiProviderSnapshotReader } from "../ai-providers/service.js";

/** Private composition seam. Callers explicitly qualify ordinary and recipe runtime capabilities. */
export function createMatrixAnthropicRuntime(options: {
  app: Hono; homePath: string | null; ownerId: string | null; profileGuard: NativeProviderProfileGuard | null;
  getPrincipal: (context: Context) => { userId: string } | null;
  supports: { rootChat: boolean; recipeBots: boolean }; readOnly?: boolean; onSourceChanged?: () => void; fetch?: typeof fetch;
  providerSnapshotReader?: AiProviderSnapshotReader;
}) {
  const service = options.homePath && options.ownerId && options.profileGuard ? createMatrixAnthropicConnectionService({
    homePath: options.homePath, ownerId: options.ownerId, sourceStore: createMatrixAnthropicSourceStore({ homePath: options.homePath, profileGuard: options.profileGuard }),
    supports: options.supports, readOnly: options.readOnly, onSourceChanged: options.onSourceChanged, fetch: options.fetch,
  }) : null;
  options.app.route("/api/ai", createMatrixAnthropicConnectionRoutes({ ownerId: options.ownerId, service, getPrincipal: options.getPrincipal, providerSnapshotReader: options.providerSnapshotReader }));
  return { service, close: async () => { await service?.shutdown(); } };
}
