import { tryLoadToolOutputKey } from "./coding-agents/protected-tool-output.mjs";
import { createOwnerToolOutputProjection } from "./chat/owner-tool-output.js";
import { createProjectChatCleanup } from "./chat/project-deletion.js";
import { createRuntimeAppAiRoutes } from "./app-ai/runtime.js";
import { restoreBackgroundChatThread, createBackgroundChatProjection } from "./coding-agents/background-chat-recovery.js";
import { createBackgroundAgentRuntime } from "./background-agent-runtime.js";
import { ChatSharing } from "./chat/sharing.js";
import { withAsyncChatInput } from "./chat/async-input-adapter.js";
import { createChatSharingRoutes } from "./chat/sharing-routes.js";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import {
  appendFile as appendFileAsync,
  mkdir as mkdirAsync,
  writeFile as writeFileAsync,
} from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { installPostHogHonoErrorTracking, resolveOwnerTelemetryDistinctId } from "@matrix-os/observability";
import { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import { createDispatcher, type Dispatcher, type BatchEntry, type DispatchContext } from "./dispatcher.js";
import {
  createFundedAiCredentialManager,
  loadFundedAiRuntimeConfig,
} from "./funded-ai-credential-manager.js";
import { createFundedAiFundingSummaryClient } from "./funded-ai-funding-summary-client.js";
import { createFundedAiReadinessReader } from "./funded-ai-readiness.js";
import { createGatewaySpeechRuntime } from "./speech/gateway-runtime.js";
import { buildKernelCredentialLaunch } from "./kernel-credentials.js";
import { createAllowedOriginController } from "./allowed-origins.js";
import { createAiGenerationRecorder } from "./ai-analytics.js";
import { createWatcher, type Watcher } from "./watcher.js";
import { createPtyHandler, type PtyMessage } from "./pty.js";
import { createConversationStore, type ConversationStore } from "./conversations.js";
import {
  createConversationLifecycle,
  providerResumeSessionId,
} from "./conversation-lifecycle.js";
import { createConversationContextResolver } from "./conversation-context.js";
import { createConversationMutationLock } from "./conversation-mutation-lock.js";
import { stampApprovalRequestForReplay } from "./conversation-approval-replay.js";
import { buildDispatchFailureReplayMessage } from "./conversation-dispatch-failure.js";
import {
  conversationHistoryRefreshRequired,
  ConversationRunRegistry,
  type ConversationRunMessage,
} from "./conversation-run-registry.js";
import {
  clearReconnectAbortTimersForSession as clearReconnectAbortTimers,
  drainReconnectableAbortEntries,
  replaceReconnectableAbortEntry,
  scheduleReconnectAbortTimersForDisconnectedClient,
  type ReconnectableAbortEntry,
} from "./conversation-reconnect-aborts.js";
import { summarizeConversation, saveSummary } from "./conversation-summary.js";
import { extractMemoriesLocal } from "./memory-extractor.js";
import { createWorkspaceRoutes } from "./workspace-routes.js";
import { createPreviewManager } from "./preview-manager.js";
import { createProjectManager } from "./project-manager.js";
import { createTaskManager } from "./task-manager.js";
import { createReviewStore } from "./review-store.js";
import { createElixirSymphonyProxyRoutes } from "./symphony/proxy.js";
import { createSymphonyRunner } from "./symphony-runner.js";
import { createAgentLauncher } from "./agent-launcher.js";
import { resolveAgentCredentialProbe } from "./onboarding/agent-credential-probe.js";
import { createAgentSessionManager } from "./agent-session-manager.js";
import { createAgentSandbox } from "./agent-sandbox.js";
import { createWorktreeManager } from "./worktree-manager.js";
import {
  createWorkspaceSessionOrchestrator,
  type WorkspaceSessionOrchestrator,
} from "./workspace-session-orchestrator.js";
import { createWorkspaceEventStore } from "./workspace-events.js";
import { createWorkspaceEventPublisher } from "./workspace-event-publisher.js";
import {
  createProviderLoginTerminalRegistry,
  createSessionRuntimeBridge,
} from "./session-runtime-bridge.js";
import { createTerminalLiveOwnership } from "./terminal-live-ownership.js";
import { createWorkspaceStartupRecovery } from "./workspace-startup-recovery.js";
import { createChannelManager, type ChannelManager } from "./channels/manager.js";
import { createOutboundQueue } from "./security/outbound-queue.js";
import { createRateLimiter } from "./security/rate-limiter.js";
import { timingSafeStringEquals } from "./security/timing-safe.js";
import { createTelegramAdapter, type TelegramAdapter } from "./channels/telegram.js";
import { createTelegramStream } from "./channels/telegram-stream.js";
import { createPushAdapter } from "./channels/push.js";
import { createSessionStore } from "./session-store.js";
import { formatForChannel } from "./channels/format.js";
import type { ChannelConfig, ChannelId } from "./channels/types.js";
import { createCronStore } from "./cron/store.js";
import { createCronService, type CronService } from "./cron/service.js";
import { createHeartbeatRunner, type HeartbeatRunner } from "./heartbeat/runner.js";
import {
  createHeartbeat,
  backupModule,
  restoreModule,
  checkModuleHealth,
  createWatchdog,
  createTask,
  listTasks,
  getTask,
  type Heartbeat,
  type Watchdog,
  type KernelEvent,
  loadHandle,
  createUsageTracker,
  createMemoryStore,
} from "@matrix-os/kernel";
import { createProvisioner } from "./provisioner.js";
import {
  authMiddleware,
  readPreviewTerminalOwner,
} from "./auth.js";
import {
  isRequestPrincipalError,
  mapRequestPrincipalError,
  ownerScopeFromPrincipal,
  requireRequestPrincipal,
  type RequestPrincipal,
} from "./request-principal.js";
import { createOnboardingHandler } from "./onboarding/ws-handler.js";
import { InMemoryReadinessRepository } from "./onboarding/readiness-repository.js";
import { createReadinessService } from "./onboarding/readiness-service.js";
import { ReadinessStatusCache } from "./onboarding/readiness-cache.js";
import type { ReadinessResponse } from "./onboarding/activation-contracts.js";
import { createReadinessRoutes } from "./onboarding/readiness-routes.js";
import { createHostToolPackInstaller, createToolPackService, InMemoryToolPackRepository } from "./onboarding/tool-packs.js";
import { createToolPackRoutes } from "./onboarding/tool-pack-routes.js";
import type { CodingSetupStatus } from "./onboarding/coding-setup.js";
import { createAgentCredentialStatusService } from "./onboarding/agent-credential-status.js";
import { createAgentCredentialRoutes } from "./onboarding/agent-credential-routes.js";
import { createCodingAgentRuntimeSummaryService } from "./coding-agents/runtime-summary.js";
import { createCodingAgentRoutes } from "./coding-agents/routes.js";
import { createCodingAgentThreadStore, createFakeCodingAgentProvider, type CodingAgentProviderAdapter, type CodingAgentThreadStore, type CodingAgentTurnStore } from "./coding-agents/thread-store.js";
import { createCodingAgentThreadStream, threadStreamFrameDataToString } from "./coding-agents/thread-stream.js";
import { createWorkspaceCodingAgentProviderSet } from "./coding-agents/workspace-provider.js";
import { createCodingHarnessCredentialResolver } from "./coding-agents/harness-credentials.js";
import { resolveWorkspaceProviderRuntime } from "./coding-agents/workspace-provider-config.js";
import { createCodingAgentSessionStopReconciler } from "./coding-agents/session-stop-reconciler.js";
import { createCodingAgentTurnLifecycle } from "./coding-agents/turn-lifecycle.js";
import { createCodingAgentReviewSummaryStore } from "./coding-agents/review-summary.js";
import { createCodingAgentPreviewSummaryStore } from "./coding-agents/preview-summary.js";
import { createOwnerCodingAgentProjectSummaryStore } from "./coding-agents/project-summary.js";
import { createOwnerCodingAgentProjectWorkspaceStore } from "./coding-agents/project-workspace.js";
import { createCodingAgentThreadRelationValidator } from "./coding-agents/thread-relations.js";
import { createCodingAgentProviderRegistry } from "./coding-agents/provider-registry.js";
import { cleanupStaleIsolatedProviderProcesses } from "./coding-agents/provider-process-isolation.js";
import { createGatewayChatProviderCatalog } from "./chat/runtime-provider-catalog.js";
import { createChatProviderRoutes } from "./chat/provider-routes.js";
import {
  closeCanonicalChatEventLifecycle,
  createCanonicalChatRoutes,
} from "./chat/routes.js";
import type { createGatewayChatEventStream } from "./chat/gateway-event-stream.js";
import { registerCanonicalChatEventHttpRoute } from "./chat/event-http-route.js";
import { registerCanonicalChatEventWebSocketRoute } from "./chat/event-websocket-route.js";
import type { ChatExecutionRootResolver } from "./chat/execution-root.js";
import { createChatTerminalSessionService } from "./chat/terminal-session-service.js";
import { createHermesChatProviderAdapter } from "./chat/hermes-provider-adapter.js";
import { createOpenClawChatProviderAdapter } from "./chat/openclaw-provider-adapter.js";
import { createKernelChatProviderAdapter } from "./chat/kernel-provider-adapter.js";
import { createClaudeChatProviderAdapter } from "./chat/claude-provider-adapter.js";
import { createCanonicalCodingChatProviderAdapter } from "./chat/coding-provider-adapter.js";
import {
  CanonicalChatProviderRegistry,
  type CanonicalChatProviderAdapter,
} from "./chat/provider-adapter.js";
import { CanonicalChatOrchestrator } from "./chat/orchestrator.js";
import { createCanonicalChatRuntime } from "./chat/runtime.js";
import { createChatAgentRoutes } from "./chat/agent-routes.js";
import {
  createCanonicalChatService,
  createUnavailableCanonicalChatService,
} from "./chat/service.js";
import type { createDiscussionOnlyChatExecutionGuard } from "./collaboration/chat-scope.js";
import { initializeOwnerDatabaseServices } from "./startup/owner-database.js";
import { initializePlatformIntegrations } from "./startup/platform-integrations.js";
import {
  describeGatewayCollaborationConfiguration,
  loadGatewayCollaborationConfig,
  registerFailClosedCollaborationRoutes,
  type GatewayCollaborationConfigurationFailure,
  type GatewayCollaborationRuntime,
} from "./collaboration/wiring.js";
import { createLegacyProjectPathAdmission } from "./collaboration/project-path-admission.js";
import { createCodingAgentFilePreviewWiring } from "./coding-agents/file-preview-wiring.js";
import { createCodingAgentSourceControlStore } from "./coding-agents/source-control.js";
import { registerCodingAgentAttentionNotifications } from "./coding-agents/attention-notifications.js";
import { createCodingAgentNotificationPreferenceStore } from "./coding-agents/notification-preferences.js";
import { createCodingAgentProjectMutationService } from "./coding-agents/project-mutations.js";
import { createCodexEventBridge, type CodexEventBridge } from "./coding-agents/codex-event-bridge.js";
import { createCodexControlClient } from "./coding-agents/codex-control-client.js";
import {
  createChatIdleReaper,
  isWorkspaceSessionRuntimeAlive,
} from "./coding-agents/chat-idle-reaper.js";
import { withCanonicalIdleChat } from "./chat/idle-runtime-admission.js";
import { terminalTasksUnderPressure } from "@matrix-os/terminal-runtime/user-systemd-capacity";
import { createAgentActionAuditService } from "./onboarding/agent-action-audit.js";
import { capabilityIdsForConnectedServices, createIntegrationCapabilityService } from "./onboarding/integration-capabilities.js";
import { createIntegrationCapabilityRoutes } from "./onboarding/integration-capability-routes.js";
import { createAdminControlService } from "./onboarding/admin-control-service.js";
import { createAdminControlRoutes } from "./onboarding/admin-control-routes.js";
import { createCompanyBrainReadinessService } from "./onboarding/company-brain-readiness.js";
import { createCompanyBrainRoutes } from "./onboarding/company-brain-routes.js";
import { createDraftActionReadinessService } from "./onboarding/draft-action-readiness.js";
import { createDraftActionRoutes } from "./onboarding/draft-action-routes.js";
import { createVocalHandler } from "./vocal/ws-handler.js";
import type { GeminiLiveConnection } from "./onboarding/gemini-live.js";
import { securityHeadersMiddleware } from "./security/headers.js";
import { getSystemInfo, getVersion } from "./system-info.js";
import { collectSystemActivity } from "./system-activity/collector.js";
import { CleanupCandidateRegistry, executeCleanupAction } from "./system-activity/cleanup.js";
import { ActivityHistoryStore, AutoCleanupPolicyStore } from "./system-activity/history.js";
import { createSystemActivityRoutes } from "./system-activity/routes.js";
import {
  checkForSystemUpdate,
  listSystemReleases,
  parseInternalUpgradeTarget,
  readSystemUpdateFailure,
  resolveInternalUpgradeInstallTarget,
  resolveInternalUpgradeStartTarget,
  resolveSystemUpdateChannel,
  startSystemUpdate,
  startSystemUpdateRepair,
  writeInternalUpgradeTrigger,
} from "./system-update.js";
import { createInteractionLogger, type InteractionLogger } from "./logger.js";
import { createApprovalBridge, type ApprovalBridge } from "./approval.js";
import { DEFAULT_APPROVAL_POLICY, type ApprovalPolicy } from "@matrix-os/kernel";
import { listApps } from "./apps.js";
import type { AppDb } from "./app-db.js";
import type { AppRegistry } from "./app-db-registry.js";

import type { QueryEngine } from "./app-db-query.js";
import { isSafeName, normalizeAppStorageSlug } from "./app-db-types.js";
import type { KvStore } from "./app-db-kv.js";
import type { PlatformDb } from "./platform-db.js";
import { registerCustomMcpGatewayRoutes } from "./integrations/custom-mcp/gateway-routes.js";
import { createIntegrationBridgeRoutes } from "./integrations/bridge-routes.js";
import { createIntegrationProxyResponse } from "./integrations/proxy-response.js";
import { z } from "zod/v4";
import {
  createPluginRegistry,
  loadAllPlugins,
  createHookRunner,
  type PluginRegistry,
  type HookRunner,
  type LoadedPlugin,
} from "./plugins/index.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { AiProviderService } from "./ai-providers/service.js";
import { createLazyProviderSnapshotReader } from "./collaboration/lazy-provider-snapshot-reader.js";
import { createAiProviderRoutes } from "./ai-providers/routes.js";
import { ProviderSettingsStore } from "./ai-providers/provider-settings-store.js";
import { createProviderSettingsRoutes } from "./ai-providers/provider-settings-routes.js";
import {
  createProviderGenericHarnessCoordinator,
  reconcileProviderRuntimeAtStartup,
} from "./ai-providers/provider-generic-harness-coordinator.js";
import { createProviderDriverInventoryReader } from "./ai-providers/provider-driver-inventory.js";
import { createProviderTerminalLoginCoordinator } from "./ai-providers/provider-terminal-login-coordinator.js";
import { createDefaultProviderCliAccountLifecycleCoordinator } from "./ai-providers/provider-cli-account-lifecycle.js";
import { createGenericHarnessModelCatalogReader } from "./ai-providers/generic-harness-model-catalog.js";
import { createHermesRoutes } from "./routes/hermes.js";
import {
  createHermesDashboardClient,
  validateHermesDashboardUrl,
} from "./agent-config/hermes-client.js";
import {
  createAgentRuntimeServices,
  createLazyOpenClawRpc,
} from "./agent-config/runtime-services.js";
import { syncApp, createSyncRoutes } from "./sync/routes.js";
import { initializeSyncInfrastructure } from "./sync/infrastructure.js";
import { createManifestDb } from "./sync/db-impl.js";
import { createHomeMirror, type HomeMirror } from "./sync/home-mirror.js";
import {
  deriveHomeMirrorSyncIdentity,
  resolveSyncScope,
  syncScopeRegistryKey,
} from "./sync/runtime-scope.js";
import { createSyncPeerLifecycle } from "./sync/ws-peer-lifecycle.js";
import {
  type SyncDatabase,
} from "./sync/sharing-db.js";
import { sql, type Kysely } from "kysely";
import { createSocialRoutes, insertPost, bootstrapSocialSchema, type SocialRoutes } from "./social.js";
import { createActivityService } from "./social-activity.js";
import type { CanvasRepository } from "./canvas/repository.js";
import type { CanvasService } from "./canvas/service.js";
import { createCanvasRoutes } from "./canvas/routes.js";
import { CanvasSubscriptionHub } from "./canvas/subscriptions.js";
import { CanvasIdSchema } from "./canvas/contracts.js";

import {
  createChatAttachmentCleanupLifecycle,
} from "./chat/attachment-cleanup.js";
import type { OsViewStateRepository } from "./os-view-state/repository.js";
import { createOsViewStateRoutes } from "./os-view-state/routes.js";
import { createOsViewAgentTools } from "./os-view-state/agent-tools.js";
import type { ChatRepository } from "./chat/repository.js";
import type { MessagingKyselyRepository } from "./messages/repository.js";
import { createMessagingRoutes } from "./messages/routes.js";
import type { WSContext } from "hono/ws";
import {
  MainWsClientMessageSchema,
  type MainWsClientMessage,
} from "./ws-message-schema.js";
import type { GatewayConfig, ServerMessage } from "./server/types.js";
import {
  kernelEventToServerMessage,
  kernelResultFallbackText,
  send,
  sendClientAck,
} from "./server/main-ws-messages.js";
import {
  resolveInitialSymphonyPort,
  symphonyUpstreamOriginForPort,
} from "./server/symphony-origin.js";
import { registerAppRuntimeRoutes } from "./server/app-runtime-routes.js";
import { registerFileRoutes } from "./server/file-routes.js";
import { registerBridgeDataRoutes } from "./server/bridge-routes.js";
import { registerAppManagementRoutes } from "./server/app-management-routes.js";
import { registerConversationHistoryRoutes } from "./server/conversation-history-routes.js";
import { startTerminalPasteAssetCleanup } from "./shell/paste-asset-cleanup-runtime.js";
import {
  metricsRegistry,
  httpRequestsTotal,
  httpRequestDuration,
  wsConnectionsActive,
  normalizePath,
} from "./metrics.js";
import {
  createShellRoutes,
  SHELL_SESSION_CREATE_RATE_LIMIT,
  ShellPreferencesStore,
  createShellCommandRunner,
  createTerminalAcceptanceRoutes,
  createTerminalWindowLayoutRoutes,
  TerminalWindowLayoutStore,
  createTerminalWorkspaceRoutes,
  createTerminalWorkspaceProjectAdmission,
} from "./shell/index.js";
import {
  CLIENT_ERROR_LOG_BODY_LIMIT,
  ClientErrorReportSchema,
  forwardClientErrorToPostHog,
  writeClientErrorReport,
} from "./client-error-log.js";
import { createForwardTunnelHub } from "./forward-ws.js";
import { registerTerminalWebSocketRoutes } from "./server/terminal-ws-routes.js";
import { registerMainWebSocketRoutes } from "./server/main-ws-routes.js";
import { registerVoiceWebSocketRoutes } from "./server/voice-ws-routes.js";
import { registerCodingAgentThreadWebSocketRoutes } from "./server/coding-agent-thread-ws-routes.js";
import { registerMessageLayoutRoutes } from "./server/message-layout-routes.js";
import { registerHomeUtilityRoutes } from "./server/home-utility-routes.js";
import { registerSystemOperatorRoutes } from "./server/system-operator-routes.js";
import { registerShellTerminalRoutes } from "./server/shell-terminal-routes.js";
import { registerOperationalRoutes } from "./server/operational-routes.js";
import { registerCanvasGatewayRoutes } from "./server/canvas-gateway-routes.js";
import { registerCollaborationChatRoutes } from "./server/collaboration-chat-routes.js";
import { registerDeferredRuntimeRoutes } from "./server/deferred-runtime-routes.js";
import { initializeGatewayChannels } from "./startup/channels.js";

export {
  buildAllowedOrigins,
  createAllowedOriginController,
} from "./allowed-origins.js";
export {
  registerTerminalSessionRoutes,
  TERMINAL_SESSION_DELETE_BODY_LIMIT_BYTES,
  type TerminalSessionRouteRegistry,
} from "./terminal-session-routes.js";
export type { GatewayConfig, ServerMessage } from "./server/types.js";
export {
  readInitialSymphonyPort,
  resolveInitialSymphonyPort,
} from "./server/symphony-origin.js";

export async function resetVolatilePtySessionList(persistPath: string): Promise<void> {
  await mkdirAsync(dirname(persistPath), { recursive: true });
  await writeFileAsync(persistPath, "[]\n");
}

const MAX_MAIN_WS_CLIENTS = 100;

export async function createGateway(config: GatewayConfig) {
  const { homePath: rawHomePath, port = 4000, syncReport } = config;
  const homePath = resolve(rawHomePath);
  const fundedAiRuntimeConfig = loadFundedAiRuntimeConfig(process.env);
  const fundedCredentialProvider = fundedAiRuntimeConfig
    ? createFundedAiCredentialManager(fundedAiRuntimeConfig)
    : undefined;
  const fundedAiFundingSummaryReader = fundedAiRuntimeConfig
    ? createFundedAiFundingSummaryClient(fundedAiRuntimeConfig)
    : undefined;
  const speechRuntime = createGatewaySpeechRuntime({
    env: process.env,
    getOwnerId: (c) => requireRequestPrincipal(c).userId,
  });
  const runningVersion = getVersion(
    config.runningVersion ? { version: config.runningVersion } : undefined,
  );
  let syncReportSent = false;
  const allowedOriginController = createAllowedOriginController({
    shellOrigin: process.env.SHELL_ORIGIN,
    proxyOrigin: process.env.PROXY_ORIGIN,
  });

  const app = new Hono();
  const posthogErrorTracker = installPostHogHonoErrorTracking(app, {
    service: "matrix-gateway",
  });
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const terminalWorkspaceRuntime = new TerminalRuntimeSocketClient({
    socketPath: process.env.MATRIX_TERMINAL_RUNTIME_SOCKET ?? "/run/matrix/terminal-runtime.sock",
  });
  const terminalLiveOwnership = createTerminalLiveOwnership();
  const providerLoginTerminalRegistry = createProviderLoginTerminalRegistry(terminalWorkspaceRuntime);
  const workspaceSessionRuntimeBridge = createSessionRuntimeBridge();
  const shellPreferencesStore = new ShellPreferencesStore({ homePath });
  const terminalWindowLayoutStore = new TerminalWindowLayoutStore({ homePath });
  const symphonyRunner = createSymphonyRunner({ homePath });
  const initialSymphonyPort = await resolveInitialSymphonyPort(symphonyRunner);
  if (initialSymphonyPort) {
    allowedOriginController.updateSymphonyPort(initialSymphonyPort);
  }
  const forwardTunnelHub = createForwardTunnelHub();
  // One distinct id for every gateway telemetry event so all events on a
  // dev gateway without owner env vars land under the same person.
  const ownerTelemetryDistinctId = resolveOwnerTelemetryDistinctId() ?? "matrix-gateway";
  const captureTerminalEvent = (
    event: string,
    properties: Record<string, string | number | boolean | undefined> = {},
  ) => {
    void posthogErrorTracker.captureEvent("gateway_terminal_ws", {
      distinctId: ownerTelemetryDistinctId,
      properties: {
        source: "gateway-terminal-ws",
        event,
        ...properties,
      },
    });
  };
  const captureGatewayProductEvent = (
    event: string,
    properties: Record<string, string | number | boolean | undefined> = {},
  ) => {
    void posthogErrorTracker.captureEvent("gateway_product", {
      distinctId: ownerTelemetryDistinctId,
      properties: {
        source: "gateway",
        event,
        ...properties,
      },
    });
  };
  // PostHog LLM analytics: one $ai_generation per completed AI run.
  // Reuses the tracker above (already flushed per-capture and shut down on
  // gateway close), so no separate PostHog client or shutdown path is needed.
  const recordAiGeneration = createAiGenerationRecorder({
    capture: (event, options) => posthogErrorTracker.captureEvent(event, options),
  });
  const watcher: Watcher = createWatcher(homePath);
  const conversationMutationLock = createConversationMutationLock({ maxKeys: 64 });
  const conversations: ConversationStore = createConversationStore(homePath, {
    mutationLock: conversationMutationLock,
  });
  const conversationRuns = new ConversationRunRegistry();
  const conversationLifecycle = createConversationLifecycle({
    mutationLock: conversationMutationLock,
    conversations,
    conversationRuns,
  });
  const reconnectableAbortControllers = new Map<string, ReconnectableAbortEntry>();
  const clients = new Set<WSContext>();
  const clientOwnerIds = new WeakMap<WSContext, string>();
  const readinessRepository = new InMemoryReadinessRepository();
  const toolPackRepository = new InMemoryToolPackRepository();
  const readinessCache = new ReadinessStatusCache<ReadinessResponse>({ maxEntries: 512, ttlMs: 10_000 });
  const internalPlatformUrl = process.env.PLATFORM_INTERNAL_URL;
  const internalPlatformToken = process.env.UPGRADE_TOKEN;
  const internalHandle = process.env.MATRIX_HANDLE;
  let platformDb: PlatformDb | null = null;
  const workspaceProviderRuntime = resolveWorkspaceProviderRuntime(process.env);
  const codingAgentWorkspaceAgents = workspaceProviderRuntime.agents;
  const codexExecutable = workspaceProviderRuntime.codexExecutable;
  const agentCredentialLauncher = createAgentLauncher({
    cwd: homePath,
    runtimeHome: homePath,
    codexExecutable,
  });
  let internalIntegrationBaseUrl: string | null = null;
  const PLATFORM_USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CAPABILITY_LOOKUP_TIMEOUT_MS = 10_000;
  async function withCapabilityLookupTimeout<T>(operation: () => Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("capability lookup timed out")), CAPABILITY_LOOKUP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  async function getConnectedCapabilityIds(ownerId: string): Promise<string[]> {
    if (platformDb) {
      try {
        const dbForLookup = platformDb;
        const services = await withCapabilityLookupTimeout(async () => {
          const user = await dbForLookup.getUserByClerkId(ownerId);
          const platformUserId = user?.id ?? (PLATFORM_USER_ID_PATTERN.test(ownerId) ? ownerId : null);
          if (!platformUserId) return [];
          return dbForLookup.listConnectedServices(platformUserId);
        });
        return capabilityIdsForConnectedServices(services.map((service) => service.service));
      } catch (err: unknown) {
        console.warn("[integrations] platform capability lookup failed:", err instanceof Error ? err.message : String(err));
        return [];
      }
    }
    if (!internalIntegrationBaseUrl) return [];
    try {
      const headers = new Headers({ Accept: "application/json" });
      if (internalPlatformToken) headers.set("authorization", `Bearer ${internalPlatformToken}`);
      const response = await fetch(internalIntegrationBaseUrl, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];
      const body = await response.json() as unknown;
      const connections = Array.isArray(body)
        ? body
        : body && typeof body === "object" && Array.isArray((body as { connections?: unknown }).connections)
          ? (body as { connections: unknown[] }).connections
          : [];
      return capabilityIdsForConnectedServices(connections.flatMap((connection) =>
        connection && typeof connection === "object" && typeof (connection as { service?: unknown }).service === "string"
          ? [(connection as { service: string }).service]
          : [],
      ));
    } catch (err: unknown) {
      console.warn("[integrations] capability connection lookup failed:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }
  const agentCredentialService = createAgentCredentialStatusService({
    onChange: (ownerId) => readinessCache.delete(ownerId),
    probeAgent: async (_ownerId, agent) => {
      const detected = await agentCredentialLauncher.detectAgentCredentials();
      const status = detected.agents.find((candidate) => candidate.id === agent);
      return resolveAgentCredentialProbe(homePath, agent, status);
    },
  });
  let codingAgentThreadStore: (CodingAgentThreadStore & CodingAgentTurnStore) | undefined;
  let chatRepository: ChatRepository | null = null;
  let codexEventBridge: CodexEventBridge | undefined;
  let codingAgentWorkspaceRuntime: WorkspaceSessionOrchestrator | null = null;
  let codingAgentApprovalsEnabled = false;
  const codingAgentSessionStopReconciler = createCodingAgentSessionStopReconciler();
  const workspaceEventStore = createWorkspaceEventStore({ homePath });
  const reviewStore = createReviewStore({ homePath });
  const codingAgentReviewSummaryStore = createCodingAgentReviewSummaryStore(reviewStore, {
    homePath,
    ownerId: process.env.MATRIX_USER_ID,
    principalOwnerIds: [process.env.MATRIX_USER_ID, process.env.MATRIX_CLERK_USER_ID].filter(
      (id): id is string => Boolean(id),
    ),
  });
  const codingAgentOwnerIds = [process.env.MATRIX_USER_ID, process.env.MATRIX_CLERK_USER_ID].filter(
    (id): id is string => Boolean(id),
  );
  // A terminal runtime belongs to exactly one VPS owner. MATRIX_USER_ID is
  // canonical when present; MATRIX_CLERK_USER_ID supports VPS-native hosts
  // provisioned before the canonical variable was added.
  const terminalRuntimeOwnerId = process.env.MATRIX_USER_ID ?? process.env.MATRIX_CLERK_USER_ID;
  const terminalRuntimeOwnerIds = terminalRuntimeOwnerId
    ? [terminalRuntimeOwnerId]
    : process.env.NODE_ENV === "production" ? [] : ["default"];
  const toolOutputKey = await tryLoadToolOutputKey(homePath);
  const projectOwnerToolOutput = createOwnerToolOutputProjection(toolOutputKey, terminalRuntimeOwnerIds);
  const codingAgentProjectManager = createProjectManager({ homePath });
  const conversationContextResolver = createConversationContextResolver(codingAgentProjectManager);
  const codingAgentWorktreeManager = createWorktreeManager({ homePath });
  const { codingAgentFileStore, filePreviewService } = createCodingAgentFilePreviewWiring({
    homePath,
    ownerId: process.env.MATRIX_USER_ID,
    principalOwnerIds: codingAgentOwnerIds,
    projects: {
      getProjectBySlug: (projectSlug) => codingAgentProjectManager.getProject(projectSlug),
    },
    worktrees: codingAgentWorktreeManager,
    canAccessHomePath: (principal, path) => chatRepository?.ownsAttachmentPath({
      type: "personal",
      ownerId: principal.userId,
    }, path) ?? Promise.resolve(false),
  });
  const codingAgentSourceControlStore = createCodingAgentSourceControlStore({
    homePath,
    ownerId: process.env.MATRIX_USER_ID,
    principalOwnerIds: codingAgentOwnerIds,
    worktrees: codingAgentWorktreeManager,
  });
  const codingAgentNotificationPreferenceStore = createCodingAgentNotificationPreferenceStore({ homePath });
  const workspaceEventPublisher = createWorkspaceEventPublisher({
    eventStore: workspaceEventStore,
    onSessionStopped: (session) => codingAgentSessionStopReconciler.handleSessionStopped(session),
  });
  const codingAgentProviders: CodingAgentProviderAdapter[] = [];
  const codingAgentRegistryProviders: CodingAgentProviderAdapter[] = [];
  let providerSettingsStore: ProviderSettingsStore | undefined;
  // S08: the owner's Provider V3 snapshot reader is built after the owner database, so the
  // collaboration runtime receives a lazy reader; it is only consulted at policy writes and
  // run admission, never during construction, and reads fail closed until the service exists.
  const collaborationProviderSnapshots = createLazyProviderSnapshotReader();
  const harnessSettingsReader = {
    getSnapshot: () => {
      if (!providerSettingsStore) throw new Error("Provider settings are unavailable");
      return providerSettingsStore.getSnapshot();
    },
  };
  const backgroundAgentRuntime = createBackgroundAgentRuntime({ homePath });
  const backgroundChatProjection = createBackgroundChatProjection();
  if (codingAgentWorkspaceAgents.length > 0) {
    const codingAgentProjectManager = createProjectManager({ homePath });
    codexEventBridge = codexExecutable
      ? createCodexEventBridge({
        homePath,
        codexExecutable,
        isRuntimeAlive: (sessionId: string) => {
          const sessions = codingAgentWorkspaceRuntime;
          return sessions
            ? isWorkspaceSessionRuntimeAlive(sessionId, sessions, terminalWorkspaceRuntime, backgroundAgentRuntime)
            : Promise.resolve(false);
        },
      })
      : undefined;
    const codingAgentSessionManager = createAgentSessionManager({
      homePath,
      worktreeManager: codingAgentWorktreeManager,
      agentLauncher: agentCredentialLauncher,
      terminalRuntime: terminalWorkspaceRuntime,
      backgroundRuntime: backgroundAgentRuntime,
    });
    codingAgentWorkspaceRuntime = createWorkspaceSessionOrchestrator({
      homePath,
      projectManager: codingAgentProjectManager,
      worktreeManager: codingAgentWorktreeManager,
      agentSessionManager: codingAgentSessionManager,
      onClose: () => codingAgentSessionManager.shutdown(),
      agentSandbox: createAgentSandbox({ homePath }),
      sessionRuntimeBridge: workspaceSessionRuntimeBridge,
      eventPublisher: workspaceEventPublisher,
    });
    const providerSet = createWorkspaceCodingAgentProviderSet({
      agents: codingAgentWorkspaceAgents,
      runtime: codingAgentWorkspaceRuntime,
      homePath,
      codexEvents: codexEventBridge,
      codexControl: codexExecutable ? createCodexControlClient({ homePath }) : undefined,
      pi: {
        resolveCredentialLaunch: createCodingHarnessCredentialResolver({
          harness: "pi",
          homePath,
          settings: harnessSettingsReader,
          fundedProvider: fundedCredentialProvider,
        }),
      },
      opencode: {
        resolveCredentialLaunch: createCodingHarnessCredentialResolver({
          harness: "opencode",
          homePath,
          settings: harnessSettingsReader,
          fundedProvider: fundedCredentialProvider,
        }),
      },
    });
    codingAgentApprovalsEnabled = providerSet.approvalsEnabled;
    codingAgentProviders.push(...providerSet.executionProviders);
    codingAgentRegistryProviders.push(...providerSet.registryProviders);
  } else if (process.env.MATRIX_CODING_AGENTS_FAKE_PROVIDER === "1") {
    const fakeProvider = createFakeCodingAgentProvider({ providerId: "codex" });
    codingAgentProviders.push(fakeProvider);
    codingAgentRegistryProviders.push(fakeProvider);
  }
  codingAgentThreadStore = codingAgentProviders.length > 0
    ? createCodingAgentThreadStore({
      homePath,
      providers: codingAgentProviders,
      restoreProviderThread: async (thread) => {
        const restored = !!codingAgentWorkspaceRuntime && !!codexEventBridge
          && await restoreBackgroundChatThread({ thread, sessions: codingAgentWorkspaceRuntime, events: codexEventBridge });
        if (restored) backgroundChatProjection.track(thread);
        return restored;
      },
      relationValidator: createCodingAgentThreadRelationValidator({
        projectManager: codingAgentProjectManager,
        taskManager: createTaskManager({ homePath }),
        principalOwnerIds: codingAgentOwnerIds,
      }),
      projectionPublisher: (change) =>
        workspaceEventPublisher.publishCodingAgentThreadProjection(change),
    })
    : undefined;
  if (codingAgentThreadStore) {
    codexEventBridge?.attachThreadStore(codingAgentThreadStore);
    backgroundChatProjection.attach(codingAgentThreadStore);
  }
  const codingAgentProviderRegistry = createCodingAgentProviderRegistry({
    providers: codingAgentRegistryProviders,
    agentCredentials: agentCredentialService,
    invalidateCredentialDetection: agentCredentialLauncher.invalidateCredentialDetection,
  });
  const codingAgentWorkspaceEnabled = Boolean(codingAgentThreadStore);
  const codingAgentTurnLifecycle = await createCodingAgentTurnLifecycle({
    store: codingAgentThreadStore,
    providers: codingAgentProviders,
    logFailure: logBestEffortFailure,
  });
  const codingAgentTurnsEnabled = codingAgentTurnLifecycle.turnsEnabled;
  if (codingAgentThreadStore) {
    void codingAgentSessionStopReconciler.attachThreadStore(codingAgentThreadStore).catch((err: unknown) => {
      console.warn("[coding-agents] Failed to flush pending session stops:", err instanceof Error ? err.message : String(err));
    });
  }
  const codingAgentThreadStream = codingAgentThreadStore
    ? createCodingAgentThreadStream({ threads: codingAgentThreadStore })
    : undefined;
  const codingAgentProjectSummaryStore = createOwnerCodingAgentProjectSummaryStore({
    homePath,
    threads: codingAgentThreadStore,
    principalOwnerIds: codingAgentOwnerIds,
  });
  const codingAgentProjectWorkspaceStore = createOwnerCodingAgentProjectWorkspaceStore({
    homePath,
    threads: codingAgentThreadStore,
    principalOwnerIds: codingAgentOwnerIds,
  });
  const codingAgentPreviewSummaryStore = createCodingAgentPreviewSummaryStore({
    homePath,
    previewManager: createPreviewManager({ homePath }),
    ownerId: process.env.MATRIX_USER_ID,
    principalOwnerIds: codingAgentOwnerIds,
  });
  const codingAgentRuntimeSummaryService = createCodingAgentRuntimeSummaryService({
    homePath,
    terminalRegistry: { list: () => terminalWorkspaceRuntime.listWorkspaces() },
    providerRegistry: codingAgentProviderRegistry,
    threads: codingAgentThreadStore,
    projects: codingAgentProjectSummaryStore,
    previews: codingAgentPreviewSummaryStore,
    capabilities: {
      projectWorkspace: true,
      conversationView: true,
      kanbanView: true,
      workspace: codingAgentWorkspaceEnabled,
      sameThreadTurns: codingAgentTurnsEnabled,
      approvals: codingAgentApprovalsEnabled,
      review: true,
      preview: true,
      files: true,
      sourceControl: true,
    },
    terminalOwnerId: process.env.MATRIX_USER_ID,
    filesOwnerId: process.env.MATRIX_USER_ID,
  });
  const integrationCapabilityService = createIntegrationCapabilityService({
    getConnectedCapabilityIds,
    onChange: (ownerId) => readinessCache.delete(ownerId),
    storagePath: join(homePath, "system", "integration-capabilities.json"),
  });
  const agentActionAuditService = createAgentActionAuditService();
  const companyBrainService = createCompanyBrainReadinessService();
  const draftActionService = createDraftActionReadinessService();
  const unavailableCodingSetup: CodingSetupStatus = {
    githubConnected: false,
    selectedProject: null,
    issueSourceConfigured: false,
    symphonyReady: false,
    terminalReady: false,
    activeAgents: ["hermes"],
    handoffStatus: "idle",
  };
  const readinessService = createReadinessService({
    repository: readinessRepository,
    cache: readinessCache,
    agentCredentials: agentCredentialService,
    integrationCapabilities: integrationCapabilityService,
    codingSetup: {
      getCodingSetup: async () => unavailableCodingSetup,
    },
  });
  const toolPackService = createToolPackService({
    repository: toolPackRepository,
    installer: createHostToolPackInstaller(),
  });
  const adminControlService = createAdminControlService({
    agentCredentials: agentCredentialService,
    integrations: integrationCapabilityService,
    readiness: readinessService,
  });

  // App data layer (Postgres-backed when DATABASE_URL is set)
  const databaseUrl = process.env.DATABASE_URL;
  let appDb: AppDb | null = null;
  let queryEngine: QueryEngine | null = null;
  let kvStore: KvStore | null = null;
  let appRegistry: AppRegistry | null = null;
  let kyselyInstance: Kysely<any> | null = null;
  let canvasRepository: CanvasRepository | null = null;
  let osViewStateRepository: OsViewStateRepository | null = null;

  // Apps whose Postgres schema we've already ensured this process lifetime.
  // The startup loop pre-registers shipped apps, but apps BUILT in-OS after boot
  // aren't in that pass — so the bridge lazily provisions their schema from the
  // manifest on first query (otherwise every new app 500s until a restart).
  const provisionedAppSlugs = new Set<string>();
  const provisionedAppSlugOrder: string[] = [];
  const PROVISIONED_SLUGS_CAP = 500;
  function rememberProvisionedAppSlug(storageSlug: string): void {
    if (provisionedAppSlugs.has(storageSlug)) return;
    provisionedAppSlugs.add(storageSlug);
    provisionedAppSlugOrder.push(storageSlug);
    while (provisionedAppSlugOrder.length > PROVISIONED_SLUGS_CAP) {
      const oldest = provisionedAppSlugOrder.shift();
      if (oldest) provisionedAppSlugs.delete(oldest);
    }
  }

  async function ensureAppProvisioned(storageSlug: string): Promise<void> {
    const registry = appRegistry;
    if (!registry || !storageSlug || provisionedAppSlugs.has(storageSlug)) return;
    if (!isSafeName(storageSlug)) return;
    try {
      const { loadAppManifest } = await import("./app-manifest.js");
      const apps = await listApps(homePath, { includeInactiveDesigns: true });
      let shouldCacheProvisionAttempt = false;
      for (const app of apps) {
        if (!app.file.includes("/")) continue;
        const relDir = app.file.replace(/\/index\.html$/, "").replace(/\.html$/, "");
        if (normalizeAppStorageSlug(relDir) !== storageSlug) continue;
        const manifest = loadAppManifest(join(homePath, "apps", relDir));
        if (!manifest) {
          console.warn(`[app-db] Lazy provisioning skipped for ${relDir}: manifest could not be loaded`);
          break;
        }
        shouldCacheProvisionAttempt = true;
        const tables = manifest.storage?.tables as
          | Record<string, { columns: Record<string, string>; indexes?: string[]; uniqueIndexes?: string[] }>
          | undefined;
        if (tables && Object.keys(tables).length > 0) {
          await registry.register({
            slug: storageSlug,
            name: manifest.name,
            description: manifest.description,
            version: manifest.version,
            author: manifest.author,
            category: manifest.category,
            tables,
          });
          console.log(`[app-db] Lazily provisioned schema for ${relDir} (slug ${storageSlug})`);
        }
        break;
      }
      // Cache matched apps even when there were no tables, so we don't rescan
      // on every query. Do not cache missing/corrupt manifests; those can be
      // fixed by an in-OS build without restarting the gateway.
      if (shouldCacheProvisionAttempt) rememberProvisionedAppSlug(storageSlug);
    } catch (err) {
      console.error(`[app-db] Lazy provisioning failed for ${storageSlug}:`, (err as Error).message);
    }
  }
  let canvasService: CanvasService | null = null;
  let canvasSubscriptionHub: CanvasSubscriptionHub | null = null;
  let canvasCleanupTimer: ReturnType<typeof setInterval> | null = null;
  let chatIdleReaper: ReturnType<typeof createChatIdleReaper> | null = null;
  let canonicalChatEventStream: ReturnType<typeof createGatewayChatEventStream> | null = null;
  let canonicalChatOrchestrator: CanonicalChatOrchestrator | null = null;
  let canonicalChatRuntime: Awaited<ReturnType<typeof createCanonicalChatRuntime>> | null = null;
  let canonicalChatExecutionRoots: ChatExecutionRootResolver | null = null;
  let canonicalChatCollaborationGuard: ReturnType<typeof createDiscussionOnlyChatExecutionGuard> | null = null;
  let gatewayCollaboration: GatewayCollaborationRuntime | null = null;
  let messagingRepository: MessagingKyselyRepository | null = null;
  // Collaboration wiring always constructs (S20): there is no release flag.
  // Incomplete configuration or a missing owner database registers the
  // fail-closed routes below instead of skipping construction.
  const collaborationHealth = describeGatewayCollaborationConfiguration(process.env);
  const collaborationConfig = collaborationHealth.configured ? loadGatewayCollaborationConfig(process.env) : null;
  let collaborationFailClosedReason: GatewayCollaborationConfigurationFailure | null = collaborationHealth.configured
    ? null
    : collaborationHealth.reason;
  const ownerDatabaseStartup = await initializeOwnerDatabaseServices({
    databaseUrl,
    homePath,
    collaborationConfig,
    initialFailureReason: collaborationFailClosedReason,
    providerSnapshotReader: collaborationProviderSnapshots.reader,
    codingAgentProjectManager,
    codingAgentWorktreeManager,
    terminalWorkspaceRuntime,
    terminalRuntimeOwnerIds,
    projectOwnerToolOutput,
    capture: (event, options) => posthogErrorTracker.captureEvent(event, options),
    runningVersion,
    getCanonicalChatOrchestrator: () => canonicalChatOrchestrator,
    rememberProvisionedAppSlug,
    logBestEffortFailure,
  });
  const ownerDatabaseServices = ownerDatabaseStartup.services;
  collaborationFailClosedReason = ownerDatabaseStartup.failClosedReason;
  appDb = ownerDatabaseServices?.appDb ?? null;
  queryEngine = ownerDatabaseServices?.queryEngine ?? null;
  kvStore = ownerDatabaseServices?.kvStore ?? null;
  appRegistry = ownerDatabaseServices?.appRegistry ?? null;
  kyselyInstance = ownerDatabaseServices?.kyselyInstance ?? null;
  canvasRepository = ownerDatabaseServices?.canvasRepository ?? null;
  osViewStateRepository = ownerDatabaseServices?.osViewStateRepository ?? null;
  canvasService = ownerDatabaseServices?.canvasService ?? null;
  canvasSubscriptionHub = ownerDatabaseServices?.canvasSubscriptionHub ?? null;
  canvasCleanupTimer = ownerDatabaseServices?.canvasCleanupTimer ?? null;
  chatRepository = ownerDatabaseServices?.chatRepository ?? null;
  canonicalChatEventStream = ownerDatabaseServices?.chatEventStream ?? null;
  canonicalChatExecutionRoots = ownerDatabaseServices?.chatExecutionRoots ?? null;
  canonicalChatCollaborationGuard = ownerDatabaseServices?.chatCollaborationGuard ?? null;
  gatewayCollaboration = ownerDatabaseServices?.collaboration ?? null;
  messagingRepository = ownerDatabaseServices?.messagingRepository ?? null;

  const trustedOsViewOwnerId = process.env.MATRIX_USER_ID?.trim();
  const osViewTools = osViewStateRepository
    && trustedOsViewOwnerId
    && trustedOsViewOwnerId.length <= 160
    ? createOsViewAgentTools({
        repository: osViewStateRepository,
        ownerId: trustedOsViewOwnerId,
        homePath,
        onChanged: (state) => broadcastToOwner(trustedOsViewOwnerId, {
          type: "os-view:changed",
          revision: state.revision,
          updatedAt: state.updatedAt,
        }),
      })
    : undefined;
  const dispatcher: Dispatcher = createDispatcher({
    homePath,
    model: config.model,
    maxTurns: config.maxTurns,
    spawnFn: config.spawnFn,
    onAiGeneration: recordAiGeneration,
    fundedCredentialProvider,
    osViewTools,
    ownerAudioTranscriber: speechRuntime.ownerAudioTranscriber,
  });

  const { syncR2, syncPeerRegistry, syncSharing, syncDeps } = await initializeSyncInfrastructure(kyselyInstance);

  const geminiLiveConnection: GeminiLiveConnection =
    internalPlatformUrl && internalPlatformToken && internalHandle
      ? { proxy: { platformUrl: internalPlatformUrl, token: internalPlatformToken, handle: internalHandle } }
      : process.env.GEMINI_API_KEY ?? "";


  // Container-side home mirror: watches the user's home directory and
  // pushes changes to the same R2 bucket the user's local daemon reads.
  // Off by default; enable with MATRIX_HOME_MIRROR=true.
  let homeMirror: HomeMirror | null = null;
  let homeMirrorStart: Promise<void> | null = null;
  const homeMirrorEnabled = process.env.MATRIX_HOME_MIRROR === "true";
  if (homeMirrorEnabled && syncR2 && kyselyInstance) {
    // Loud fail-fast in production: if the orchestrator didn't inject
    // MATRIX_USER_ID, the mirror would fall back to MATRIX_HANDLE (or
    // worse, "default") and publish every user's home directory under a
    // single shared R2 prefix. Refuse to start rather than corrupt state.
    if (
      process.env.NODE_ENV === "production" &&
      !process.env.MATRIX_USER_ID
    ) {
      throw new Error(
        "[home-mirror] MATRIX_USER_ID is required in production when MATRIX_HOME_MIRROR=true. Check that the platform orchestrator injected it.",
      );
    }
    try {
      // Keep home-mirror's R2 prefix aligned with what authenticated
      // HTTP/WS routes use (Clerk userId via claims.sub). The orchestrator
      // injects MATRIX_USER_ID on every provision/upgrade/rolling-restart.
      // MATRIX_HANDLE fallback preserves dev-mode behaviour when no Clerk
      // identity is plumbed through.
      const baseUserId =
        process.env.MATRIX_USER_ID ?? process.env.MATRIX_HANDLE ?? "default";
      if (!process.env.MATRIX_USER_ID) {
        console.warn(
          "[home-mirror] MATRIX_USER_ID not set; using MATRIX_HANDLE fallback. This is dev-only behaviour.",
        );
      }
      const scope = resolveSyncScope({
        ownerId: baseUserId,
        runtimeSlot: process.env.MATRIX_RUNTIME_SLOT,
      });
      const { peerId } = deriveHomeMirrorSyncIdentity({
        baseUserId,
        runtimeSlot: process.env.MATRIX_RUNTIME_SLOT,
      });
      const manifestDb = createManifestDb(kyselyInstance as Kysely<SyncDatabase>);
      homeMirror = createHomeMirror({
        r2: syncR2,
        manifestDb,
        homeRoot: homePath,
        userId: scope.ownerId,
        scope,
        peerId,
        // Subscribe to sync:change broadcasts from other peers so the
        // container's /home/matrixos/home/ stays in sync with what laptops
        // commit. Without this the mirror is push-only (container -> R2)
        // and the three-way loop is broken.
        peerRegistry: syncPeerRegistry ?? undefined,
        logger: {
          info: (msg, ...rest) => console.log(`[home-mirror] ${msg}`, ...rest),
          error: (msg, ...rest) => console.error(`[home-mirror] ${msg}`, ...rest),
        },
      });
      // Start asynchronously so server boot isn't blocked by the initial pull.
      homeMirrorStart = homeMirror.start().catch((err) => {
        console.error("[home-mirror] start failed:", (err as Error).message);
      });
    } catch (err) {
      console.error("[home-mirror] init failed:", (err as Error).message);
      homeMirror = null;
    }
  }

  internalIntegrationBaseUrl =
    internalPlatformUrl && internalHandle
      ? `${internalPlatformUrl}/internal/containers/${internalHandle}/integrations`
      : null;

  function buildIntegrationProxyUrl(
    c: Context,
    targetBase: string,
    routePrefix = "/api/integrations",
  ): string {
    const targetUrl = new URL(targetBase);
    const suffix = c.req.path.replace(routePrefix, "") || "";
    const decodedSuffix = decodeURIComponent(suffix);
    if (decodedSuffix.split("/").some((segment) => segment === "..")) {
      throw new Error("Invalid integration proxy path");
    }

    const basePath = targetUrl.pathname.endsWith("/")
      ? targetUrl.pathname.slice(0, -1)
      : targetUrl.pathname;
    targetUrl.pathname = suffix ? `${basePath}${suffix}` : basePath;
    targetUrl.search = new URL(c.req.url).search;
    return targetUrl.toString();
  }

  function logBestEffortFailure(context: string, err: unknown): void {
    console.warn(
      `[gateway] ${context}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  function logUnexpectedJsonParseFailure(context: string, err: unknown): void {
    if (!(err instanceof SyntaxError)) {
      logBestEffortFailure(context, err);
    }
  }

  function logUnexpectedWsSendFailure(context: string, err: unknown): void {
    if (!(err instanceof Error && /not open|not opened|closed/i.test(err.message))) {
      logBestEffortFailure(context, err);
    }
  }

  async function proxyIntegrationRequest(
    c: Context,
    targetBase: string,
    internalAuthToken?: string,
    routePrefix = "/api/integrations",
  ): Promise<Response> {
    let upstreamUrl: string;
    try {
      upstreamUrl = buildIntegrationProxyUrl(c, targetBase, routePrefix);
    } catch (err: unknown) {
      console.warn(
        "[integrations] rejected proxy path:",
        err instanceof Error ? err.message : String(err),
      );
      return c.json({ error: "Bad request" }, 400);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(c.req.header())) {
      if (key !== "host" && key !== "authorization" && value) {
        headers.set(key, value);
      }
    }
    if (internalAuthToken) {
      headers.set("authorization", `Bearer ${internalAuthToken}`);
    }

    const upstream = await fetch(upstreamUrl, {
      method: c.req.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.blob(),
    });

    return createIntegrationProxyResponse(upstream);
  }

  // Platform integration services are constructed before auth and mounted below it.
  const platformIntegrations = await initializePlatformIntegrations({
    env: process.env,
    broadcast,
  });
  platformDb = platformIntegrations.db;
  const pipedreamClient = platformIntegrations.client;
  const integrationRoutes = platformIntegrations.routes;
  const resolveIntegrationUserId = platformIntegrations.resolveUserId;

  function logHealing(message: string) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [heal] ${message}\n`;
    const logPath = join(homePath, "system/activity.log");
    appendFileAsync(logPath, line).catch((err: unknown) => {
      if (err instanceof Error) {
        console.warn("[heal] failed to append activity log:", err.message);
      } else {
        console.warn("[heal] failed to append activity log:", String(err));
      }
    });
  }

  function broadcast(msg: ServerMessage) {
    const json = JSON.stringify(msg);
    const dead: WSContext[] = [];
    for (const ws of clients) {
      try {
        ws.send(json);
      } catch (error: unknown) {
        console.warn("[gateway] WebSocket broadcast failed:", error instanceof Error ? error.name : "UnknownError");
        dead.push(ws);
      }
    }
    for (const ws of dead) {
      if (clients.delete(ws)) wsConnectionsActive.dec();
    }
  }

  function broadcastToOwner(ownerId: string, msg: ServerMessage) {
    const json = JSON.stringify(msg);
    const dead: WSContext[] = [];
    for (const ws of clients) {
      if (clientOwnerIds.get(ws) !== ownerId) continue;
      try {
        ws.send(json);
      } catch (error: unknown) {
        console.warn("[gateway] Owner WebSocket broadcast failed:", error instanceof Error ? error.name : "UnknownError");
        dead.push(ws);
      }
    }
    for (const ws of dead) {
      if (clients.delete(ws)) wsConnectionsActive.dec();
    }
  }

  function broadcastError(message: string) {
    broadcast({ type: "kernel:error", message });
  }

  function evictOldestMainWsClientIfNeeded() {
    while (clients.size >= MAX_MAIN_WS_CLIENTS) {
      const oldestClient = clients.values().next().value as WSContext | undefined;
      if (!oldestClient) {
        return;
      }

      clients.delete(oldestClient);
      wsConnectionsActive.dec();
      try {
        oldestClient.close(1013, "Too many active WebSocket clients");
      } catch (err) {
        console.warn("[gateway] Failed to close evicted WebSocket client:", err);
      }
      console.warn("[gateway] Evicted oldest main WebSocket client due to client cap");
    }
  }

  async function finalizeWithSummary(sid: string) {
    try {
      await conversationLifecycle.finalize(sid);
      const conv = conversations.get(sid);
      if (conv && conv.messages.length > 0) {
        const summaryMessages = conv.messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role as "user" | "assistant",
            content: message.content,
          }));
        const summary = summarizeConversation({ id: conv.id, messages: summaryMessages });
        if (summary) saveSummary(homePath, sid, summary);

        const candidates = extractMemoriesLocal(summaryMessages);
        if (candidates.length > 0) {
          try {
            const memStore = createMemoryStore(dispatcher.db);
            for (const c of candidates) {
              memStore.remember(c.content, { source: sid, category: c.category });
            }
          } catch (err: unknown) {
            logBestEffortFailure("Memory extraction failed", err);
          }
        }
      }
    } catch (err: unknown) {
      logBestEffortFailure(`Summary finalization failed for session ${sid}`, err);
    }
  }

  const heartbeat: Heartbeat = createHeartbeat({
    homePath,
    onHealthFailure: async (target, error) => {
      const modulePath = join(homePath, "modules", target.name);

      logHealing(`Module "${target.name}" failed health checks: ${error}`);
      broadcastError(`Module "${target.name}" is unhealthy: ${error}. Attempting auto-heal...`);

      backupModule(homePath, target.name, modulePath);

      const healPrompt =
        `[HEAL] Module "${target.name}" has failed health checks. ` +
        `Error: ${error}. Port: ${target.port}. Path: ${modulePath}. ` +
        `Health endpoint: ${target.healthPath}. ` +
        `A backup has been created at ${join(homePath, ".backup", target.name)}. ` +
        `Diagnose and fix the issue.`;

      try {
        await dispatcher.dispatch(healPrompt, undefined, () => {});

        const result = await checkModuleHealth(target.port, target.healthPath, 5000);
        if (result.ok) {
          logHealing(`Module "${target.name}" healed successfully`);
          broadcastError(`Module "${target.name}" has been healed.`);
        } else {
          restoreModule(homePath, target.name, modulePath);
          logHealing(`Healing failed for "${target.name}": ${result.error}. Restored from backup.`);
          broadcastError(`Auto-heal failed for "${target.name}". Restored from backup.`);
        }
      } catch (err) {
        restoreModule(homePath, target.name, modulePath);
        const msg = err instanceof Error ? err.message : "Unknown error";
        logHealing(`Healing error for "${target.name}": ${msg}. Restored from backup.`);
        broadcastError(`Auto-heal error for "${target.name}": ${msg}. Restored from backup.`);
      }
    },
  });

  heartbeat.start();

  const watchdog: Watchdog = createWatchdog({
    homePath,
    onRevert: (commitMsg) => {
      logHealing(`Watchdog reverted evolver commit: ${commitMsg}`);
      broadcastError(`Evolver change reverted: ${commitMsg}`);
    },
  });

  const configPath = join(homePath, "system/config.json");
  const { channelManager, pushAdapter, codingAgentAttentionNotifications } = initializeGatewayChannels({
    homePath, configPath, dispatcher, conversations, codingAgentThreadStore,
    codingAgentNotificationPreferenceStore, finalizeWithSummary, logBestEffortFailure, channelStt: speechRuntime.channelStt,
  });

  // Cron service -- scheduled tasks from ~/system/cron.json
  const cronStore = createCronStore(join(homePath, "system", "cron.json"));
  const cronService: CronService = createCronService({
    store: cronStore,
    onTrigger: (job) => {
      if (job.target?.channel && job.target?.chatId) {
        const formatted = formatForChannel(job.target.channel, job.message);
        channelManager.send({
          channelId: job.target.channel,
          chatId: job.target.chatId,
          text: formatted,
        });
      }
    },
  });
  cronService.start();

  // Heartbeat runner -- periodic kernel invocation
  let heartbeatConfig: { everyMinutes?: number; activeHours?: { start: string; end: string } } = {};
  try {
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      heartbeatConfig = cfg.heartbeat ?? {};
    }
  } catch (err: unknown) {
    logBestEffortFailure("Failed to load heartbeat config", err);
  }

  const proactiveHeartbeat: HeartbeatRunner = createHeartbeatRunner({
    homePath,
    dispatcher,
    channelManager,
    everyMinutes: heartbeatConfig.everyMinutes,
    activeHours: heartbeatConfig.activeHours,
  });
  proactiveHeartbeat.start();

  let approvalPolicy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY;
  try {
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      if (cfg.approval) {
        approvalPolicy = { ...DEFAULT_APPROVAL_POLICY, ...cfg.approval };
      }
    }
  } catch (err: unknown) {
    logBestEffortFailure("Failed to load approval config", err);
  }

  const interactionLogger: InteractionLogger = createInteractionLogger(homePath);

  // Plugin system
  const pluginRegistry: PluginRegistry = createPluginRegistry();
  const hookRunner: HookRunner = createHookRunner(pluginRegistry);
  let loadedPlugins: LoadedPlugin[] = [];

  let pluginsConfig: { list?: string[]; configs?: Record<string, Record<string, unknown>> } = {};
  try {
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      pluginsConfig = cfg.plugins ?? {};
    }
  } catch (err: unknown) {
    logBestEffortFailure("Failed to load plugin config", err);
  }

  const provisioner = createProvisioner({
    homePath,
    dispatcher,
    broadcast,
  });

  watcher.on((change) => {
    broadcast(change);
    if (change.path === "system/setup-plan.json") {
      provisioner.onSetupPlanChange().catch((err: Error) => {
        broadcastError(`Provisioning error: ${err.message}`);
      });
    }
    if (change.path === "system/cron.json") {
      cronService.stop();
      cronService.start();
    }
  });

  // Dev-only escape hatch. Apps render in a null-origin sandboxed srcdoc iframe,
  // so their /apps/{slug}/assets/* sub-resources are cross-site from origin
  // "null" and a SameSite=Strict app-session cookie can never be delivered over
  // plain-HTTP localhost — assets 401 and surface as CORS errors, so no app
  // loads. When MATRIX_DEV_APP_AUTH_BYPASS=1, reflect the "null" origin and skip
  // the app-session gate so apps load locally. NEVER set this in production
  // (only docker-compose.dev.yml sets it).
  const APP_AUTH_DEV_BYPASS = process.env.MATRIX_DEV_APP_AUTH_BYPASS === "1";
  if (APP_AUTH_DEV_BYPASS) {
    console.warn(
      "[gateway] MATRIX_DEV_APP_AUTH_BYPASS=1 — null-origin CORS + app-session auth relaxed for LOCAL DEV ONLY. Never enable in production.",
    );
  }
  app.use("*", cors({
    origin: (origin) => {
      if (APP_AUTH_DEV_BYPASS && origin === "null") return "null";
      return allowedOriginController.resolve(origin);
    },
  }));
  app.use("*", securityHeadersMiddleware());
  app.use("*", authMiddleware(process.env.MATRIX_AUTH_TOKEN));
  const legacyProjectPathAdmission = gatewayCollaboration
    ? createLegacyProjectPathAdmission({
        homePath,
        projectOperationAdmission: gatewayCollaboration.projectOperationAdmission,
        listOwnerProjects: async (ownerType, ownerId) => {
          const result = await codingAgentProjectManager.listManagedProjects({
            visibility: "all",
            ownerScope: { type: ownerType === "organization" ? "org" : "user", id: ownerId },
          });
          return result.projects.map((project) => ({ id: project.id, localPath: project.localPath }));
        },
      })
    : undefined;
  app.route("/api/speech", speechRuntime.routes);
  app.route("/api/onboarding", createReadinessRoutes({ service: readinessService }));
  app.route("/api/onboarding", createToolPackRoutes({ service: toolPackService }));
  app.route("/api/agents", createAgentCredentialRoutes({ service: agentCredentialService }));
  app.route("/api/coding-agents", createCodingAgentRoutes({
    service: codingAgentRuntimeSummaryService,
    projectWorkspaces: codingAgentProjectWorkspaceStore,
    projectMutations: createCodingAgentProjectMutationService({ projects: codingAgentProjectManager }),
    threads: codingAgentThreadStore,
    turns: codingAgentTurnsEnabled ? codingAgentThreadStore : undefined,
    reviews: codingAgentReviewSummaryStore,
    files: codingAgentFileStore,
    sourceControl: codingAgentSourceControlStore,
    notificationPreferences: codingAgentNotificationPreferenceStore,
    ...(gatewayCollaboration ? {
      projectOperationAdmission: gatewayCollaboration.projectOperationAdmission,
      resolveProjectId: async (principal, projectSlug) => {
        const project = await codingAgentProjectManager.getProject(
          projectSlug,
          { type: "user", id: principal.userId },
        );
        return project.ok ? project.project.id : null;
      },
    } : {}),
  }));
  app.route("/api/integrations", createIntegrationCapabilityRoutes({
    service: integrationCapabilityService,
    audit: agentActionAuditService,
  }));
  app.route("/api/admin", createAdminControlRoutes({ service: adminControlService }));
  app.route("/api/company-brain", createCompanyBrainRoutes({ service: companyBrainService }));
  app.route("/api/support-growth", createDraftActionRoutes({ service: draftActionService }));
  const { shellRouteDeps, terminalWorkspaceProjectAdmission,
    chatBoundWorkspaceRouteDeps, systemActivityCandidates } = registerShellTerminalRoutes({
    app, homePath, terminalWorkspaceRuntime, terminalRuntimeOwnerIds,
    terminalWindowLayoutStore, shellPreferencesStore, chatRepository,
    canonicalChatExecutionRoots, gatewayCollaboration,
  });

  const processManager = registerDeferredRuntimeRoutes({
    app, homePath, integrationRoutes, internalIntegrationBaseUrl,
    internalPlatformToken, internalPlatformUrl, internalHandle,
    proxyIntegrationRequest, devAppAuthBypass: APP_AUTH_DEV_BYPASS,
    posthogErrorTracker, ownerTelemetryDistinctId,
  });

  registerMainWebSocketRoutes({
    app, upgradeWebSocket, syncReport,
    isSyncReportSent: () => syncReportSent,
    markSyncReportSent: () => { syncReportSent = true; },
    syncPeerRegistry, conversationRuns, conversationLifecycle, conversationContextResolver,
    reconnectableAbortControllers, clients, clientOwnerIds, conversations, dispatcher,
    approvalPolicy, captureGatewayProductEvent, evictOldestMainWsClientIfNeeded,
    finalizeWithSummary, logUnexpectedJsonParseFailure,
  });

  app.get(
    "/ws/forward",
    upgradeWebSocket(() => forwardTunnelHub.createHandler()),
  );

  registerTerminalWebSocketRoutes({
    app, upgradeWebSocket, homePath, terminalWorkspaceRuntime, terminalLiveOwnership,
    workspaceSessionRuntimeBridge, terminalRuntimeOwnerIds, chatRepository,
    terminalWorkspaceProjectAdmission, captureTerminalEvent,
    getPrincipal: requireRequestPrincipal,
    logBestEffortFailure, logUnexpectedJsonParseFailure, logUnexpectedWsSendFailure,
  });

  registerCodingAgentThreadWebSocketRoutes({
    app, upgradeWebSocket, codingAgentThreadStream,
    logBestEffortFailure, logUnexpectedWsSendFailure,
  });

  registerVoiceWebSocketRoutes({
    app, upgradeWebSocket, homePath, geminiLiveConnection, readinessService,
    captureGatewayProductEvent,
  });

  registerFileRoutes(app, {
    homePath,
    filePreviewService,
    getPrincipal: (c) => requireRequestPrincipal(c),
    ...(legacyProjectPathAdmission ? {
      getOwnerId: (c) => requireRequestPrincipal(c).userId,
      projectPathAdmission: legacyProjectPathAdmission,
    } : {}),
  });

  const bridgeQueryBodyLimit = bodyLimit({ maxSize: 1_000_000 });
  const bridgeDataBodyLimit = bodyLimit({ maxSize: 1_000_000 });
  const upgradeBodyLimit = bodyLimit({ maxSize: 4096 });
  registerMessageLayoutRoutes({
    app, homePath, dispatcher, logBestEffortFailure, logUnexpectedJsonParseFailure,
  });

  registerBridgeDataRoutes(app, {
    homePath, queryEngine, appRegistry, kvStore, ensureAppProvisioned,
    broadcast, queryBodyLimit: bridgeQueryBodyLimit, dataBodyLimit: bridgeDataBodyLimit,
    logUnexpectedJsonParseFailure,
  });

  app.route("/api/bridge/ai", createRuntimeAppAiRoutes({
    homePath,
    ownerIds: [process.env.MATRIX_USER_ID, process.env.MATRIX_CLERK_USER_ID]
      .filter((id): id is string => Boolean(id)),
    fundedCredentialProvider,
  }));

  app.route("/api/bridge/service", createIntegrationBridgeRoutes({
    platformDb,
    pipedream: pipedreamClient,
    resolveUserId: resolveIntegrationUserId,
  }));

  registerConversationHistoryRoutes(app, {
    conversations,
    conversationLifecycle,
    conversationRuns,
    contextResolver: conversationContextResolver,
    getOwnerScope: (c) => ({ type: "user", id: requireRequestPrincipal(c).userId }),
  });

  registerHomeUtilityRoutes({
    app, homePath, conversations, canvasService, dispatcher, cronService,
    channelManager, interactionLogger, broadcast, logBestEffortFailure,
  });

  registerSystemOperatorRoutes({
    app, homePath, model: config.model, runningVersion, interactionLogger, pushAdapter,
    posthogErrorTracker, ownerTelemetryDistinctId, upgradeBodyLimit, logBestEffortFailure,
  });

  // Spec 101: Hermes dashboard proxy (loopback only, auth-gated)
  const hermesDashboardUrl = process.env.HERMES_DASHBOARD_URL
    ?? "http://127.0.0.1:9119";
  try {
    validateHermesDashboardUrl(hermesDashboardUrl);
  } catch (err) {
    console.error(
      "[hermes-proxy] startup validation failed:",
      err instanceof Error ? err.message : "UnknownError",
    );
    throw err;
  }
  const hermesClient = createHermesDashboardClient({
    baseUrl: hermesDashboardUrl,
    authFilePath: join(homePath, "system/agent-runtime/hermes-dashboard.env"),
  });
  const openClawRpc = createLazyOpenClawRpc(homePath);
  await cleanupStaleIsolatedProviderProcesses();
  const agentRuntimeServices = createAgentRuntimeServices({
    homePath,
    client: hermesClient,
    openClawRpc,
  });
  await agentRuntimeServices.controller.reconcile();
  const aiProviderService = new AiProviderService({
    homePath,
    fundedCredentialProvider,
    fundedReadinessReader: fundedAiRuntimeConfig && fundedAiFundingSummaryReader
      ? createFundedAiReadinessReader({
        relayBaseUrl: fundedAiRuntimeConfig.relayBaseUrl,
        summary: fundedAiFundingSummaryReader,
      })
      : undefined,
    driverInventory: createProviderDriverInventoryReader({
      detectAgentInstallations: agentCredentialLauncher.detectAgentInstallations,
      runtimeSource: agentRuntimeServices.source,
    }),
  });
  collaborationProviderSnapshots.attach(aiProviderService);
  const providerLoginCoordinator = createProviderTerminalLoginCoordinator({
    homePath,
    registry: providerLoginTerminalRegistry,
    enabledHarnesses: codingAgentWorkspaceAgents.filter(
      (agent): agent is "codex" | "claude" => agent === "codex" || agent === "claude",
    ),
  });
  const providerAccountLifecycle = createDefaultProviderCliAccountLifecycleCoordinator({
    homePath,
    enabledHarnesses: codingAgentWorkspaceAgents,
  });
  const providerGenericHarnessCoordinator = createProviderGenericHarnessCoordinator({
    homePath,
    runtimeController: agentRuntimeServices.controller,
    runtimeSource: agentRuntimeServices.source,
    enabledCodingHarnesses: codingAgentWorkspaceAgents.filter(
      (agent): agent is "pi" | "opencode" => agent === "pi" || agent === "opencode",
    ),
  });
  await reconcileProviderRuntimeAtStartup(providerGenericHarnessCoordinator);
  const genericHarnessModelCatalog = createGenericHarnessModelCatalogReader({
    homePath,
    enabledHarnesses: codingAgentWorkspaceAgents.filter(
      (agent): agent is "pi" | "opencode" => agent === "pi" || agent === "opencode",
    ),
  });
  providerSettingsStore = new ProviderSettingsStore({
    homePath,
    providerSnapshotReader: aiProviderService,
    loginCoordinator: providerLoginCoordinator,
    accountLifecycle: providerAccountLifecycle,
    fundingSummaryReader: fundedAiFundingSummaryReader,
    runtimeCoordinator: providerGenericHarnessCoordinator,
    genericModelCatalogReader: genericHarnessModelCatalog,
  });
  const canonicalExecutableDriverKinds = [
    "kernel" as const,
    "hermes" as const,
    "openclaw" as const,
    ...(codingAgentProviders.some((provider) => provider.providerId === "claude")
      ? ["claude_code" as const]
      : []),
    ...(codingAgentThreadStore
      && codingAgentProviders.some((provider) => provider.providerId === "codex")
      ? ["codex" as const]
      : []),
    ...(codingAgentThreadStore
      && codingAgentProviders.some((provider) => provider.providerId === "pi")
      ? ["pi" as const]
      : []),
    ...(codingAgentThreadStore
      && codingAgentProviders.some((provider) => provider.providerId === "opencode")
      ? ["opencode" as const]
      : []),
  ];
  const {
    catalog: canonicalChatProviderCatalog, resolveClaudeCredentialLaunch,
  } = createGatewayChatProviderCatalog({
    homePath,
    codexExecutable,
    fundedCredentialProvider,
    codingProviders: codingAgentProviderRegistry,
    agentRuntimeSource: agentRuntimeServices.source,
    systemRuntimeSources: agentRuntimeServices.systemRuntimeSources,
    aiProviderSource: aiProviderService,
    harnessSettingsSource: providerSettingsStore,
    executableDriverKinds: canonicalExecutableDriverKinds,
    credentialedDriverKinds: ["pi", "opencode"],
  });
  if (chatRepository && canonicalChatExecutionRoots) {
    const canonicalAdapters: CanonicalChatProviderAdapter[] = [
      createKernelChatProviderAdapter({ dispatcher }),
      createHermesChatProviderAdapter({ homePath, toolOutputKey }),
      createOpenClawChatProviderAdapter({ rpc: openClawRpc, homePath }),
    ];
    if (codingAgentProviders.some((provider) => provider.providerId === "claude")) {
      canonicalAdapters.push(createClaudeChatProviderAdapter({
        homePath,
        resolveCredentialLaunch: resolveClaudeCredentialLaunch,
      }));
    }
    if (codingAgentThreadStore) {
      if (codingAgentProviders.some((provider) => provider.providerId === "codex")) {
        canonicalAdapters.push(createCanonicalCodingChatProviderAdapter({
          providerId: "codex",
          threads: codingAgentThreadStore,
          toolOutputKey,
          nativeInputProvider: codingAgentProviders.find(provider => provider.providerId === "codex"),
        }));
      }
      if (codingAgentProviders.some((provider) => provider.providerId === "pi")) {
        canonicalAdapters.push(createCanonicalCodingChatProviderAdapter({
          providerId: "pi",
          threads: codingAgentThreadStore,
          toolOutputKey,
          nativeInputProvider: codingAgentProviders.find(provider => provider.providerId === "pi"),
        }));
      }
      if (codingAgentProviders.some((provider) => provider.providerId === "opencode")) {
        canonicalAdapters.push(createCanonicalCodingChatProviderAdapter({
          providerId: "opencode",
          threads: codingAgentThreadStore,
          toolOutputKey,
          nativeInputProvider: codingAgentProviders.find(provider => provider.providerId === "opencode"),
        }));
      }
    }
    canonicalChatRuntime = await createCanonicalChatRuntime({
      homePath,
      repository: chatRepository,
      catalog: canonicalChatProviderCatalog,
      adapters: new CanonicalChatProviderRegistry(canonicalAdapters.map(adapter => withAsyncChatInput(adapter))),
      executionRoots: canonicalChatExecutionRoots,
      ...(canonicalChatCollaborationGuard ? { collaborationGuard: canonicalChatCollaborationGuard } : {}),
      ...(gatewayCollaboration ? {
        onSharedEvent: (scopeId: string) => gatewayCollaboration!.eventRegistry.broadcastScope(scopeId),
      } : {}),
      onAiGeneration: recordAiGeneration,
    });
    canonicalChatOrchestrator = canonicalChatRuntime.orchestrator;
    backgroundChatProjection.setReconciler(ownerId => canonicalChatOrchestrator?.reconcileActiveRuns({ type: "personal", ownerId }) ?? Promise.resolve());
    // Shared AI marks runs the previous process lost (gateway_restart) before the
    // owner reconcile loop below finishes them; the reverse order loses attribution.
    if (gatewayCollaboration) {
      // S07: this layer has no execution-root resolver, so no `sandboxManifests` source is passed
      // and shared AI reports no eligibility instead of offering runs that would fail at launch.
      // S09 supplies the resolver; a shared run never falls back to an unsandboxed profile.
      const sharedAi = await gatewayCollaboration.enableSharedAi({
        orchestrator: canonicalChatOrchestrator,
        homePath,
        providerCatalog: canonicalChatProviderCatalog,
        codingProviders: codingAgentProviderRegistry,
        // S09: the canonical resolver is the S07 sandbox manifest source; without it
        // shared AI reports no eligibility instead of launching unmounted runs.
        ...(canonicalChatExecutionRoots ? { executionRoots: canonicalChatExecutionRoots } : {}),
        ...(fundedCredentialProvider ? { fundedCredentialProvider } : {}),
      });
      console.log(`[collaboration] shared AI ${sharedAi.available ? "ready" : "disabled"}`);
    }
    for (const ownerId of new Set(codingAgentOwnerIds)) {
      await canonicalChatOrchestrator.reconcileActiveRuns({ type: "personal", ownerId });
    }
    if (codingAgentThreadStore && codingAgentWorkspaceRuntime && codexEventBridge) {
      const repository = chatRepository;
      const bridge = codexEventBridge;
      const uid = process.getuid?.();
      chatIdleReaper = createChatIdleReaper({
        sessions: codingAgentWorkspaceRuntime,
        terminalRuntime: terminalWorkspaceRuntime,
        backgroundRuntime: backgroundAgentRuntime,
        threads: codingAgentThreadStore,
        control: createCodexControlClient({ homePath }),
        admitCanonical: (identity, reclaim) => withCanonicalIdleChat(repository.kysely, identity, reclaim),
        unwatch: (sessionId) => bridge.unwatch(sessionId),
        underPressure: () => terminalTasksUnderPressure(
          `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/matrix.slice/matrix-terminal.slice`,
        ),
      });
    }
  }
  // Bind deletion and run tombstone recovery only after Chat dependencies are ready.
  const deleteProjectChats = chatRepository && canonicalChatOrchestrator
    ? createProjectChatCleanup({ repository: chatRepository, orchestrator: canonicalChatOrchestrator })
    : async () => { throw new Error("Project chat cleanup unavailable"); };
  app.route("/", createWorkspaceRoutes({
    homePath,
    backgroundRuntime: backgroundAgentRuntime,
    terminalRuntime: terminalWorkspaceRuntime,
    agentLauncher: agentCredentialLauncher,
    sessionRuntimeBridge: workspaceSessionRuntimeBridge,
    eventStore: workspaceEventStore,
    eventPublisher: workspaceEventPublisher,
    reviewStore,
    codingAgentThreadStore,
    deleteProjectChats,
    getOwnerScope: (c) => ({ type: "user", id: requireRequestPrincipal(c).userId }),
    ...(gatewayCollaboration ? {
      projectOperationAdmission: gatewayCollaboration.projectOperationAdmission,
    } : {}),
    ...chatBoundWorkspaceRouteDeps,
  }));
  app.route("/api", createShellRoutes(shellRouteDeps));
  app.route("/api/symphony", createElixirSymphonyProxyRoutes({
    upstreamOrigin: symphonyUpstreamOriginForPort(initialSymphonyPort),
  }));
  const workspaceStartupRecoveryController = createWorkspaceStartupRecovery({
    deleteProjectChats,
    homePath,
    backgroundRuntime: backgroundAgentRuntime,
    eventPublisher: workspaceEventPublisher,
    codingAgentThreadStore,
  });
  const workspaceStartupRecovery = await workspaceStartupRecoveryController.run();
  if (workspaceStartupRecovery.status === "degraded") {
    console.warn("[gateway] Workspace startup recovery completed with degraded steps");
  }

  if (!providerSettingsStore) throw new Error("Provider settings are unavailable");
  registerCollaborationChatRoutes({
    app, upgradeWebSocket, canonicalChatEventStream, chatRepository, gatewayCollaboration,
    collaborationFailClosedReason, canonicalChatOrchestrator, canonicalChatExecutionRoots,
    canonicalChatCollaborationGuard, projectOwnerToolOutput, canonicalChatRuntime,
    canonicalChatProviderCatalog, aiProviderService, providerSettingsStore,
  });

  // T978-T979: Settings API routes
  const settingsRoutes = createSettingsRoutes({
    homePath,
    channelManager,
    agentRuntimeSource: agentRuntimeServices.source,
    agentRuntimeController: agentRuntimeServices.controller,
    aiProviderService,
  });
  app.route("/api/settings", settingsRoutes);
  if (osViewStateRepository) {
    app.route("/api/os-view-state", createOsViewStateRoutes({
      repository: osViewStateRepository,
      getOwnerId: (c) => requireRequestPrincipal(c).userId,
      onChanged: (ownerId, state) => broadcastToOwner(ownerId, {
        type: "os-view:changed",
        revision: state.revision,
        updatedAt: state.updatedAt,
      }),
    }));
  } else {
    app.all("/api/os-view-state", (c) => c.json({ error: "OS-view state is not configured" }, 503));
  }
  app.route("/api/hermes", createHermesRoutes({ client: hermesClient }));

  if (messagingRepository) {
    app.route("/api/messages", createMessagingRoutes({
      repository: messagingRepository,
      getOwnerId: (c) => requireRequestPrincipal(c).userId,
      appserviceToken: process.env.MATRIX_MESSAGING_APPSERVICE_TOKEN,
      appserviceOwnerId: process.env.MATRIX_MESSAGING_APPSERVICE_OWNER_ID ?? process.env.MATRIX_USER_ID ?? process.env.MATRIX_HANDLE,
      hermesCapabilitySecret: process.env.MATRIX_MESSAGING_HERMES_CAPABILITY_SECRET,
    }));
  } else {
    app.all("/api/messages/*", (c) => c.json({ error: { code: "misconfigured", message: "Messaging is not configured" } }, 503));
    app.all("/api/messages", (c) => c.json({ error: { code: "misconfigured", message: "Messaging is not configured" } }, 503));
  }

  registerCanvasGatewayRoutes({
    app, upgradeWebSocket, canvasService, canvasSubscriptionHub,
    gatewayCollaboration, logUnexpectedWsSendFailure,
  });

  // 066: Sync API routes
  if (syncDeps) {
    app.route("/api/sync", createSyncRoutes(syncDeps));
  } else {
    app.route("/api/sync", syncApp);
  }

  // T2030-T2037: Social API routes
  const getCurrentUser = () => {
    const identity = loadHandle(homePath);
    return identity.handle || "@me";
  };
  let socialRoutes: SocialRoutes | undefined;
  if (appDb && queryEngine) {
    await bootstrapSocialSchema(appDb);
    socialRoutes = createSocialRoutes(appDb, queryEngine, getCurrentUser);
    app.route("/api/social", socialRoutes);
  } else {
    app.all("/api/social/*", (c) => c.json({ error: "Database not configured (no DATABASE_URL)" }, 503));
  }

  await registerOperationalRoutes({
    app, homePath, runningVersion, queryEngine, pluginRegistry,
    getLoadedPlugins: () => loadedPlugins, cronService, channelManager,
    upgradeBodyLimit, logUnexpectedJsonParseFailure,
  });

  // Load plugins and mount their HTTP routes
  async function initPlugins() {
    try {
      loadedPlugins = await loadAllPlugins({
        homePath,
        configPaths: pluginsConfig.list,
        registry: pluginRegistry,
        systemConfig: {},
        pluginConfigs: pluginsConfig.configs,
      });

      // T944: Mount plugin HTTP routes
      for (const route of pluginRegistry.getRoutes()) {
        const fullPath = `/plugins/${route.pluginId}${route.path}`;
        const method = route.method.toLowerCase() as "get" | "post" | "put" | "delete" | "patch";
        app[method](fullPath, route.handler);
      }

      // T945: Start background services
      for (const svc of pluginRegistry.getServices()) {
        try {
          await svc.start();
        } catch (err) {
          console.error(`[plugin:${svc.pluginId}] Service ${svc.name} failed to start: ${err}`);
        }
      }

      // T939: Fire gateway_start hook
      await hookRunner.fireVoidHook("gateway_start", { port });
    } catch (err) {
      console.error("[plugins] Failed to initialize plugins:", err);
    }
  }

  await initPlugins().catch((err) => {
    console.error("[plugins] Plugin init error:", err);
  });

  const server = serve({ fetch: app.fetch, port });
  injectWebSocket(server);
  const chatAttachmentCleanup = createChatAttachmentCleanupLifecycle({
    homePath,
    onError: (error) => logBestEffortFailure("Temporary Chat attachment cleanup failed", error),
  });
  void chatAttachmentCleanup.runNow().catch((error: unknown) => {
    logBestEffortFailure("Initial temporary Chat attachment cleanup failed", error);
  });
  const terminalPasteAssetCleanup = startTerminalPasteAssetCleanup({
    homePath,
    onFailure: logBestEffortFailure,
  });

  return {
    app,
    server,
    dispatcher,
    watcher,
    heartbeat,
    watchdog,
    channelManager,
    cronService,
    proactiveHeartbeat,
    pluginRegistry,
    hookRunner,
    async close() {
      workspaceStartupRecoveryController.close();
      await terminalPasteAssetCleanup.close();
      await chatIdleReaper?.close().catch((error: unknown) => {
        logBestEffortFailure("Chat idle runtime reconciliation shutdown failed", error);
      });
      chatIdleReaper = null;
      chatAttachmentCleanup.close();
      await chatAttachmentCleanup.waitForIdle().catch((error: unknown) => {
        logBestEffortFailure("Temporary Chat attachment cleanup shutdown failed", error);
      });

      // T939: Fire gateway_stop hook
      await hookRunner.fireVoidHook("gateway_stop", {}).catch((err: unknown) => {
        logBestEffortFailure("gateway_stop hook failed", err);
      });

      // T945: Stop services in reverse order
      const services = pluginRegistry.getServices();
      for (let i = services.length - 1; i >= 0; i--) {
        try {
          await services[i].stop();
        } catch (err: unknown) {
          logBestEffortFailure(
            `Failed to stop plugin service ${services[i].pluginId}/${services[i].name}`,
            err,
          );
        }
      }

      heartbeat.stop();
      watchdog.stop();
      proactiveHeartbeat.stop();
      cronService.stop();
      await backgroundChatProjection.close();
      await canonicalChatOrchestrator?.close();
      canonicalChatOrchestrator = null;
      await canonicalChatRuntime?.agents.close();
      canonicalChatRuntime = null;
      await gatewayCollaboration?.shutdown();
      gatewayCollaboration = null;
      await backgroundAgentRuntime.close();
      await codingAgentWorkspaceRuntime?.close();
      codingAgentWorkspaceRuntime = null;
      workspaceSessionRuntimeBridge.close();
      terminalLiveOwnership.close();
      await agentRuntimeServices.controller.close();
      aiProviderService.close();
      fundedCredentialProvider?.close();
      await codingAgentTurnLifecycle.shutdown();
      await codexEventBridge?.shutdown();
      codingAgentThreadStream?.shutdown();
      codingAgentAttentionNotifications?.dispose();
      codingAgentSessionStopReconciler.dispose();
      drainReconnectableAbortEntries(reconnectableAbortControllers);
      if (canvasCleanupTimer) clearInterval(canvasCleanupTimer);
      canvasSubscriptionHub?.close();
      systemActivityCandidates.clear();
      await channelManager.stop();
      await processManager.shutdownAll();
      await forwardTunnelHub.close();
      await watcher.close();
      await homeMirror?.stop();
      await homeMirrorStart?.catch((err: unknown) => {
        logBestEffortFailure("Home mirror startup failed during shutdown", err);
      });
      syncR2?.destroy();
      if (canonicalChatEventStream && chatRepository) {
        const repository = chatRepository;
        await closeCanonicalChatEventLifecycle({
          stream: canonicalChatEventStream,
          releaseRepository: () => repository.release(),
        });
      } else {
        await chatRepository?.release();
      }
      canonicalChatEventStream = null;
      chatRepository = null;
      await canvasRepository?.destroy();
      await socialRoutes?.shutdownPostHog();
      await appDb?.destroy();
      await platformDb?.destroy();
      await posthogErrorTracker.shutdown();
      server.close();
    },
  };
}
