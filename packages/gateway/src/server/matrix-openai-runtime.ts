import type { Context, Hono } from "hono";
import { createMatrixOpenAiSourceStore } from "../ai-providers/matrix-openai-source.js";
import { createMatrixOpenAiConnectionService } from "../ai-providers/matrix-openai-connection.js";
import { createMatrixOpenAiConnectionRoutes } from "../ai-providers/matrix-openai-connection-routes.js";
import type { NativeProviderProfileGuard } from "../ai-providers/native-provider-profile-guard.js";
import type { AiProviderSnapshotReader } from "../ai-providers/service.js";

/** Private composition seam. Callers explicitly qualify ordinary and recipe runtime capabilities. */
export function createMatrixOpenAiRuntime(options: {
  app: Hono; homePath: string | null; ownerId: string | null; profileGuard: NativeProviderProfileGuard | null;
  getPrincipal: (context: Context) => { userId: string } | null;
  supports: { rootChat: boolean; recipeBots: boolean }; readOnly?: boolean; onSourceChanged?: () => void; fetch?: typeof fetch;
  providerSnapshotReader?: AiProviderSnapshotReader;
}) {
  const service = options.homePath && options.ownerId && options.profileGuard ? createMatrixOpenAiConnectionService({
    homePath: options.homePath, ownerId: options.ownerId, sourceStore: createMatrixOpenAiSourceStore({ homePath: options.homePath, profileGuard: options.profileGuard }),
    supports: options.supports, readOnly: options.readOnly, onSourceChanged: options.onSourceChanged, fetch: options.fetch,
  }) : null;
  options.app.route("/api/ai", createMatrixOpenAiConnectionRoutes({ ownerId: options.ownerId, service, getPrincipal: options.getPrincipal, providerSnapshotReader: options.providerSnapshotReader }));
  return { service, close: async () => { await service?.shutdown(); } };
}
