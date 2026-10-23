import { z } from "zod/v4";
import { registerOpenClawSharedBrowserRelay, type SharedBrowserRelayApi } from "./openclaw-shared-browser-relay.js";
import { createOpenClawSharedBrowserRelayClient, type ResolveNativeGatewayAuth } from "./openclaw-shared-browser-relay-client.js";
const Config = z.object({ gatewayPort: z.number().int().min(1).max(65535).default(4000) }).strict();
/** Write this manifest alongside a package.json pointing openclaw.extensions at this compiled entry. */
export const OPENCLAW_SHARED_BROWSER_MANIFEST = {
  id: "matrix-shared-browser", name: "Matrix shared Chrome", version: "1.0.0",
  description: "Run-bound owner-gated control of the visible Matrix Chrome app.",
  activation: { onStartup: true },
  contracts: { tools: ["shared_browser"], gatewayMethodDispatch: ["authenticated-request"] },
  configSchema: z.toJSONSchema(Config),
};
export function createOpenClawSharedBrowserPlugin(resolveNativeAuth?: ResolveNativeGatewayAuth) {
  return {
    id: "matrix-shared-browser", name: "Matrix shared Chrome",
    register(api: SharedBrowserRelayApi & { pluginConfig?: unknown; config?: unknown }) {
      if (process.env.MATRIX_BROWSER_LAB !== "true") return;
      const config = Config.parse(api.pluginConfig ?? {});
      registerOpenClawSharedBrowserRelay(api, {
        rpc: createOpenClawSharedBrowserRelayClient(api.config, undefined, resolveNativeAuth),
        ...config,
        ...(process.env.MATRIX_BROWSER_DIAGNOSTICS === "1" ? {
          onDiagnostic: (event: unknown) => console.warn("[shared-browser-openclaw] lifecycle", JSON.stringify(event)),
        } : {}),
      });
    },
  };
}
export default createOpenClawSharedBrowserPlugin();
