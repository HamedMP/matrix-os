import { z } from "zod/v4";

export const DesktopRuntimePolicySchema = z.object({
  agentExecution: z.object({
    mode: z.literal("cloud"),
    localAgentsAllowed: z.literal(false),
  }),
  capabilities: z.array(z.string().min(1)).max(32),
  gatewayHealth: z.enum(["healthy", "degraded", "unreachable"]),
  instance: z.object({
    shellUrl: z.string().url(),
    gatewayUrl: z.string().url(),
    version: z.string().min(1).max(64),
  }),
  version: z.literal(1),
});

export type DesktopRuntimePolicyResponse = z.infer<typeof DesktopRuntimePolicySchema>;
