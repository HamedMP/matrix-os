export { createGateway } from "./server.js";
export type { GatewayConfig, ServerMessage } from "./server.js";
export { createProvisioner } from "./provisioner.js";
export { createDispatcher } from "./domains/sessions/dispatcher.js";
export type {
  Dispatcher,
  DispatchOptions,
  DispatchContext,
  KernelDispatchOverrides,
  SpawnFn,
  BatchEntry,
  BatchResult,
} from "./domains/sessions/dispatcher.js";
export { createWatcher } from "./domains/files/watcher.js";
export type { Watcher, FileChangeEvent, FileEvent } from "./domains/files/watcher.js";
export { createPtyHandler } from "./domains/terminal/pty.js";
export type { PtyMessage, PtyServerMessage } from "./domains/terminal/pty.js";
export { createChannelManager } from "./channels/manager.js";
export type { ChannelManager, ChannelManagerConfig } from "./channels/manager.js";
export { createTelegramAdapter } from "./channels/telegram.js";
export { formatForChannel } from "./channels/format.js";
export type {
  ChannelAdapter,
  ChannelConfig,
  ChannelId,
  ChannelMessage,
  ChannelReply,
} from "./channels/types.js";
export { createCronStore } from "./cron/store.js";
export type { CronStore } from "./cron/store.js";
export { createCronService } from "./cron/service.js";
export type { CronService, CronServiceConfig } from "./cron/service.js";
export type { CronJob, CronSchedule, CronTarget } from "./cron/types.js";
export { createHeartbeatRunner } from "./heartbeat/runner.js";
export type { HeartbeatRunner, HeartbeatConfig } from "./heartbeat/runner.js";
export { buildHeartbeatPrompt } from "./heartbeat/prompt.js";
export { createInteractionLogger } from "./_shared/logger.js";
export type { InteractionLogger, InteractionEntry, InteractionInput } from "./_shared/logger.js";
export { createGitSync, createAutoSync } from "./domains/git/git-sync.js";
export type { GitSync, GitStatus, GitResult, AutoSync, AutoSyncOptions } from "./domains/git/git-sync.js";
export { createS3SyncDaemon, parseSyncignore } from "./domains/files/s3-sync.js";
export type { S3SyncDaemon, S3SyncConfig, S3FileVersion, ReconcileStats } from "./domains/files/s3-sync.js";
export { createGitAutoCommit, createSnapshotManager, createFileHistory } from "./domains/git/git-versioning.js";
export { createBridgeSql } from "./domains/apps/db/bridge-sql.js";
export type { BridgeSql, QueryResult, ExecResult } from "./domains/apps/db/bridge-sql.js";
export { createPostgresManager } from "./_shared/postgres-manager.js";
export type { PostgresManager, PostgresConfig, AppDatabaseInfo, PostgresStatus } from "./_shared/postgres-manager.js";
export { createStorageTracker } from "./domains/files/storage-tracker.js";
export type { StorageTracker, StorageUsage } from "./domains/files/storage-tracker.js";
export type {
  GitAutoCommit,
  AutoCommitResult,
  SnapshotManager,
  SnapshotResult,
  SnapshotEntry,
  FileHistory,
  HistoryEntry,
  HistoryOptions,
  RestoreResult,
} from "./domains/git/git-versioning.js";
export { authMiddleware } from "./domains/identity/auth.js";
export {
  AUTH_CONTEXT_READY_CONTEXT_KEY,
  JWT_CLAIMS_CONTEXT_KEY,
  InvalidRequestPrincipalError,
  MissingRequestPrincipalError,
  RequestPrincipalMisconfiguredError,
  SAFE_PRINCIPAL_USER_ID,
  getOptionalRequestPrincipal,
  isAuthContextReady,
  isRequestPrincipalError,
  mapRequestPrincipalError,
  markAuthContextReady,
  ownerScopeFromPrincipal,
  readPrincipalRuntimeConfig,
  requireRequestPrincipal,
} from "./domains/identity/request-principal.js";
export type { PrincipalRuntimeConfig, PrincipalSource, RequestPrincipal, RequestPrincipalError } from "./domains/identity/request-principal.js";
export { getSystemInfo } from "./domains/observability/system-info.js";
export type { SystemInfo } from "./domains/observability/system-info.js";
export {
  CanvasActionSchema,
  CanvasDocumentWriteSchema,
  CanvasEdgeSchema,
  CanvasIdSchema,
  CanvasNodeSchema,
  ReplaceCanvasRequestSchema,
  validateCanvasDocumentEdges,
} from "./canvas/contracts.js";
export type {
  CanvasAction,
  CanvasDocumentWrite,
  CanvasEdge,
  CanvasNode,
  CanvasOwnerScope,
  CanvasScopeType,
} from "./canvas/contracts.js";
export { CanvasConflictError, CanvasNotFoundError, CanvasRepository } from "./canvas/repository.js";
export type { CanvasOwner, CanvasRecord, CreateCanvasInput, ReplaceCanvasInput } from "./canvas/repository.js";
export { CanvasService, mapCanvasError } from "./canvas/service.js";
export type { CanvasDocumentResult, CanvasListResult, CanvasSafeError } from "./canvas/service.js";
export { createCanvasRoutes } from "./canvas/routes.js";
export type { CanvasRouteDeps, CanvasRouteService } from "./canvas/routes.js";
export { CanvasSubscriptionHub } from "./canvas/subscriptions.js";
export type { CanvasSubscriber, CanvasSubscriptionHubOptions } from "./canvas/subscriptions.js";
export { OsViewStateConflictError, OsViewStateRepository } from "./os-view-state/repository.js";
export { createOsViewStateRoutes } from "./os-view-state/routes.js";
export type { OsViewStateRouteRepository } from "./os-view-state/routes.js";
export { createMessagingRoutes } from "./messages/routes.js";
export { MessagingError, mapMessagingError } from "./messages/errors.js";
export { MessagingKyselyRepository } from "./messages/repository.js";
export { createPermissionRegistry } from "./messages/permission-registry.js";
export { createHermesCapabilityToken, verifyHermesCapabilityToken } from "./messages/hermes-capability.js";
export { HermesDeliveryRegistry } from "./messages/hermes-delivery.js";
export { evaluateAutomationRules } from "./messages/automation-evaluator.js";
export { createAutomationActionRunner } from "./messages/automation-actions.js";
export { createMessagingBridgeHealthService } from "./messages/bridge-health.js";
export type { MessagingBridgeHealthService, MessagingHealthSummary } from "./messages/bridge-health.js";
export type {
  MessagingRepository,
  MessagingOwnerScope,
  MessagingListResult,
  MessagingBridgeAccountProvider,
} from "./messages/repository.js";
export { createSymphonyRunner, SymphonyConfigSchema, SymphonyConfigUpdateSchema, SymphonyTrackerConfigSchema, SymphonyTrackerConfigUpdateSchema } from "./symphony-runner.js";
export type { SymphonyConfig, SymphonyConfigUpdate, SymphonyStatus, SymphonyStartResult } from "./symphony-runner.js";
export * from "./symphony/index.js";
export { createConversationStore } from "./domains/sessions/conversations.js";
export type { ConversationStore, ConversationFile, ConversationMeta, SearchResult } from "./domains/sessions/conversations.js";
export { createApprovalBridge } from "./domains/sessions/approval.js";
export type { ApprovalBridge, ApprovalRequest, ApprovalResponse } from "./domains/sessions/approval.js";
export {
  metricsRegistry,
  httpRequestsTotal,
  httpRequestDuration,
  kernelDispatchTotal,
  kernelDispatchDuration,
  wsConnectionsActive,
  aiCostTotal,
  aiTokensTotal,
  normalizePath,
} from "./domains/observability/metrics.js";
