import { z } from "zod/v4";
import { openHeldLaunchChannel, type HeldLaunchChannel, type HeldLaunchOptions } from "./held-launch-channel.js";

// Strict correlation-only pipe frames. No native/owner/policy/source identity.
const id = z.uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const correlation = { requestId: id, nonce: digest };
const handshake = { v: z.literal(1), keeper: id, channel: id, digest };
const deadlinePattern = /^[1-9][0-9]{0,19}$/;
const deadlineNs = z.string().regex(deadlinePattern).refine(value => deadlinePattern.test(value) && BigInt(value) <= 18446744073709551615n);
const KeeperReadySchema = z.object({ ...handshake, type: z.literal("workspace.keeper.ready") }).strict();
export const WorkspaceHostFrameSchema = z.discriminatedUnion("type", [
  z.object({ ...handshake, type: z.literal("workspace.host.ready") }).strict(),
  z.object({ v: z.literal(1), type: z.literal("workspace.fence"), ...correlation, deadlineNs }).strict(),
  z.object({ v: z.literal(1), type: z.literal("workspace.disconnect") }).strict(),
]);
export const WorkspaceKeeperFrameSchema = z.discriminatedUnion("type", [
  KeeperReadySchema,
  // ACK never promises native stop, listener/session readiness or dispatch.
  z.object({ v: z.literal(1), type: z.literal("workspace.fenced"), ...correlation, outcome: z.literal("unknown") }).strict(),
  z.object({ v: z.literal(1), type: z.literal("workspace.end") }).strict(),
]);
export type WorkspaceHostFrame = z.infer<typeof WorkspaceHostFrameSchema>;
export type WorkspaceKeeperFrame = z.infer<typeof WorkspaceKeeperFrameSchema>;
export type WorkspaceLaunchChannel = HeldLaunchChannel<WorkspaceHostFrame, WorkspaceKeeperFrame>;
export function openWorkspaceLaunchChannel(options: HeldLaunchOptions): Promise<WorkspaceLaunchChannel> {
  return openHeldLaunchChannel(options, {
    hostSchema: WorkspaceHostFrameSchema, childSchema: WorkspaceKeeperFrameSchema,
    handshakeSchema: KeeperReadySchema.transform(frame => ({ generation: `${frame.keeper}:${frame.channel}`, digest: frame.digest, reply: { ...frame, type: "workspace.host.ready" as const } })),
    readyTypes: ["workspace.keeper.ready"], endTypes: ["workspace.end"],
  });
}
