/** Mount canonical Chat, provider and collaboration routes after startup. */
import type { Context, Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { AiProviderService } from "../ai-providers/service.js";
import { createAiProviderRoutes } from "../ai-providers/routes.js";
import { ProviderSettingsStore } from "../ai-providers/provider-settings-store.js";
import type { GmailAccountRow } from "../chat/jev-recipe-authority.js";
import { createProviderSettingsRoutes } from "../ai-providers/provider-settings-routes.js";
import { createChatAgentRoutes } from "../chat/agent-routes.js";
import { registerCanonicalChatEventHttpRoute } from "../chat/event-http-route.js";
import { registerCanonicalChatEventWebSocketRoute } from "../chat/event-websocket-route.js";
import { createGatewayChatEventStream } from "../chat/gateway-event-stream.js";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import { createChatProviderRoutes } from "../chat/provider-routes.js";
import { createGatewayChatProviderCatalog } from "../chat/runtime-provider-catalog.js";
import { createCanonicalChatRuntime } from "../chat/runtime.js";
import { createCanonicalChatRoutes } from "../chat/routes.js";
import { createCanonicalChatService, createUnavailableCanonicalChatService } from "../chat/service.js";
import { ChatSharing } from "../chat/sharing.js";
import { createChatSharingRoutes } from "../chat/sharing-routes.js";
import type { ChatExecutionRootResolver } from "../chat/execution-root.js";
import type { OwnerToolOutputProjection } from "../chat/owner-tool-output.js";
import type { ChatRepository } from "../chat/repository.js";
import { createDiscussionOnlyChatExecutionGuard } from "../collaboration/chat-scope.js";
import type { GatewayCollaborationConfigurationFailure, GatewayCollaborationRuntime } from "../collaboration/wiring.js";
import { requireRequestPrincipal } from "../request-principal.js";
import { registerOwnerCollaborationRoutes } from "../startup/collaboration.js";

export interface CollaborationChatRouteOptions {
  app: Hono;
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];
  canonicalChatEventStream: ReturnType<typeof createGatewayChatEventStream> | null;
  chatRepository: ChatRepository | null;
  gatewayCollaboration: GatewayCollaborationRuntime | null;
  collaborationFailClosedReason: GatewayCollaborationConfigurationFailure | null;
  canonicalChatOrchestrator: CanonicalChatOrchestrator | null;
  canonicalChatExecutionRoots: ChatExecutionRootResolver | null;
  canonicalChatCollaborationGuard: ReturnType<typeof createDiscussionOnlyChatExecutionGuard> | null;
  projectOwnerToolOutput: OwnerToolOutputProjection;
  canonicalChatRuntime: Awaited<ReturnType<typeof createCanonicalChatRuntime>> | null;
  canonicalChatProviderCatalog: ReturnType<typeof createGatewayChatProviderCatalog>["catalog"];
  aiProviderService: AiProviderService;
  providerSettingsStore: ProviderSettingsStore;
  listGmailAccounts?: (ownerId: string) => Promise<readonly GmailAccountRow[]>;
}

export function registerCollaborationChatRoutes(options: CollaborationChatRouteOptions): void {
  const { app, upgradeWebSocket, canonicalChatEventStream, chatRepository,
    gatewayCollaboration, collaborationFailClosedReason, canonicalChatOrchestrator,
    canonicalChatExecutionRoots, canonicalChatCollaborationGuard, projectOwnerToolOutput,
    canonicalChatRuntime, canonicalChatProviderCatalog, aiProviderService,
    providerSettingsStore, listGmailAccounts } = options;
  if (canonicalChatEventStream) {
    registerCanonicalChatEventWebSocketRoute({
      app,
      upgradeWebSocket,
      getPrincipal: (context) => requireRequestPrincipal(context as Context),
      stream: canonicalChatEventStream,
    });
    registerCanonicalChatEventHttpRoute({
      app,
      getPrincipal: (context) => requireRequestPrincipal(context as Context),
      stream: canonicalChatEventStream,
    });
  }
  app.route("/", createChatSharingRoutes(chatRepository ? new ChatSharing(chatRepository.kysely) : null));
  registerOwnerCollaborationRoutes({ app, upgradeWebSocket, gatewayCollaboration, collaborationFailClosedReason });
  app.route("/", createCanonicalChatRoutes({
    service: chatRepository
        ? createCanonicalChatService(chatRepository, {
          projectOwnerToolOutput,
          ...(canonicalChatOrchestrator ? { orchestrator: canonicalChatOrchestrator } : {}),
          ...(canonicalChatExecutionRoots ? { executionRoots: canonicalChatExecutionRoots } : {}),
          ...(canonicalChatCollaborationGuard ? { collaborationGuard: canonicalChatCollaborationGuard } : {}),
        })
      : createUnavailableCanonicalChatService(),
    getPrincipal: (c) => requireRequestPrincipal(c),
  }));
  app.route("/", createChatAgentRoutes({
    ...(canonicalChatRuntime && chatRepository ? {
      agents: canonicalChatRuntime.agents,
      context: canonicalChatRuntime.context,
      recipes: canonicalChatRuntime.recipes,
      repository: chatRepository,
    } : {}),
    enabled: () => true,
    catalog: canonicalChatProviderCatalog,
    listGmailAccounts,
    getPrincipal: (c) => requireRequestPrincipal(c),
  }));
  app.route("/", createChatProviderRoutes({
    catalog: canonicalChatProviderCatalog,
    getPrincipal: (c) => requireRequestPrincipal(c),
  }));
  app.route("/api/ai", createAiProviderRoutes({
    service: aiProviderService,
    getPrincipal: (c) => requireRequestPrincipal(c),
  }));
  app.route("/api/ai", createProviderSettingsRoutes({
    store: providerSettingsStore,
    getPrincipal: (c) => requireRequestPrincipal(c),
  }));

}
