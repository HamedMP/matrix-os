export { createGateway } from "./server.js";
export type { GatewayConfig, ServerMessage } from "./server.js";
export { createProvisioner } from "./provisioner.js";
export { createDispatcher } from "./dispatcher.js";
export type { Dispatcher, DispatchOptions, DispatchContext, SpawnFn, BatchEntry, BatchResult } from "./dispatcher.js";
export { createWatcher } from "./watcher.js";
export type { Watcher, FileChangeEvent, FileEvent } from "./watcher.js";
export { createPtyHandler } from "./pty.js";
export type { PtyMessage, PtyServerMessage } from "./pty.js";
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
export { createInteractionLogger } from "./logger.js";
export type { InteractionLogger, InteractionEntry, InteractionInput } from "./logger.js";
export { createGitSync, createAutoSync } from "./git-sync.js";
export type { GitSync, GitStatus, GitResult, AutoSync, AutoSyncOptions } from "./git-sync.js";
export { createS3SyncDaemon, parseSyncignore } from "./s3-sync.js";
export type { S3SyncDaemon, S3SyncConfig, S3FileVersion, ReconcileStats } from "./s3-sync.js";
export { createGitAutoCommit, createSnapshotManager, createFileHistory } from "./git-versioning.js";
export { createBridgeSql } from "./bridge-sql.js";
export type { BridgeSql, QueryResult, ExecResult } from "./bridge-sql.js";
export { createPostgresManager } from "./postgres-manager.js";
export type { PostgresManager, PostgresConfig, AppDatabaseInfo, PostgresStatus } from "./postgres-manager.js";
export { createStorageTracker } from "./storage-tracker.js";
export type { StorageTracker, StorageUsage } from "./storage-tracker.js";
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
} from "./git-versioning.js";
export { authMiddleware } from "./auth.js";
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
} from "./request-principal.js";
export type { PrincipalRuntimeConfig, PrincipalSource, RequestPrincipal, RequestPrincipalError } from "./request-principal.js";
export { getSystemInfo } from "./system-info.js";
export type { SystemInfo } from "./system-info.js";
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
export { createConversationStore } from "./conversations.js";
export type { ConversationStore, ConversationFile, ConversationMeta, SearchResult } from "./conversations.js";
export { createApprovalBridge } from "./approval.js";
export type { ApprovalBridge, ApprovalRequest, ApprovalResponse } from "./approval.js";
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
} from "./metrics.js";
