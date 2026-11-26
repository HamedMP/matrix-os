import type { BotStateTransactions } from "../bots/events.js";
import type { BotIntegrationClient } from "../bots/integration-client.js";
import type { BotGitHubReviewRepository } from "../bots/resource-grant-candidates.js";
import type { RoutedSlackDependencies } from "../slack/agent-route-jobs.js";
import { attestsSlackAgentRoute, createSlackAgentRouteResolver, type SlackAgentRouteSnapshot } from "../slack/agent-routes.js";
import { createSlackOwnerClient } from "./slack-owner-client.js";
import type { SlackBotPlatform } from "./slack-platform.js";

export function createSlackAgentRouteLane(options: {
  platform?: SlackBotPlatform | null;
  ownerId?: string | null;
  computerId?: string | null;
  github?: Pick<BotIntegrationClient, "call" | "inventory">;
  repository?: BotGitHubReviewRepository;
  transact: BotStateTransactions;
  isActiveManagedAgent(ownerId: string, agentId: string): Promise<boolean>;
  listChannels?: ReturnType<typeof createSlackOwnerClient>["listAgentRouteChannels"];
}) {
  const { platform, ownerId, transact, isActiveManagedAgent } = options;
  const target = platform?.devTarget;
  if (!platform || !target?.agentRoutes || !ownerId || platform.runtimeSlot !== "dev" || target.ownerId !== ownerId
    || target.machineId !== platform.machineId || target.handle !== platform.handle || options.computerId !== target.handle) return;
  const listChannels = options.listChannels ?? createSlackOwnerClient(platform).listAgentRouteChannels;
  const resolver = createSlackAgentRouteResolver({ ownerId, runtimeId: platform.machineId, transact, isActiveManagedAgent });
  const github = options.repository ? options.github : undefined;
  function repositoryAllowed(route: SlackAgentRouteSnapshot) {
    return route.kind === "summary" || Boolean(github && route.github && options.repository
      && route.github.repositoryId === options.repository.repositoryId && route.github.fullName === options.repository.fullName);
  }
  const worker: RoutedSlackDependencies = {
    github,
    async resolve(event, tx) {
      const route = await resolver.resolve(event, tx);
      return route && repositoryAllowed(route) ? route : null;
    },
    async current(route, tx) {
      return repositoryAllowed(route) && resolver.current(route, tx);
    },
    async verifySource(route, signal) {
      if (!repositoryAllowed(route)) return false;
      return attestsSlackAgentRoute(route, await listChannels(signal, route.channelId));
    },
  };
  return { listChannels, worker };
}
