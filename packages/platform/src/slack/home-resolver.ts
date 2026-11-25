import { z } from "zod/v4";
import { ActorIdSchema, OrganizationIdSchema, SlackTeamIdSchema, SlackUserIdSchema } from "./types.js";

const DevAcceptanceSchema = z.strictObject({
  handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,58}-dev$/),
  machineId: z.uuid(),
  ownerId: ActorIdSchema,
  organizationId: OrganizationIdSchema,
  teamId: SlackTeamIdSchema,
  channelId: z.string().regex(/^C[A-Z0-9]{2,63}$/),
  ownerSlackId: SlackUserIdSchema,
});
export type SlackDevAcceptance = z.infer<typeof DevAcceptanceSchema>;

export function loadSlackDevAcceptance(env: NodeJS.ProcessEnv): { target: SlackDevAcceptance; bridgeToken: string } | undefined {
  if ([env.SLACK_DEV_ACCEPTANCE, env.SLACK_DEV_BRIDGE_TOKEN, env.SLACK_DEV_THREAD_CONTEXT_GRANT].every(value => value === undefined)) return undefined;
  if (env.PLATFORM_PREVIEW !== "true" || env.SLACK_PREVIEW_RUNTIME_HANDLE || env.SLACK_PREVIEW_THREAD_CONTEXT_GRANT || env.SLACK_PREVIEW_MENTION_SUMMARY_RULE) {
    throw new Error("Slack Dev target requires a dedicated preview platform");
  }
  const scope = DevAcceptanceSchema.parse(JSON.parse(env.SLACK_DEV_ACCEPTANCE ?? ""));
  return { target: scope, bridgeToken: z.string().regex(/^[0-9a-f]{64}$/).parse(env.SLACK_DEV_BRIDGE_TOKEN) };
}

/** Preview Slack routes must never fall back to a user's primary computer. */
export function loadSlackPreviewHandle(env: NodeJS.ProcessEnv): string | undefined {
  const handle = env.SLACK_PREVIEW_RUNTIME_HANDLE?.trim();
  if (env.PLATFORM_PREVIEW === "true") {
    if (!handle || !/^pr-[1-9][0-9]{0,8}$/.test(handle)) throw new Error("Slack preview target unavailable");
    return handle;
  }
  if (handle) throw new Error("Slack preview target requires preview platform");
  return undefined;
}

export interface SlackMachine {
  machineId: string; handle: string; runtimeSlot: string; provisioningClass: string;
  clerkUserId: string; status: string; publicIPv4: string | null; deletedAt: string | null;
}
interface SlackDirectoryRoute {
  kind: string; organizationId: string | null; runtimeId: string; ownerId: string;
}

export function isSlackMachineAvailable(machine: SlackMachine | undefined, previewHandle?: string): machine is SlackMachine {
  return !!machine && machine.status === "running" && !!machine.publicIPv4 && !machine.deletedAt
    && (!previewHandle || (machine.handle === previewHandle && machine.runtimeSlot === previewHandle && machine.provisioningClass === "preview"));
}

export function isSlackDevMachineAvailable(machine: SlackMachine | undefined, target: SlackDevAcceptance): machine is SlackMachine {
  return isSlackMachineAvailable(machine) && machine.machineId === target.machineId && machine.handle === target.handle
    && machine.clerkUserId === target.ownerId && machine.runtimeSlot === "dev" && machine.provisioningClass === "customer";
}

export function createSlackMachineResolver(options: {
  previewHandle?: string;
  devAcceptance?: SlackDevAcceptance;
  findDirectoryRoute(scopeId: string): Promise<SlackDirectoryRoute | null | undefined>;
  findMachineById(machineId: string): Promise<SlackMachine | undefined>;
  findPersonalMachine(actorId: string, runtimeSlot?: string): Promise<SlackMachine | undefined>;
}) {
  return async (actorId: string, scopeId?: string, organizationId?: string): Promise<SlackMachine> => {
    const dev = options.devAcceptance;
    if (dev) {
      if (actorId !== dev.ownerId || scopeId !== undefined || (organizationId !== undefined && organizationId !== dev.organizationId)) {
        throw new Error("Slack home unavailable");
      }
      const machine = await options.findMachineById(dev.machineId);
      if (!isSlackDevMachineAvailable(machine, dev)) throw new Error("Slack home unavailable");
      return machine;
    }
    let machine: SlackMachine | undefined;
    if (scopeId) {
      const route = await options.findDirectoryRoute(scopeId);
      if (!route || route.kind !== "project" || route.organizationId !== organizationId) throw new Error("Slack home unavailable");
      const id = /^vps:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(route.runtimeId)?.[1];
      machine = id ? await options.findMachineById(id) : undefined;
      if (!machine || machine.clerkUserId !== route.ownerId) throw new Error("Slack home unavailable");
    } else {
      machine = await options.findPersonalMachine(actorId, options.previewHandle);
      if (!machine || machine.clerkUserId !== actorId) throw new Error("Slack home unavailable");
    }
    if (!isSlackMachineAvailable(machine, options.previewHandle)) throw new Error("Slack home unavailable");
    return machine;
  };
}
