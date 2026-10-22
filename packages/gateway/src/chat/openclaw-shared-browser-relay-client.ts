import { z } from "zod/v4";
import { createOpenClawRpcClient } from "../agent-config/openclaw-rpc.js";

const NativeGateway = z.object({ gateway: z.object({
  mode: z.literal("local").optional(), bind: z.literal("loopback"), port: z.literal(18789).optional(),
  tls: z.object({ enabled: z.literal(false).optional() }).passthrough().optional(),
  auth: z.object({ mode: z.literal("token"), token: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(), password: z.never().optional() }),
}).passthrough() });
export type ResolveNativeGatewayAuth = (params: {
  authConfig: { mode: "token"; token?: string }; tailscaleMode: "off";
}) => unknown;
const ResolvedAuth = z.object({ mode: z.literal("token"), token: z.string().regex(/^[a-fA-F0-9]{64}$/), password: z.never().optional() });
const unavailableMessage = "Native browser connection unavailable";
/** Only the native harness's existing authenticated loopback gateway is eligible. */
export function createOpenClawSharedBrowserRelayClient(
  config: unknown,
  createClient: typeof createOpenClawRpcClient = createOpenClawRpcClient,
  resolveNativeAuth?: ResolveNativeGatewayAuth,
) {
  const parsed = NativeGateway.safeParse(config);
  if (!parsed.success) throw new Error(unavailableMessage);
  let resolved: unknown;
  try {
    // The native SDK owns config-first precedence and its own gateway environment.
    resolved = resolveNativeAuth
      ? resolveNativeAuth({ authConfig: parsed.data.gateway.auth, tailscaleMode: "off" })
      : parsed.data.gateway.auth;
  } catch (error) {
    // Native resolver exceptions may contain secrets; log only a fixed category.
    console.warn("[shared-browser] Native resolver unavailable", error instanceof Error ? "error" : "non_error");
    if (error instanceof Error && error.message === unavailableMessage) throw error;
    throw new Error(unavailableMessage);
  }
  const auth = ResolvedAuth.safeParse(resolved);
  if (!auth.success) throw new Error(unavailableMessage);
  return createClient({ url: "ws://127.0.0.1:18789/", token: auth.data.token, maxPending: 8, timeoutMs: 10_000 });
}
