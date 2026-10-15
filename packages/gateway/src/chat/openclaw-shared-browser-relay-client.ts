import { z } from "zod/v4";
import { createOpenClawRpcClient } from "../agent-config/openclaw-rpc.js";

const NativeGateway = z.object({ gateway: z.object({
  mode: z.literal("local").optional(), bind: z.literal("loopback"), port: z.literal(18789).optional(),
  tls: z.object({ enabled: z.literal(false).optional() }).passthrough().optional(),
  auth: z.object({ mode: z.literal("token"), token: z.string().regex(/^[a-fA-F0-9]{64}$/), password: z.never().optional() }).passthrough(),
}).passthrough() });
/** Only the native harness's existing authenticated loopback gateway is eligible. */
export function createOpenClawSharedBrowserRelayClient(config: unknown, createClient: typeof createOpenClawRpcClient = createOpenClawRpcClient) {
  const parsed = NativeGateway.safeParse(config);
  if (!parsed.success) throw new Error("Native browser connection unavailable");
  return createClient({ url: "ws://127.0.0.1:18789/", token: parsed.data.gateway.auth.token, maxPending: 8, timeoutMs: 10_000 });
}
