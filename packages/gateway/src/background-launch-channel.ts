import { z } from "zod/v4";
import { openHeldLaunchChannel, type HeldLaunchChannel, type HeldLaunchSpawn } from "@matrix-os/terminal-runtime/held-launch-channel";
export type { HeldLaunchChannel } from "@matrix-os/terminal-runtime/held-launch-channel";
import { TerminalHostFrameSchema, TerminalShimFrameSchema, type TerminalHostFrame, type TerminalShimFrame } from "./coding-agents/terminal-launch-protocol.mjs";
import { fileURLToPath } from "node:url";
import { ManagedHostFrameSchema, ManagedShimFrameSchema, parseManagedFrame, type ManagedHostFrame, type ManagedShimFrame } from "./coding-agents/managed-launch-protocol.mjs";
import type { AgentLaunchSpec } from "./agent-launcher.js";
export type ManagedLaunchChannel = HeldLaunchChannel<ManagedHostFrame, ManagedShimFrame>;
export type TerminalLaunchChannel = HeldLaunchChannel<TerminalHostFrame, TerminalShimFrame>;
export interface BackgroundPrivateControl { onReady(channel: ManagedLaunchChannel): void }
export type PrivateLaunchSpawn = HeldLaunchSpawn;
const ownedShim = fileURLToPath(new URL("./coding-agents/codex-app-server-runner.mjs", import.meta.url));
/** Binding is the inherited anonymous pipe held by this exact spawned systemd client, not a bg ID or socket path. */
export function validPrivateLaunch(launch: AgentLaunchSpec): boolean {
  return launch.command === process.execPath && launch.args[0] === ownedShim;
}
type LaunchChannelOptions = { args: string[]; digest: string; env: NodeJS.ProcessEnv; spawn?: PrivateLaunchSpawn };
export function openBackgroundLaunchChannel(options: LaunchChannelOptions): Promise<ManagedLaunchChannel> {
  return openHeldLaunchChannel(options, {
    hostSchema: ManagedHostFrameSchema, childSchema: ManagedShimFrameSchema, parseFrame: parseManagedFrame,
    handshakeSchema: ManagedShimFrameSchema.transform((frame, context) => {
      if (frame.type !== "wrapper.ready") { context.addIssue({ code: "custom", message: "Private launch unavailable" }); return z.NEVER; }
      return { generation: frame.wrapper + ":" + frame.shim, digest: frame.digest, reply: { ...frame, type: "host.ready" as const } };
    }),
    readyTypes: ["wrapper.ready", "shim.ready"], endTypes: ["wrapper.end"],
  });
}
export function openTerminalLaunchChannel(options: LaunchChannelOptions): Promise<TerminalLaunchChannel> {
  return openHeldLaunchChannel(options, {
    hostSchema: TerminalHostFrameSchema, childSchema: TerminalShimFrameSchema, parseFrame: parseManagedFrame,
    handshakeSchema: TerminalShimFrameSchema.transform((frame, context) => {
      if (frame.type !== "wrapper.ready") { context.addIssue({ code: "custom", message: "Private launch unavailable" }); return z.NEVER; }
      return { generation: frame.wrapper + ":" + frame.shim, digest: frame.digest, reply: { ...frame, type: "host.ready" as const } };
    }),
    readyTypes: ["wrapper.ready", "shim.ready"], endTypes: ["wrapper.end"],
  });
}
