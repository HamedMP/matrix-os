/**
 * Orchestrate owner Postgres startup as one transaction of process resources.
 * A partial bootstrap must release every acquired handle before the gateway
 * resumes in file storage mode; callers receive no partially usable bag.
 */
import {
  teardownOwnerDatabaseServices,
  type OwnerDatabaseFallbackServices,
  type OwnerDatabaseFallbackStep,
} from "./owner-database-fallback.js";
import { join } from "node:path";
import { type Kysely } from "kysely";
import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import { createAppDb, type AppDb } from "../app-db.js";
import { createAppRegistry, type AppRegistry } from "../app-db-registry.js";
import { createQueryEngine, type QueryEngine } from "../app-db-query.js";
import { createKvStore, type KvStore } from "../app-db-kv.js";
import { isSafeName, normalizeAppStorageSlug } from "../app-db-types.js";
import { listApps } from "../apps.js";
import type { CanonicalProviderSnapshotReader } from "../ai-providers/provider-settings-coordinators.js";
import type { AiCaptureFn } from "../ai-analytics.js";
import { CanvasRepository } from "../canvas/repository.js";
import { CanvasConfigurationError, CanvasService } from "../canvas/service.js";
import { CanvasSubscriptionHub } from "../canvas/subscriptions.js";
import { cleanupCanvasTempFiles } from "../canvas/recovery.js";
import { bootstrapChatSharing } from "../chat/sharing.js";
import { createChatExecutionRootResolver, type ChatExecutionRootResolver } from "../chat/execution-root.js";
import { createGatewayChatEventStream } from "../chat/gateway-event-stream.js";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import type { OwnerToolOutputProjection } from "../chat/owner-tool-output.js";
import { ChatRepository } from "../chat/repository.js";
import { createDiscussionOnlyChatExecutionGuard } from "../collaboration/chat-scope.js";
import type { GatewayCollaborationConfig, GatewayCollaborationConfigurationFailure, GatewayCollaborationRuntime } from "../collaboration/wiring.js";
import { MessagingKyselyRepository } from "../messages/repository.js";
import { registerNativeAppStorage } from "../native-app-storage.js";
import { OsViewStateRepository } from "../os-view-state/repository.js";
import type { createProjectManager } from "../project-manager.js";
import type { createWorktreeManager } from "../worktree-manager.js";
import { constructOwnerCollaboration } from "./collaboration.js";

export interface OwnerDatabaseBootstrapOptions {
  databaseUrl?: string;
  services: OwnerDatabaseFallbackServices;
  initialize(services: OwnerDatabaseFallbackServices): Promise<void>;
  warn?(step: OwnerDatabaseFallbackStep | "OwnerDatabaseStartupFailure", error: unknown): void;
}

export interface OwnerDatabaseBootstrapResult {
  services: OwnerDatabaseFallbackServices | null;
  failureReason: "owner_database_missing" | null;
}

export async function bootOwnerDatabaseWithFallback(
  options: OwnerDatabaseBootstrapOptions,
): Promise<OwnerDatabaseBootstrapResult> {
  if (!options.databaseUrl) {
    return { services: null, failureReason: "owner_database_missing" };
  }
  try {
    await options.initialize(options.services);
    return { services: options.services, failureReason: null };
  } catch (error: unknown) {
    const warn = options.warn ?? ((step: string, cause: unknown) => {
      console.warn(`[app-db] ${step}`, cause instanceof Error ? cause.name : "UnknownError");
    });
    warn("OwnerDatabaseStartupFailure", error);
    await teardownOwnerDatabaseServices(options.services, { warn });
    return { services: null, failureReason: "owner_database_missing" };
  }
}

export interface OwnerDatabaseServices extends OwnerDatabaseFallbackServices {
  appDb: AppDb | null;
  queryEngine: QueryEngine | null;
  kvStore: KvStore | null;
  appRegistry: AppRegistry | null;
  kyselyInstance: Kysely<any> | null;
  canvasRepository: CanvasRepository | null;
  osViewStateRepository: OsViewStateRepository | null;
  canvasService: CanvasService | null;
  canvasSubscriptionHub: CanvasSubscriptionHub | null;
  canvasCleanupTimer: ReturnType<typeof setInterval> | null;
  chatRepository: ChatRepository | null;
  chatEventStream: ReturnType<typeof createGatewayChatEventStream> | null;
  chatExecutionRoots: ChatExecutionRootResolver | null;
  chatCollaborationGuard: ReturnType<typeof createDiscussionOnlyChatExecutionGuard> | null;
  collaboration: GatewayCollaborationRuntime | null;
  messagingRepository: MessagingKyselyRepository | null;
}

export interface InitializeOwnerDatabaseOptions {
  databaseUrl?: string;
  homePath: string;
  collaborationConfig: GatewayCollaborationConfig | null;
  initialFailureReason: GatewayCollaborationConfigurationFailure | null;
  providerSnapshotReader: CanonicalProviderSnapshotReader;
  codingAgentProjectManager: ReturnType<typeof createProjectManager>;
  codingAgentWorktreeManager: ReturnType<typeof createWorktreeManager>;
  terminalWorkspaceRuntime: TerminalRuntimeSocketClient;
  terminalRuntimeOwnerIds: readonly string[];
  projectOwnerToolOutput: OwnerToolOutputProjection;
  capture: AiCaptureFn;
  runningVersion: string;
  getCanonicalChatOrchestrator(): CanonicalChatOrchestrator | null;
  rememberProvisionedAppSlug(slug: string): void;
  logBestEffortFailure(context: string, error: unknown): void;
}

export interface InitializeOwnerDatabaseResult {
  services: OwnerDatabaseServices | null;
  failClosedReason: GatewayCollaborationConfigurationFailure | null;
}

export async function initializeOwnerDatabaseServices(
  options: InitializeOwnerDatabaseOptions,
): Promise<InitializeOwnerDatabaseResult> {
  const services: OwnerDatabaseServices = {
    appDb: null, queryEngine: null, kvStore: null, appRegistry: null,
    kyselyInstance: null, canvasRepository: null, osViewStateRepository: null,
    canvasService: null, canvasSubscriptionHub: null, canvasCleanupTimer: null,
    chatRepository: null, chatEventStream: null, chatExecutionRoots: null,
    chatCollaborationGuard: null, collaboration: null, messagingRepository: null,
  };
  let failClosedReason = options.initialFailureReason;
  const result = await bootOwnerDatabaseWithFallback({
    databaseUrl: options.databaseUrl,
    services,
    initialize: async () => {
      const { db, kysely } = createAppDb(options.databaseUrl!);
      services.appDb = db;
      services.kyselyInstance = kysely;
      await db.bootstrap();
      services.queryEngine = createQueryEngine(db);
      const kvStore = createKvStore(kysely);
      services.kvStore = kvStore;
      const appRegistry = createAppRegistry(db, kysely);
      services.appRegistry = appRegistry;
      for (const slug of await registerNativeAppStorage(appRegistry)) {
        options.rememberProvisionedAppSlug(slug);
      }
      const canvasRepository = new CanvasRepository(kysely as Kysely<any>);
      services.canvasRepository = canvasRepository;
      await canvasRepository.bootstrap();
      const osViewStateRepository = new OsViewStateRepository(kysely as Kysely<any>);
      services.osViewStateRepository = osViewStateRepository;
      await osViewStateRepository.bootstrap();
      const chatRepository = new ChatRepository(kysely as Kysely<any>);
      services.chatRepository = chatRepository;
      await chatRepository.bootstrap();
      const ownerChatExecutionRoots = createChatExecutionRootResolver({
        homePath: options.homePath,
        projects: options.codingAgentProjectManager,
        worktrees: options.codingAgentWorktreeManager,
      });
      services.chatExecutionRoots = ownerChatExecutionRoots;
      services.chatCollaborationGuard = createDiscussionOnlyChatExecutionGuard(chatRepository.kysely as Kysely<any>);
      await bootstrapChatSharing(chatRepository.kysely);
      if (options.collaborationConfig) {
        const construction = await constructOwnerCollaboration({
          homePath: options.homePath, chatRepository, appRegistry, canvasRepository,
          collaborationConfig: options.collaborationConfig,
          providerSnapshotReader: options.providerSnapshotReader,
          codingAgentProjectManager: options.codingAgentProjectManager,
          ownerChatExecutionRoots, terminalWorkspaceRuntime: options.terminalWorkspaceRuntime,
        });
        if (construction.ok) services.collaboration = construction.runtime;
        else failClosedReason = construction.reason;
      }
      services.chatEventStream = createGatewayChatEventStream({
        projectOwnerToolOutput: options.projectOwnerToolOutput,
        repository: chatRepository,
        reconcileOwner: (owner) => options.getCanonicalChatOrchestrator()?.reconcileActiveRuns(owner) ?? Promise.resolve(),
        capture: options.capture,
        runtimeVersion: options.runningVersion,
        buildSha: process.env.MATRIX_BUILD_SHA,
      });
      services.canvasService = new CanvasService(canvasRepository, {
        terminalRuntime: options.terminalWorkspaceRuntime,
        terminalOwnerIds: [...options.terminalRuntimeOwnerIds],
        homePath: options.homePath,
        resolveProjectWorkingDirectory: async (ownerId, projectId) => {
          const project = await options.codingAgentProjectManager.getProjectById(
            { type: "user", id: ownerId }, projectId,
          );
          if (!project.ok) {
            if (project.status === 404 || project.status === 400) return null;
            throw new CanvasConfigurationError("project lookup is unavailable");
          }
          return options.codingAgentProjectManager.resolveProjectWorkingDirectory(project.project);
        },
      });
      const messagingRepository = new MessagingKyselyRepository(kysely as Kysely<any>);
      services.messagingRepository = messagingRepository;
      await messagingRepository.bootstrap();
      services.canvasSubscriptionHub = new CanvasSubscriptionHub({
        authorize: async (subscriber) => Boolean(await canvasRepository.get(
          { ownerScope: "personal", ownerId: subscriber.userId }, subscriber.canvasId,
        )),
      });
      const canvasExportDir = join(options.homePath, "system", "canvas-exports");
      const canvasCleanupPolicy = { ttlMs: 7 * 24 * 60 * 60 * 1000, maxFiles: 100 };
      await cleanupCanvasTempFiles(canvasExportDir, canvasCleanupPolicy);
      let canvasCleanupFailures = 0;
      services.canvasCleanupTimer = setInterval(() => {
        void cleanupCanvasTempFiles(canvasExportDir, canvasCleanupPolicy)
          .then(() => { canvasCleanupFailures = 0; })
          .catch((error: unknown) => {
            canvasCleanupFailures += 1;
            options.logBestEffortFailure("Canvas export cleanup failed", error);
            if (canvasCleanupFailures >= 3 && services.canvasCleanupTimer) {
              clearInterval(services.canvasCleanupTimer);
              services.canvasCleanupTimer = null;
              console.warn("[canvas] Export cleanup disabled after repeated failures");
            }
          });
      }, 6 * 60 * 60 * 1000);
      console.log("[app-db] Postgres connected, data layer ready");

      const handle = process.env.MATRIX_HANDLE ?? "default";
      const migrated = await kvStore.read("_system", `migration_v1_${handle}`);
      if (!migrated) {
        try {
          const { migrateJsonToKv } = await import("../app-db-migration.js");
          const jsonResult = await migrateJsonToKv(options.homePath, kvStore);
          if (jsonResult.keys > 0) {
            console.log(`[app-db] JSON migration: ${jsonResult.apps} apps, ${jsonResult.keys} keys`);
          }
          if (jsonResult.errors.length > 0) {
            console.error("[app-db] Migration had errors, will retry next boot:", jsonResult.errors);
          } else {
            await kvStore.write("_system", `migration_v1_${handle}`, new Date().toISOString());
          }
        } catch (error: unknown) {
          console.error("[app-db] Migration error:", error instanceof Error ? error.name : "UnknownError");
        }
      }

      try {
        const { loadAppManifest } = await import("../app-manifest.js");
        const apps = await listApps(options.homePath, { includeInactiveDesigns: true });
        let registered = 0;
        for (const app of apps) {
          if (!app.file.includes("/")) continue;
          const relDir = app.file.replace(/\/index\.html$/, "").replace(/\.html$/, "");
          const manifest = loadAppManifest(join(options.homePath, "apps", relDir));
          if (!manifest?.storage?.tables || Object.keys(manifest.storage.tables).length === 0) continue;
          const storageSlug = normalizeAppStorageSlug(relDir);
          if (!isSafeName(storageSlug)) {
            console.warn(`[app-db] Skipping registration for ${relDir}: unusable storage slug "${storageSlug}"`);
            continue;
          }
          try {
            await appRegistry.register({
              slug: storageSlug,
              name: manifest.name,
              description: manifest.description,
              version: manifest.version,
              author: manifest.author,
              category: manifest.category,
              tables: manifest.storage.tables as Record<
                string, { columns: Record<string, string>; indexes?: string[]; uniqueIndexes?: string[] }
              >,
            });
            registered++;
            options.rememberProvisionedAppSlug(storageSlug);
          } catch (error: unknown) {
            console.error(`[app-db] Registration failed for ${relDir} (slug ${storageSlug}):`, error instanceof Error ? error.name : "UnknownError");
          }
        }
        if (registered > 0) console.log(`[app-db] Registered ${registered} app(s) with storage schemas`);
      } catch (error: unknown) {
        console.error("[app-db] App registration error:", error instanceof Error ? error.name : "UnknownError");
      }
    },
  });
  if (!result.services) {
    if (options.databaseUrl) console.log("[app-db] Falling back to file-based storage");
    return { services: null, failClosedReason: options.collaborationConfig ? "owner_database_missing" : failClosedReason };
  }
  return { services, failClosedReason };
}
