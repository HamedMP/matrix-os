import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { appendFile as appendFileAsync, mkdir as mkdirAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join, normalize, resolve, relative } from "node:path";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { installPostHogHonoErrorTracking } from "@matrix-os/observability";
import { createDispatcher, type Dispatcher, type BatchEntry, type DispatchContext } from "./dispatcher.js";
import { createWatcher, type Watcher } from "./watcher.js";
import { createPtyHandler, type PtyMessage } from "./pty.js";
import { SessionRegistry, ClientMessageSchema, UUID_REGEX, type SessionHandle, type PtyServerMessage, type SessionInfo } from "./session-registry.js";
import { createConversationStore, type ConversationStore } from "./conversations.js";
import { ConversationRunRegistry, type ConversationRunMessage } from "./conversation-run-registry.js";
import { summarizeConversation, saveSummary } from "./conversation-summary.js";
import { extractMemoriesLocal } from "./memory-extractor.js";
import { resolveWithinHome } from "./path-security.js";
import { listDirectory } from "./files-tree.js";
import { fileStat, fileMkdir, fileTouch, fileRename, fileCopy, fileDuplicate } from "./file-ops.js";
import { fileSearch } from "./file-search.js";
import { fileDelete, trashList, trashRestore, trashEmpty } from "./trash.js";
import { listProjects } from "./projects.js";
import { createProjectManager } from "./project-manager.js";
import { createWorkspaceRoutes } from "./workspace-routes.js";
import { createSymphonyRoutes } from "./symphony-routes.js";
import { createSymphonyRunner, SymphonyConfigLoadError } from "./symphony-runner.js";
import { createAgentLauncher } from "./agent-launcher.js";
import { createAgentSessionManager } from "./agent-session-manager.js";
import { createWorktreeManager } from "./worktree-manager.js";
import { createFileSymphonyCredentialStore } from "./symphony/credential-store.js";
import { createLinearSource } from "./symphony/linear-source.js";
import { createMatrixSymphonyOrchestrator } from "./symphony/orchestrator.js";
import { KyselySymphonyRepository } from "./symphony/repository.js";
import { createSymphonyStatusHub } from "./symphony/status-hub.js";
import { createZellijRuntime } from "./zellij-runtime.js";
import { createSessionRuntimeBridge } from "./session-runtime-bridge.js";
import { createWorkspaceStartupRecovery } from "./workspace-startup-recovery.js";
import { createChannelManager, type ChannelManager } from "./channels/manager.js";
import { createOutboundQueue } from "./security/outbound-queue.js";
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
  createImageClient,
  loadIconStyle,
  buildIconPrompt,
  createUsageTracker,
  createMemoryStore,
} from "@matrix-os/kernel";
import { createProvisioner } from "./provisioner.js";
import {
  authMiddleware,
} from "./auth.js";
import { isRequestPrincipalError, mapRequestPrincipalError, requireRequestPrincipal } from "./request-principal.js";
import { createOnboardingHandler } from "./onboarding/ws-handler.js";
import { createVocalHandler } from "./vocal/ws-handler.js";
import type { GeminiLiveConnection } from "./onboarding/gemini-live.js";
import { resolveDefaultAppIconUrl, resolveSystemIconUrl } from "./default-icons.js";
import { securityHeadersMiddleware } from "./security/headers.js";
import { getSystemInfo } from "./system-info.js";
import {
  checkForSystemUpdate,
  listSystemReleases,
  parseInternalUpgradeTarget,
  resolveSystemUpdateChannel,
  startSystemUpdate,
  writeInternalUpgradeTrigger,
} from "./system-update.js";
import { createInteractionLogger, type InteractionLogger } from "./logger.js";
import { createApprovalBridge, type ApprovalBridge } from "./approval.js";
import { DEFAULT_APPROVAL_POLICY, type ApprovalPolicy } from "@matrix-os/kernel";
import { listApps } from "./apps.js";
import {
  createAppDispatcher,
  appSessionMiddleware,
  resolveAppBySlug,
  loadManifest,
  computeDistributionStatus,
  sandboxCapabilities,
  computeRuntimeState,
  deriveAppSessionKey,
  signAppSession,
  buildSetCookie,
  AckStore,
  MobileAppSessionTokenStore,
  SAFE_SLUG,
  ProcessManager,
  PortPool,
} from "./app-runtime/index.js";
import { createAppDb, type AppDb } from "./app-db.js";
import { createAppRegistry, type AppRegistry } from "./app-db-registry.js";
import { createQueryEngine, type FilterValue, type QueryEngine } from "./app-db-query.js";
import { createKvStore, type KvStore } from "./app-db-kv.js";
import { renameApp, deleteApp } from "./app-ops.js";
import { isExplicitIconRegeneration } from "./icon-request.js";
import { createPlatformDb, type PlatformDb } from "./platform-db.js";
import { createPipedreamClient, type PipedreamConnectClient } from "./integrations/pipedream.js";
import {
  createIntegrationRoutes,
  validateActionParams,
  getErrorStatusCode,
  getRetryAfterSeconds,
  executeIntegrationAction,
  IntegrationActionNotImplementedError,
} from "./integrations/routes.js";
import { discoverComponentKeys, getService, getAction } from "./integrations/registry.js";
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
import { syncApp, createSyncRoutes, type SyncRouteDeps } from "./sync/routes.js";
import { createR2Client, type R2Client, type R2ClientConfig } from "./sync/r2-client.js";
import { createPlatformR2Client } from "./sync/platform-r2-client.js";
import { createManifestDb, createKyselySharingDb } from "./sync/db-impl.js";
import { createHomeMirror, type HomeMirror } from "./sync/home-mirror.js";
import { createPeerRegistry, type PeerRegistry } from "./sync/ws-events.js";
import { createSyncPeerLifecycle } from "./sync/ws-peer-lifecycle.js";
import { createSharingService, type SharingService } from "./sync/sharing.js";
import { sanitizePeerId } from "./sync/peer-id.js";
import { migrateSyncTables, type SyncDatabase } from "./sync/sharing-db.js";
import type { Kysely } from "kysely";
import { createSocialRoutes, insertPost, bootstrapSocialSchema, type SocialRoutes } from "./social.js";
import { createActivityService } from "./social-activity.js";
import { CanvasRepository } from "./canvas/repository.js";
import { CanvasService } from "./canvas/service.js";
import { createCanvasRoutes } from "./canvas/routes.js";
import { CanvasSubscriptionHub } from "./canvas/subscriptions.js";
import { CanvasIdSchema } from "./canvas/contracts.js";
import { cleanupCanvasTempFiles } from "./canvas/recovery.js";
import { MessagingKyselyRepository } from "./messages/repository.js";
import { createMessagingRoutes } from "./messages/routes.js";
import type { WSContext } from "hono/ws";
import {
  MainWsClientMessageSchema,
  type MainWsClientMessage,
} from "./ws-message-schema.js";
import {
  metricsRegistry,
  httpRequestsTotal,
  httpRequestDuration,
  wsConnectionsActive,
  normalizePath,
} from "./metrics.js";
import {
  createShellRoutes,
  LayoutStore,
  ScrollbackStore,
  ShellPreferencesStore,
  createShellWsHandler,
  createZellijAdapter,
  ShellRegistry as ZellijShellRegistry,
} from "./shell/index.js";

// Mirrors CallBodySchema in integrations/routes.ts so the dev-only
// /api/bridge/service POST validates its body the same way the public
// /api/integrations/call endpoint does.
const BridgeCallBodySchema = z.object({
  service: z.string().min(1),
  action: z.string().min(1),
  label: z.string().trim().min(1).max(100).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const TERMINAL_DEBUG_ENABLED = process.env.TERMINAL_DEBUG !== "0";

function logTerminalDebug(event: string, details: Record<string, unknown> = {}): void {
  if (!TERMINAL_DEBUG_ENABLED) {
    return;
  }
  console.info("[terminal-debug][gateway]", event, details);
}

export const TERMINAL_SESSION_DELETE_BODY_LIMIT_BYTES = 1024;

export type TerminalSessionRouteRegistry = Pick<SessionRegistry, "list" | "getSession" | "destroy">;

export function registerTerminalSessionRoutes(
  app: Hono,
  options: { homePath: string; sessionRegistry: TerminalSessionRouteRegistry },
): void {
  const { homePath, sessionRegistry } = options;
  const terminalSessionDeleteBodyLimit = bodyLimit({
    maxSize: TERMINAL_SESSION_DELETE_BODY_LIMIT_BYTES,
  });

  app.get("/api/terminal/sessions", (c) => {
    const publicSessions = sessionRegistry.list().map((session: SessionInfo) => {
      const displayCwd = relative(homePath, session.cwd) || "~";
      return {
        sessionId: session.sessionId,
        cwd: displayCwd,
        state: session.state,
        exitCode: session.exitCode,
        createdAt: session.createdAt,
        lastAttachedAt: session.lastAttachedAt,
        attachedClients: session.attachedClients,
      };
    });
    return c.json(publicSessions);
  });

  app.delete("/api/terminal/sessions/:id", terminalSessionDeleteBodyLimit, (c) => {
    const id = c.req.param("id");
    logTerminalDebug("rest-destroy-request", { sessionId: id });
    if (!UUID_REGEX.test(id)) return c.json({ error: "Invalid session ID" }, 400);
    const session = sessionRegistry.getSession(id);
    if (!session) return c.json({ ok: true }, 200);
    sessionRegistry.destroy(id);
    return c.json({ ok: true });
  });
}

const INTEGRATION_PROXY_BODY_LIMIT = 64 * 1024;
const HANDLE_PATTERN = /^[a-z][a-z0-9-]{2,30}$/;

function timingSafeStringEquals(actual: string | null | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  const maxLength = Math.max(actualBuffer.length, expectedBuffer.length);
  const paddedActual = Buffer.alloc(maxLength);
  const paddedExpected = Buffer.alloc(maxLength);
  actualBuffer.copy(paddedActual);
  expectedBuffer.copy(paddedExpected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(paddedActual, paddedExpected);
}

export interface GatewayConfig {
  homePath: string;
  port?: number;
  model?: string;
  maxTurns?: number;
  syncReport?: { added: string[]; updated: string[]; skipped: string[] };
}

export type ServerMessage =
  | { type: "kernel:init"; sessionId: string; requestId?: string }
  | { type: "kernel:text"; text: string; requestId?: string }
  | { type: "kernel:tool_start"; tool: string; requestId?: string }
  | { type: "kernel:tool_end"; input?: Record<string, unknown>; requestId?: string }
  | { type: "kernel:result"; data: unknown; requestId?: string }
  | { type: "kernel:error"; message: string; requestId?: string }
  | { type: "kernel:aborted"; requestId?: string }
  | { type: "file:change"; path: string; event: string }
  | { type: "task:created"; task: { id: string; type: string; status: string; input: string } }
  | { type: "task:updated"; taskId: string; status: string }
  | { type: "provision:start"; appCount: number }
  | { type: "provision:complete"; total: number; succeeded: number; failed: number }
  | { type: "session:switched"; sessionId: string }
  | { type: "approval:request"; id: string; toolName: string; args: unknown; timeout: number }
  | { type: "os:sync-report"; payload: { added: string[]; updated: string[]; skipped: string[] } }
  | { type: "data:change"; app: string; key: string }
  | { type: "integration:connected"; service: string; accountLabel: string }
  | { type: "integration:disconnected"; service: string; id: string }
  | { type: "integration:expired"; service: string; id: string; accountLabel: string }
  | { type: "pong" }
  | { type: "sync:change"; files: Array<{ path: string; hash: string; size: number; action: string }>; peerId: string; manifestVersion: number }
  | { type: "sync:conflict"; path: string; localHash: string; remoteHash: string; remotePeerId: string; conflictPath: string }
  | { type: "sync:peer-join"; peerId: string; hostname: string; platform: string }
  | { type: "sync:peer-leave"; peerId: string }
  | { type: "sync:share-invite"; shareId: string; ownerHandle: string; path: string; role: string }
  | { type: "sync:access-revoked"; shareId: string; ownerHandle: string; path: string };

function kernelEventToServerMessage(event: KernelEvent, requestId?: string): ServerMessage {
  switch (event.type) {
    case "init":
      return { type: "kernel:init", sessionId: event.sessionId, requestId };
    case "text":
      return { type: "kernel:text", text: event.text, requestId };
    case "tool_start":
      return { type: "kernel:tool_start", tool: event.tool, requestId };
    case "tool_end":
      return { type: "kernel:tool_end", input: event.input, requestId };
    case "result":
      return { type: "kernel:result", data: event.data, requestId };
    case "aborted":
      return { type: "kernel:aborted", requestId };
  }
}

function send(ws: WSContext, msg: ServerMessage) {
  ws.send(JSON.stringify(msg));
}

const CONVERSATION_REPLAY_BATCH_SIZE = 100;
const CLIENT_KERNEL_ERROR_MESSAGE = "Request failed";
const MAX_MAIN_WS_CLIENTS = 100;

export function buildAllowedOrigins(options: {
  shellOrigin?: string;
  proxyOrigin?: string;
  symphonyPort?: number;
  symphonyPorts?: number[];
}): string[] {
  const symphonyPorts = Array.from(new Set([
    options.symphonyPort,
    ...(options.symphonyPorts ?? []),
  ].filter((port): port is number => typeof port === "number")));
  return Array.from(new Set(
    [
      options.shellOrigin,
      options.proxyOrigin,
      "http://localhost:3000",
      "http://localhost:4001",
      "http://localhost:4066",
      "http://127.0.0.1:4066",
      ...symphonyPorts.flatMap((port) => [
        `http://localhost:${port}`,
        `http://127.0.0.1:${port}`,
      ]),
    ].filter((origin): origin is string => Boolean(origin)),
  ));
}

export function createAllowedOriginController(options: {
  shellOrigin?: string;
  proxyOrigin?: string;
  symphonyPort?: number;
}) {
  const baseOptions = {
    shellOrigin: options.shellOrigin,
    proxyOrigin: options.proxyOrigin,
  };
  let symphonyPorts = options.symphonyPort ? [options.symphonyPort] : [];
  let allowedOrigins = buildAllowedOrigins({ ...baseOptions, symphonyPorts });

  return {
    resolve(origin: string | undefined): string | undefined {
      if (!origin) return undefined;
      return allowedOrigins.includes(origin) ? origin : undefined;
    },
    updateSymphonyPort(port: number, additionalPorts: number[] = []): void {
      symphonyPorts = Array.from(new Set([port, ...additionalPorts]));
      allowedOrigins = buildAllowedOrigins({ ...baseOptions, symphonyPorts });
    },
  };
}

type SymphonyRunner = ReturnType<typeof createSymphonyRunner>;

export async function readInitialSymphonyPort(runner: Pick<SymphonyRunner, "getConfig">): Promise<number | undefined> {
  try {
    return (await runner.getConfig()).port;
  } catch (err: unknown) {
    if (err instanceof SymphonyConfigLoadError) {
      console.warn("[gateway] Ignoring invalid Symphony config while seeding CORS origins");
      return undefined;
    }
    throw err;
  }
}

export async function createGateway(config: GatewayConfig) {
  const { homePath: rawHomePath, port = 4000, syncReport } = config;
  const homePath = resolve(rawHomePath);
  let syncReportSent = false;
  const symphonyRunner = createSymphonyRunner({ homePath });
  const symphonyPort = await readInitialSymphonyPort(symphonyRunner);
  const allowedOriginController = createAllowedOriginController({
    shellOrigin: process.env.SHELL_ORIGIN,
    proxyOrigin: process.env.PROXY_ORIGIN,
    symphonyPort,
  });

  const app = new Hono();
  const posthogErrorTracker = installPostHogHonoErrorTracking(app, {
    service: "matrix-gateway",
  });
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const sessionRegistry = new SessionRegistry(homePath, {
    maxSessions: 10,
    bufferSize: 1024 * 1024,
    persistPath: join(homePath, "system", "terminal-sessions.json"),
  });
  const workspaceZellijRuntime = createZellijRuntime({ homePath });
  const workspaceSessionRuntimeBridge = createSessionRuntimeBridge({
    homePath,
    registry: sessionRegistry,
    zellijRuntime: workspaceZellijRuntime,
  });
  const shellScrollbackStore = new ScrollbackStore({ homePath });
  const shellPreferencesStore = new ShellPreferencesStore({ homePath });
  const zellijAdapter = createZellijAdapter();
  const shellLayoutStore = new LayoutStore({ homePath, adapter: zellijAdapter });
  const zellijShellRegistry = new ZellijShellRegistry({
    homePath,
    adapter: zellijAdapter,
    maxSessions: 10,
    scrollbackStore: shellScrollbackStore,
  });
  const zellijShellWs = createShellWsHandler({
    registry: zellijShellRegistry,
    adapter: zellijAdapter,
    scrollbackStore: shellScrollbackStore,
  });
  const dispatcher: Dispatcher = createDispatcher({
    homePath,
    model: config.model,
    maxTurns: config.maxTurns,
  });

  const watcher: Watcher = createWatcher(homePath);
  const conversations: ConversationStore = createConversationStore(homePath);
  const conversationRuns = new ConversationRunRegistry();
  const clients = new Set<WSContext>();

  // App data layer (Postgres-backed when DATABASE_URL is set)
  const databaseUrl = process.env.DATABASE_URL;
  let appDb: AppDb | null = null;
  let queryEngine: QueryEngine | null = null;
  let kvStore: KvStore | null = null;
  let appRegistry: AppRegistry | null = null;
  let kyselyInstance: Kysely<any> | null = null;
  let canvasRepository: CanvasRepository | null = null;
  let canvasService: CanvasService | null = null;
  let canvasSubscriptionHub: CanvasSubscriptionHub | null = null;
  let canvasCleanupTimer: ReturnType<typeof setInterval> | null = null;
  let messagingRepository: MessagingKyselyRepository | null = null;

  if (databaseUrl) {
    try {
      const { db, kysely } = createAppDb(databaseUrl);
      appDb = db;
      kyselyInstance = kysely;
      await appDb.bootstrap();
      queryEngine = createQueryEngine(appDb);
      kvStore = createKvStore(kysely);
      appRegistry = createAppRegistry(appDb, kysely);
      canvasRepository = new CanvasRepository(kysely as Kysely<any>);
      await canvasRepository.bootstrap();
      canvasService = new CanvasService(canvasRepository, { terminalRegistry: sessionRegistry, homePath });
      messagingRepository = new MessagingKyselyRepository(kysely as Kysely<any>);
      await messagingRepository.bootstrap();
      canvasSubscriptionHub = new CanvasSubscriptionHub({
        authorize: async (subscriber) => {
          const record = await canvasRepository?.get(
            { ownerScope: "personal", ownerId: subscriber.userId },
            subscriber.canvasId,
          );
          return Boolean(record);
        },
      });
      const canvasExportDir = join(homePath, "system", "canvas-exports");
      const canvasCleanupPolicy = {
        ttlMs: 7 * 24 * 60 * 60 * 1000,
        maxFiles: 100,
      };
      await cleanupCanvasTempFiles(canvasExportDir, canvasCleanupPolicy);
      let canvasCleanupFailures = 0;
      canvasCleanupTimer = setInterval(() => {
        void cleanupCanvasTempFiles(canvasExportDir, canvasCleanupPolicy)
          .then(() => {
            canvasCleanupFailures = 0;
          })
          .catch((cleanupErr: unknown) => {
            canvasCleanupFailures += 1;
            logBestEffortFailure("Canvas export cleanup failed", cleanupErr);
            if (canvasCleanupFailures >= 3 && canvasCleanupTimer) {
              clearInterval(canvasCleanupTimer);
              canvasCleanupTimer = null;
              console.warn("[canvas] Export cleanup disabled after repeated failures");
            }
          });
      }, 6 * 60 * 60 * 1000);
      console.log("[app-db] Postgres connected, data layer ready");

      // Auto-migrate JSON files to _kv on first boot (per-user sentinel)
      const handle = process.env.MATRIX_HANDLE ?? "default";
      const migrated = await kvStore.read("_system", `migration_v1_${handle}`);
      if (!migrated) {
        try {
          const { migrateJsonToKv } = await import("./app-db-migration.js");
          const jsonResult = await migrateJsonToKv(homePath, kvStore);
          if (jsonResult.keys > 0) {
            console.log(`[app-db] JSON migration: ${jsonResult.apps} apps, ${jsonResult.keys} keys`);
          }
          if (jsonResult.errors.length > 0) {
            console.error("[app-db] Migration had errors, will retry next boot:", jsonResult.errors);
          } else {
            await kvStore.write("_system", `migration_v1_${handle}`, new Date().toISOString());
          }
        } catch (migErr) {
          console.error("[app-db] Migration error:", (migErr as Error).message);
        }
      }

      // Register apps with storage declarations
      try {
        const { loadAppManifest } = await import("./app-manifest.js");
        const apps = await listApps(homePath);
        let registered = 0;
        for (const app of apps) {
          const appDir = app.file.includes("/")
            ? join(homePath, "apps", app.file.replace(/\/index\.html$/, ""))
            : null;
          if (!appDir) continue;
          const manifest = loadAppManifest(appDir);
          if (manifest?.storage?.tables && Object.keys(manifest.storage.tables).length > 0) {
            const slug = app.file.replace(/\/index\.html$/, "").replace(/\.html$/, "");
            if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(slug)) continue;
            await appRegistry.register({
              slug,
              name: manifest.name,
              description: manifest.description,
              version: manifest.version,
              author: manifest.author,
              category: manifest.category,
              tables: manifest.storage.tables as Record<string, { columns: Record<string, string>; indexes?: string[] }>,
            });
            registered++;
          }
        }
        if (registered > 0) {
          console.log(`[app-db] Registered ${registered} app(s) with storage schemas`);
        }
      } catch (regErr) {
        console.error("[app-db] App registration error:", (regErr as Error).message);
      }
    } catch (err) {
      console.error("[app-db] Failed to connect to Postgres:", (err as Error).message);
      console.log("[app-db] Falling back to file-based storage");
      appDb = null;
      queryEngine = null;
      kvStore = null;
      appRegistry = null;
      canvasRepository = null;
      canvasService = null;
      canvasSubscriptionHub = null;
      messagingRepository = null;
    }
  }

  // 066: Sync infrastructure (R2/S3 + ManifestDb + PeerRegistry + Sharing)
  let syncR2: R2Client | null = null;
  let syncPeerRegistry: PeerRegistry | null = null;
  let syncSharing: SharingService | null = null;
  let syncDeps: SyncRouteDeps | null = null;

  const s3Endpoint = process.env.S3_ENDPOINT ?? process.env.R2_ENDPOINT;
  const s3AccessKey = process.env.S3_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID;
  const s3SecretKey = process.env.S3_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY;
  const s3Bucket = process.env.S3_BUCKET ?? process.env.R2_BUCKET ?? "matrixos-sync";
  const s3ForcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";

  const internalPlatformUrl = process.env.PLATFORM_INTERNAL_URL;
  const internalPlatformToken = process.env.UPGRADE_TOKEN;
  const internalHandle = process.env.MATRIX_HANDLE;
  const geminiLiveConnection: GeminiLiveConnection =
    internalPlatformUrl && internalPlatformToken && internalHandle
      ? { proxy: { platformUrl: internalPlatformUrl, token: internalPlatformToken, handle: internalHandle } }
      : process.env.GEMINI_API_KEY ?? "";

  if (((s3AccessKey && s3SecretKey) || (internalPlatformUrl && internalPlatformToken && internalHandle)) && kyselyInstance) {
    try {
      if (s3AccessKey && s3SecretKey) {
        const r2Config: R2ClientConfig = {
          accessKeyId: s3AccessKey,
          secretAccessKey: s3SecretKey,
          bucket: s3Bucket,
          endpoint: s3Endpoint,
          publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.R2_PUBLIC_ENDPOINT,
          accountId: process.env.R2_ACCOUNT_ID,
          forcePathStyle: s3ForcePathStyle,
        };
        syncR2 = await createR2Client(r2Config);
      } else {
        syncR2 = createPlatformR2Client({
          baseUrl: internalPlatformUrl!,
          handle: internalHandle!,
          token: internalPlatformToken!,
        });
      }

      await migrateSyncTables(kyselyInstance as Kysely<SyncDatabase>);

      const manifestDb = createManifestDb(kyselyInstance as Kysely<SyncDatabase>);
      syncPeerRegistry = createPeerRegistry();
      const sharingDb = createKyselySharingDb(kyselyInstance as Kysely<SyncDatabase>);
      syncSharing = createSharingService({ db: sharingDb, peerRegistry: syncPeerRegistry });

      syncDeps = {
        r2: syncR2,
        db: manifestDb,
        peerRegistry: syncPeerRegistry,
        sharing: syncSharing,
        // Resolve userId per request through the canonical principal seam so
        // sync storage keys follow the same source precedence as other
        // protected owner-scoped routes.
        getUserId: (c) => requireRequestPrincipal(c).userId,
        getPeerId: (c) => sanitizePeerId(c.req.header("X-Peer-Id")),
      };

      console.log("[sync] Sync API initialized (storage:", s3AccessKey && s3SecretKey ? (s3Endpoint ?? "R2") : "platform-internal", ")");
    } catch (err) {
      console.error("[sync] Failed to initialize sync:", (err as Error).message);
      syncR2 = null;
      syncPeerRegistry = null;
      syncSharing = null;
      syncDeps = null;
    }
  } else {
    console.log("[sync] No trusted sync storage configured, sync API disabled");
  }

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
      const userId =
        process.env.MATRIX_USER_ID ?? process.env.MATRIX_HANDLE ?? "default";
      if (!process.env.MATRIX_USER_ID) {
        console.warn(
          "[home-mirror] MATRIX_USER_ID not set; using MATRIX_HANDLE fallback. This is dev-only behaviour.",
        );
      }
      const manifestDb = createManifestDb(kyselyInstance as Kysely<SyncDatabase>);
      homeMirror = createHomeMirror({
        r2: syncR2,
        manifestDb,
        homeRoot: homePath,
        userId,
        peerId: `gateway-${userId}`,
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

  const internalIntegrationBaseUrl =
    internalPlatformUrl && internalHandle
      ? `${internalPlatformUrl}/internal/containers/${internalHandle}/integrations`
      : null;

  function buildIntegrationProxyUrl(c: Context, targetBase: string): string {
    const targetUrl = new URL(targetBase);
    const suffix = c.req.path.replace("/api/integrations", "") || "";
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

  function toStatusCode(status: number): ContentfulStatusCode {
    return status as ContentfulStatusCode;
  }

  async function proxyIntegrationRequest(
    c: Context,
    targetBase: string,
    includeInternalAuth: boolean,
  ): Promise<Response> {
    let upstreamUrl: string;
    try {
      upstreamUrl = buildIntegrationProxyUrl(c, targetBase);
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
    if (includeInternalAuth && internalPlatformToken) {
      headers.set("authorization", `Bearer ${internalPlatformToken}`);
    }

    const upstream = await fetch(upstreamUrl, {
      method: c.req.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.blob(),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  }

  // Platform DB + Integrations (Pipedream Connect)
  let platformDb: PlatformDb | null = null;
  let pipedreamClient: PipedreamConnectClient | null = null;
  let integrationRoutes: Hono | null = null;
  let resolveIntegrationUserId: ((c: Context) => Promise<string | null>) | null = null;
  const platformDbUrl = process.env.PLATFORM_DATABASE_URL;
  if (platformDbUrl && process.env.PIPEDREAM_CLIENT_ID && process.env.PIPEDREAM_CLIENT_SECRET && process.env.PIPEDREAM_PROJECT_ID) {
    try {
      platformDb = createPlatformDb(platformDbUrl);
      await platformDb.migrate();
      console.log("[platform-db] Initialized");

      pipedreamClient = await createPipedreamClient({
        clientId: process.env.PIPEDREAM_CLIENT_ID,
        clientSecret: process.env.PIPEDREAM_CLIENT_SECRET,
        projectId: process.env.PIPEDREAM_PROJECT_ID,
        environment: process.env.PIPEDREAM_ENVIRONMENT ?? "production",
      });

      // Single source of truth for user resolution -- used by /api/integrations/*
      // and the /api/bridge/service handlers. Prefers platform-verified Clerk
      // identity from the proxy header; falls back to env vars only in dev.
      //
      // Returns null on any failure so callers can return 401 instead of
      // leaking a 500. Each failure mode logs a distinct stable string so
      // prod incidents are debuggable: a 401 spike that's actually a Postgres
      // outage shows up as `[integrations][auth] db_error` in logs, while a
      // legitimate "user not in platform DB" shows as `[integrations][auth]
      // no_user_for_clerk_id`. Grep on those tags to triage.
      resolveIntegrationUserId = async (c) => {
        // ---- Path A: prod / platform header ----
        const clerkIdFromPlatform = c.req.header("x-platform-user-id");
        if (clerkIdFromPlatform) {
          try {
            const user = await platformDb!.getUserByClerkId(clerkIdFromPlatform);
            if (!user) {
              // Genuine auth failure: header is present but no platform row.
              // The user signed in via Clerk but their container/platform-db
              // row hasn't been provisioned yet. Distinct from a DB error.
              console.warn("[integrations][auth] no_user_for_clerk_id:", clerkIdFromPlatform.slice(0, 32));
              return null;
            }
            return user.id;
          } catch (err) {
            // Platform DB is down or query failed. This is a 500 masquerading
            // as a 401. Log loudly so the symptom (401 to client) maps to the
            // root cause (DB outage) without trial-and-error debugging.
            console.error(
              "[integrations][auth] db_error during getUserByClerkId:",
              err instanceof Error ? err.message : err,
            );
            return null;
          }
        }

        // ---- Path B: prod with no header = locked out (not an error) ----
        if (process.env.NODE_ENV === "production") {
          // Not console.error -- this is a routine "missing header" outcome,
          // not a server fault. The proxy is supposed to inject this header;
          // if it isn't, that's a deployment issue, not a per-request error.
          console.warn("[integrations][auth] no_platform_header_in_production");
          return null;
        }

        // ---- Path C: dev env-var fallback ----
        const handle = process.env.MATRIX_HANDLE ?? "default";
        const clerkId = process.env.MATRIX_CLERK_USER_ID ?? handle;
        const containerId = process.env.HOSTNAME ?? "local";

        // Atomic upsert eliminates the SELECT->INSERT TOCTOU race that could
        // let two concurrent first-time dev requests both reach createUser and
        // have one fail on the unique constraint. ON CONFLICT covers the
        // common case (same env vars across parallel requests => same
        // clerk_id). On match, backfill pipedream_external_id if missing.
        try {
          const upserted = await platformDb!.raw(
            `INSERT INTO users (clerk_id, handle, display_name, email, container_id, pipedream_external_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (clerk_id) DO UPDATE
               SET pipedream_external_id = COALESCE(users.pipedream_external_id, EXCLUDED.pipedream_external_id)
             RETURNING id`,
            [clerkId, handle, handle, `${handle}@matrix-os.local`, containerId, handle],
          );
          const row = upserted.rows[0] as { id: string } | undefined;
          if (row) return row.id;
          console.warn("[integrations][auth] dev_upsert_returned_no_row");
          return null;
        } catch (err) {
          // The upsert handles clerk_id conflicts but not handle/container_id
          // ones. Those occur when MATRIX_CLERK_USER_ID was changed between
          // runs and the orphaned row still owns the handle. Try to recover
          // by returning the orphaned row so dev keeps working without a wipe.
          try {
            const byHandle = await platformDb!.raw(
              `SELECT id, pipedream_external_id FROM users WHERE handle = $1 LIMIT 1`,
              [handle],
            );
            if (byHandle.rows.length > 0) {
              const row = byHandle.rows[0] as { id: string; pipedream_external_id: string | null };
              if (!row.pipedream_external_id) {
                await platformDb!.updatePipedreamExternalId(row.id, handle);
              }
              return row.id;
            }
            // Upsert raised, recovery SELECT found nothing. Whatever caused
            // the original error is real (DB down, schema drift, etc.).
            console.error(
              "[integrations][auth] db_error during dev fallback upsert (recovery select empty):",
              err instanceof Error ? err.message : err,
            );
            return null;
          } catch (recoveryErr) {
            // Both queries failed -- DB is genuinely unreachable.
            console.error(
              "[integrations][auth] db_error during dev fallback (both upsert and recovery failed):",
              err instanceof Error ? err.message : err,
              "recovery:",
              recoveryErr instanceof Error ? recoveryErr.message : recoveryErr,
            );
            return null;
          }
        }
      };

      integrationRoutes = createIntegrationRoutes({
        db: platformDb,
        pipedream: pipedreamClient,
        webhookSecret: (() => {
          const s = process.env.PIPEDREAM_WEBHOOK_SECRET;
          if (!s) console.warn("[integrations] PIPEDREAM_WEBHOOK_SECRET not set -- webhooks will be rejected");
          return s ?? "";
        })(),
        resolveUserId: resolveIntegrationUserId,
        broadcast,
      });
      // Routes mounted after auth middleware below (see "deferred route mounts")
      console.log("[platform-db] Integration routes ready");

      discoverComponentKeys(pipedreamClient)
        .then((stats) => {
          console.log(`[integrations] Component keys discovered: ${stats.matched}/${stats.total} matched, ${stats.errors} errors`);
        })
        .catch((err) => {
          console.error("[integrations] Component key discovery failed:", err instanceof Error ? err.message : err);
        });
    } catch (err) {
      console.error("[platform-db] Failed to initialize:", (err as Error).message);
      platformDb = null;
    }
  }

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
    for (const ws of clients) {
      ws.send(json);
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

  function finalizeWithSummary(sid: string) {
    conversations.finalize(sid);
    try {
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

  // Channel manager -- reads config, starts enabled adapters
  const configPath = join(homePath, "system/config.json");
  let channelsConfig: Partial<Record<ChannelId, ChannelConfig>> = {};
  try {
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      channelsConfig = cfg.channels ?? {};
    }
  } catch (err: unknown) {
    logBestEffortFailure("Failed to load channel config", err);
  }

  const outboundQueue = createOutboundQueue(homePath);

  const pushAdapter = createPushAdapter();

  const channelSessions = createSessionStore(join(homePath, "system", "sessions.json"));

  const telegramAdapter: TelegramAdapter = createTelegramAdapter();

  const channelManager: ChannelManager = createChannelManager({
    config: channelsConfig,
    adapters: {
      telegram: telegramAdapter,
      push: pushAdapter,
    },
    outboundQueue,
    onMessage: (msg) => {
      const sessionKey = `${msg.source}:${msg.senderId}`;
      const existingSessionId = channelSessions.get(sessionKey);

      // Telegram streaming: use progressive message editing
      if (msg.source === "telegram") {
        const bot = telegramAdapter.getBot();
        if (bot) {
          const stream = createTelegramStream({
            chatId: msg.chatId,
            bot,
            throttleMs: 1000,
            minInitialChars: 50,
            maxChars: 4096,
          });

          stream.startTyping();

          const text = msg.text.startsWith("/") ? msg.text.slice(1) : msg.text;
          let lastToolName: string | undefined;

          dispatcher
            .dispatch(text, existingSessionId, (event) => {
              if (event.type === "init") {
                channelSessions.set(sessionKey, event.sessionId, {
                  channel: msg.source, senderId: msg.senderId,
                  senderName: msg.senderName, chatId: msg.chatId,
                });
                conversations.begin(event.sessionId);
                conversations.addUserMessage(event.sessionId, msg.text);
              } else if (event.type === "text") {
                stream.append(event.text);
                const sid = channelSessions.get(sessionKey);
                if (sid) conversations.appendAssistantText(sid, event.text);
              } else if (event.type === "tool_start") {
                lastToolName = event.tool;
                const sid = channelSessions.get(sessionKey);
                if (sid) conversations.addToolStart(sid, event.tool);
              } else if (event.type === "tool_end") {
                const sid = channelSessions.get(sessionKey);
                if (sid) conversations.addToolEnd(sid, lastToolName ?? "unknown", event.input);
              } else if (event.type === "result") {
                const sid = channelSessions.get(sessionKey);
                if (sid) finalizeWithSummary(sid);
              }
            }, {
              channel: msg.source,
              senderId: msg.senderId,
              senderName: msg.senderName,
              chatId: msg.chatId,
            })
            .then(() => stream.flush())
            .catch((err: Error) => {
              stream.stopTyping();
              channelManager.send({
                channelId: msg.source,
                chatId: msg.chatId,
                text: `Error: ${err.message}`,
              });
            });

          return;
        }
      }

      // Default path for non-telegram channels (or telegram without bot)
      let responseText = "";
      let lastToolName: string | undefined;

      dispatcher
        .dispatch(msg.text, existingSessionId, (event) => {
          if (event.type === "init") {
            channelSessions.set(sessionKey, event.sessionId, {
              channel: msg.source, senderId: msg.senderId,
              senderName: msg.senderName, chatId: msg.chatId,
            });
            conversations.begin(event.sessionId);
            conversations.addUserMessage(event.sessionId, msg.text);
          } else if (event.type === "text") {
            responseText += event.text;
            const sid = channelSessions.get(sessionKey);
            if (sid) conversations.appendAssistantText(sid, event.text);
          } else if (event.type === "tool_start") {
            lastToolName = event.tool;
            const sid = channelSessions.get(sessionKey);
            if (sid) conversations.addToolStart(sid, event.tool);
          } else if (event.type === "tool_end") {
            const sid = channelSessions.get(sessionKey);
            if (sid) conversations.addToolEnd(sid, lastToolName ?? "unknown", event.input);
          } else if (event.type === "result") {
            const sid = channelSessions.get(sessionKey);
            if (sid) finalizeWithSummary(sid);
          }
        }, {
          channel: msg.source,
          senderId: msg.senderId,
          senderName: msg.senderName,
          chatId: msg.chatId,
        })
        .then(() => {
          if (responseText) {
            const formatted = formatForChannel(msg.source, responseText);
            channelManager.send({
              channelId: msg.source,
              chatId: msg.chatId,
              text: formatted,
            });
          }
        })
        .catch((err: Error) => {
          channelManager.send({
            channelId: msg.source,
            chatId: msg.chatId,
            text: `Error: ${err.message}`,
          });
        });
    },
  });

  channelManager.start().then(() => {
    channelManager.replay().catch((err: unknown) => {
      logBestEffortFailure("Failed to replay queued channel messages", err);
    });

    // Register skills as Telegram slash commands
    const bot = telegramAdapter.getBot();
    if (bot?.setMyCommands) {
      try {
        const skillsDir = join(homePath, "agents", "skills");
        if (existsSync(skillsDir)) {
          const commands: Array<{ command: string; description: string }> = [];
          for (const f of readdirSync(skillsDir).filter((s) => s.endsWith(".md"))) {
            const content = readFileSync(join(skillsDir, f), "utf-8");
            const nameMatch = content.match(/^name:\s*(.+)$/m);
            const descMatch = content.match(/^description:\s*(.+)$/m);
            if (nameMatch) {
              commands.push({
                command: nameMatch[1].trim().replace(/\s+/g, "-").toLowerCase(),
                description: (descMatch?.[1]?.trim() ?? nameMatch[1].trim()).slice(0, 256),
              });
            }
          }
          if (commands.length > 0) {
            bot.setMyCommands(commands.slice(0, 100)).catch((err: unknown) => {
              logBestEffortFailure("Failed to set Telegram commands", err);
            });
          }
        }
      } catch (err: unknown) {
        logBestEffortFailure("Failed to register Telegram commands", err);
      }
    }
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

  app.use("*", cors({
    origin: (origin) => {
      return allowedOriginController.resolve(origin);
    },
  }));
  app.use("*", securityHeadersMiddleware());
  app.use("*", authMiddleware(process.env.MATRIX_AUTH_TOKEN));
  // Platform normally owns /api/auth/ws-token before proxying to a customer
  // VPS. Direct gateway/dev shells have no platform layer, so expose an empty
  // no-store response in open mode and let WebSocket clients fall back to the
  // unauthenticated local dev upgrade path.
  app.get("/api/auth/ws-token", (c) => {
    if (process.env.MATRIX_AUTH_TOKEN) {
      return c.json({ error: "WebSocket auth unavailable" }, 503);
    }
    return c.json({ token: null, expiresAt: 0 }, 200, {
      "Cache-Control": "no-store",
    });
  });
  app.route("/api", createShellRoutes({
    registry: zellijShellRegistry,
    preferences: shellPreferencesStore,
    workspace: zellijAdapter,
    layouts: shellLayoutStore,
  }));

  // HKDF master secret for per-app session cookies. In production MATRIX_AUTH_TOKEN
  // is the source. When it is absent (local dev, .env.example default) we mint an
  // ephemeral process-scoped secret so the HKDF input is never predictable — an
  // empty master secret combined with the public info string would otherwise let
  // anyone forge matrix_app_session cookies for any installed slug. The trade-off
  // is that app-session cookies do not survive a gateway restart in dev mode.
  const envMasterSecret = process.env.MATRIX_AUTH_TOKEN;
  const appSessionMasterSecret = envMasterSecret && envMasterSecret.length >= 16
    ? envMasterSecret
    : (() => {
        const reason = !envMasterSecret
          ? "MATRIX_AUTH_TOKEN not set"
          : "MATRIX_AUTH_TOKEN too short (<16 bytes)";
        console.warn(
          `[gateway] ${reason}; using ephemeral app-session master secret (app-session cookies will not survive gateway restart).`,
        );
        return randomBytes(32).toString("hex");
      })();

  // Deferred route mounts -- must come AFTER auth middleware
  if (integrationRoutes) {
    app.route("/api/integrations", integrationRoutes);
    console.log("[platform-db] Integration routes mounted (after auth)");
  } else if (internalIntegrationBaseUrl && internalPlatformToken && internalPlatformUrl) {
    app.all("/api/integrations", bodyLimit({ maxSize: INTEGRATION_PROXY_BODY_LIMIT }), async (c) =>
      proxyIntegrationRequest(c, internalIntegrationBaseUrl, true),
    );
    app.all("/api/integrations/*", bodyLimit({ maxSize: INTEGRATION_PROXY_BODY_LIMIT }), async (c) => {
      const isPublic =
        c.req.path === "/api/integrations/available" ||
        c.req.path.startsWith("/api/integrations/webhook/");
      const targetBase = isPublic
        ? `${internalPlatformUrl}/api/integrations`
        : internalIntegrationBaseUrl;
      return proxyIntegrationRequest(c, targetBase, !isPublic);
    });
    console.log("[platform-db] Integration routes proxied via platform internal API");
  }

  // --- App Runtime (spec 063) ---
  // Ack-token store: bounded LRU (cap 32, 5min TTL)
  const ackStore = new AckStore();
  const mobileSessionTokens = new MobileAppSessionTokenStore({
    ttlMs: 60_000,
    maxEntries: 256,
  });

  // GET /api/apps/:slug/manifest — bearer-authed manifest + runtime state + distribution status
  app.get("/api/apps/:slug/manifest", async (c) => {
    const slug = c.req.param("slug");
    if (!SAFE_SLUG.test(slug)) {
      return c.json({ error: "invalid slug" }, 400);
    }
    const appsDir = join(homePath, "apps");
    const result = await loadManifest(appsDir, slug);
    if (!result.ok) {
      if (result.error.code === "not_found") return c.json({ error: "not found" }, 404);
      return c.json({ error: "internal" }, 500);
    }
    const resolved = await resolveAppBySlug(appsDir, slug);
    if (!resolved.ok) return c.json({ error: "internal" }, 500);
    const appDir = resolved.entry.appDir;
    const runtimeState = await computeRuntimeState(result.manifest, appDir);
    const distributionStatus = computeDistributionStatus(
      result.manifest.listingTrust,
      sandboxCapabilities(),
    );
    return c.json({ manifest: result.manifest, runtimeState, distributionStatus });
  });

  const appSessionBodyLimit = bodyLimit({ maxSize: 4096 });

  // POST /api/apps/:slug/ack — bearer-authed, issues ack token for gated installs
  app.post("/api/apps/:slug/ack", appSessionBodyLimit, async (c) => {
    const slug = c.req.param("slug");
    if (!SAFE_SLUG.test(slug)) {
      return c.json({ error: "invalid slug" }, 400);
    }
    const appsDir = join(homePath, "apps");
    const result = await loadManifest(appsDir, slug);
    if (!result.ok) {
      if (result.error.code === "not_found") return c.json({ error: "not found" }, 404);
      return c.json({ error: "internal" }, 500);
    }
    const manifest = result.manifest;
    if (manifest.scope !== "personal") {
      return c.json({ error: "scope_mismatch" }, 409);
    }
    const distributionStatus = computeDistributionStatus(
      manifest.listingTrust,
      sandboxCapabilities(),
    );
    if (distributionStatus === "blocked") {
      return c.json({ error: "install_blocked_by_policy" }, 403);
    }
    if (distributionStatus === "installable") {
      return c.json({ error: "ack_not_applicable" }, 400);
    }
    // gated: mint ack token
    const { ack, expiresAt } = ackStore.mint(slug, "gateway-owner");
    return c.json({ ack, expiresAt });
  });

  // POST /api/apps/:slug/session — bearer-authed, issues signed session cookie
  app.post("/api/apps/:slug/session", appSessionBodyLimit, async (c) => {
    const slug = c.req.param("slug");
    if (!SAFE_SLUG.test(slug)) {
      return c.json({ error: "invalid slug" }, 400);
    }
    const appsDir = join(homePath, "apps");
    const result = await loadManifest(appsDir, slug);
    if (!result.ok) {
      if (result.error.code === "not_found") return c.json({ error: "not found" }, 404);
      return c.json({ error: "internal" }, 500);
    }
    const manifest = result.manifest;
    if (manifest.scope !== "personal") {
      return c.json({ error: "scope_mismatch" }, 409);
    }
    // Re-compute distributionStatus server-side (ignore any client hint)
    const distributionStatus = computeDistributionStatus(
      manifest.listingTrust,
      sandboxCapabilities(),
    );
    if (distributionStatus === "blocked") {
      return c.json({ error: "install_blocked_by_policy" }, 403);
    }
    if (distributionStatus === "gated") {
      // Require valid ack token
      let body: { ack?: string } = {};
      try {
        body = await c.req.json();
      } catch (err) {
        // Hono throws SyntaxError / BodyLimitError when the body is missing
        // or malformed. Either case reduces to "no ack supplied" below; we
        // only swallow parse-shape errors and re-throw anything else.
        if (!(err instanceof SyntaxError) && (err as { name?: string }).name !== "BodyLimitError") {
          throw err;
        }
      }
      if (!body.ack || !ackStore.peekAck(slug, "gateway-owner", body.ack)) {
        return c.json({ error: "install_gated" }, 409);
      }
    }
    // Sign session cookie (uses process-scoped master secret computed above;
    // never reads MATRIX_AUTH_TOKEN directly so empty/short env values can't
    // produce a predictable HKDF key).
    const key = deriveAppSessionKey(appSessionMasterSecret, slug);
    const nowSec = Math.floor(Date.now() / 1000);
    const maxAge = 600; // 10 minutes
    const payload = {
      v: 1 as const,
      slug,
      principal: "gateway-owner" as const,
      scope: "personal" as const,
      iat: nowSec,
      exp: nowSec + maxAge,
    };
    const token = signAppSession(key, payload);
    const cookie = buildSetCookie(slug, token, {
      maxAge,
      secure: c.req.url.startsWith("https"),
    });
    return c.json({ expiresAt: payload.exp * 1000 }, 200, {
      "Set-Cookie": cookie,
    });
  });

  // POST /api/apps/:slug/session-token — mobile-safe one-shot session bootstrap.
  app.post("/api/apps/:slug/session-token", appSessionBodyLimit, async (c) => {
    const slug = c.req.param("slug");
    if (!SAFE_SLUG.test(slug)) {
      return c.json({ error: "invalid slug" }, 400);
    }
    const appsDir = join(homePath, "apps");
    const result = await loadManifest(appsDir, slug);
    if (!result.ok) {
      if (result.error.code === "not_found") return c.json({ error: "not found" }, 404);
      return c.json({ error: "internal" }, 500);
    }
    const manifest = result.manifest;
    if (manifest.scope !== "personal") {
      return c.json({ error: "scope_mismatch" }, 409);
    }
    const distributionStatus = computeDistributionStatus(
      manifest.listingTrust,
      sandboxCapabilities(),
    );
    if (distributionStatus === "blocked") {
      return c.json({ error: "install_blocked_by_policy" }, 403);
    }
    if (distributionStatus === "gated") {
      let body: { ack?: string } = {};
      try {
        body = await c.req.json();
      } catch (err) {
        if (!(err instanceof SyntaxError) && (err as { name?: string }).name !== "BodyLimitError") {
          throw err;
        }
      }
      if (!body.ack || !ackStore.peekAck(slug, "gateway-owner", body.ack)) {
        return c.json({ error: "install_gated" }, 409);
      }
    }
    const routingHandle = process.env.MATRIX_HANDLE;
    const { token, expiresAt } = mobileSessionTokens.mint(slug, Date.now(), {
      routingKey: routingHandle && HANDLE_PATTERN.test(routingHandle) ? routingHandle : undefined,
    });
    return new Response(JSON.stringify({
      token,
      expiresAt,
      launchUrl: `/apps/${slug}/?session=${encodeURIComponent(token)}`,
    }), {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=UTF-8",
      },
    });
  });

  app.use("/apps/:slug/*", async (c, next) => {
    const slug = c.req.param("slug");
    if (!slug || !SAFE_SLUG.test(slug)) {
      return c.json({ error: "invalid slug" }, 400);
    }
    const url = new URL(c.req.url);
    const token = url.searchParams.get("session");
    if (!token) {
      await next();
      return;
    }
    if (!mobileSessionTokens.consume(slug, token)) {
      return c.html("<!doctype html><title>Session expired</title><p>Session expired.</p>", 401, {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
      });
    }

    const key = deriveAppSessionKey(appSessionMasterSecret, slug);
    const nowSec = Math.floor(Date.now() / 1000);
    const maxAge = 600;
    const payload = {
      v: 1 as const,
      slug,
      principal: "gateway-owner" as const,
      scope: "personal" as const,
      iat: nowSec,
      exp: nowSec + maxAge,
    };
    const cookie = buildSetCookie(slug, signAppSession(key, payload), {
      maxAge,
      secure: c.req.url.startsWith("https"),
    });
    url.searchParams.delete("session");
    const nextSearch = url.searchParams.toString();
    const location = `${url.pathname}${nextSearch ? `?${nextSearch}` : ""}${url.hash}`;
    return new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "no-store",
        "Location": location,
        "Set-Cookie": cookie,
      },
    });
  });

  // Mount app-session middleware on /apps/:slug/* (verifies signed cookie)
  app.use(
    "/apps/:slug/*",
    appSessionMiddleware((slug) =>
      deriveAppSessionKey(appSessionMasterSecret, slug),
    ),
  );

  // Create process manager for node-runtime apps
  const portPool = new PortPool({ min: 40000, max: 49999, cap: 100 });
  const processManager = new ProcessManager({
    homeDir: homePath,
    portPool,
    maxProcesses: 10,
    reaperIntervalMs: 30_000,
  });

  // Mount app dispatcher on /apps/:slug (static + vite + node branches)
  const appDispatcher = createAppDispatcher(homePath, {
    processManager,
    publicHost: process.env.PUBLIC_HOST ?? "localhost",
  });
  app.route("/apps/:slug", appDispatcher);

  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    const duration = (performance.now() - start) / 1000;
    const path = normalizePath(c.req.path);
    const method = c.req.method;
    const status = String(c.res.status);
    httpRequestsTotal.inc({ method, path, status });
    httpRequestDuration.observe({ method, path }, duration);
  });

  app.get("/metrics", async (c) => {
    const output = await metricsRegistry.metrics();
    return c.text(output, 200, {
      "Content-Type": metricsRegistry.contentType,
    });
  });

  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      // Capture the authenticated sync userId at upgrade time so the
      // sync:subscribe branch below keys peers off the same principal as the
      // HTTP sync routes. authMiddleware ran on the upgrade request and
      // stashed claims if a JWT was presented.
      let syncPeerLifecycle = null;
      let syncPeerSocket: WSContext | null = null;
      try {
        const wsSyncUserId = requireRequestPrincipal(c).userId;
        syncPeerLifecycle = syncPeerRegistry
          ? createSyncPeerLifecycle(syncPeerRegistry, wsSyncUserId, {
              send: (data: string) => syncPeerSocket?.send(data),
              get readyState() {
                return syncPeerSocket?.readyState ?? 3;
              },
            })
          : null;
      } catch (err) {
        if (!isRequestPrincipalError(err)) {
          throw err;
        }
        console.warn("[sync/ws] Missing or invalid sync request principal on websocket upgrade");
      }
      let pendingText: string | undefined;
      let activeSessionId: string | undefined;
      let approvalBridge: ApprovalBridge | undefined;
      let detachConversationRun: (() => void) | null = null;
      let conversationReplayVersion = 0;
      // Per-WS-connection abort controllers, keyed by requestId. Created
      // when the user submits a message; consumed when they explicitly
      // stop the agent. Cleaned up after result / error / aborted so the
      // map doesn't grow.
      const abortControllers = new Map<string, AbortController>();

      const clearConversationRunAttachment = () => {
        conversationReplayVersion++;
        if (detachConversationRun) {
          detachConversationRun();
          detachConversationRun = null;
        }
      };

      const publishConversationRunMessage = (
        sessionId: string | undefined,
        message: ConversationRunMessage,
      ) => {
        if (!sessionId) {
          return;
        }
        conversationRuns.publish(sessionId, message);
      };

      const replayConversationRun = (
        ws: WSContext,
        bufferedMessages: ConversationRunMessage[],
        onComplete?: () => void,
      ) => {
        const replayVersion = conversationReplayVersion;
        if (bufferedMessages.length === 0) {
          onComplete?.();
          return;
        }

        const flushBatch = (startIndex: number) => {
          if (replayVersion !== conversationReplayVersion) {
            return;
          }

          const endIndex = Math.min(
            startIndex + CONVERSATION_REPLAY_BATCH_SIZE,
            bufferedMessages.length,
          );
          for (let index = startIndex; index < endIndex; index++) {
            send(ws, bufferedMessages[index] as ServerMessage);
          }
          if (endIndex < bufferedMessages.length) {
            setTimeout(() => flushBatch(endIndex), 0);
            return;
          }

          onComplete?.();
        };

        flushBatch(0);
      };

      return {
        onOpen(_evt, ws) {
          syncPeerSocket = ws;
          evictOldestMainWsClientIfNeeded();
          clients.add(ws);
          wsConnectionsActive.inc();
          approvalBridge = createApprovalBridge({
            send: (msg) => send(ws, msg),
            timeout: approvalPolicy.timeout,
          });

          // T2093: Send sync report once per boot
          if (syncReport && !syncReportSent) {
            syncReportSent = true;
            send(ws, {
              type: "os:sync-report",
              payload: syncReport,
            });
          }
        },

        onMessage(evt, ws) {
          let rawMessage: unknown;
          try {
            rawMessage = JSON.parse(
              typeof evt.data === "string" ? evt.data : "",
            );
          } catch (err: unknown) {
            logUnexpectedJsonParseFailure("Failed to parse main WebSocket message", err);
            send(ws, { type: "kernel:error", message: "Invalid JSON" });
            return;
          }

          const parsedResult = MainWsClientMessageSchema.safeParse(rawMessage);
          if (!parsedResult.success) {
            send(ws, { type: "kernel:error", message: "Invalid message format" });
            return;
          }

          const parsed: MainWsClientMessage = parsedResult.data;

          if (parsed.type === "ping") {
            send(ws, { type: "pong" } as ServerMessage);
            return;
          }

          if (parsed.type === "switch_session") {
            activeSessionId = parsed.sessionId;
            clearConversationRunAttachment();
            const pendingLiveMessages: ConversationRunMessage[] = [];
            let replayComplete = false;
            const attachment = conversationRuns.attachWithBufferedSnapshot(
              parsed.sessionId,
              (message) => {
                if (!replayComplete) {
                  pendingLiveMessages.push(message);
                  return;
                }
                send(ws, message as ServerMessage);
              },
            );
            if (attachment) {
              detachConversationRun = attachment.detach;
              replayConversationRun(ws, attachment.bufferedMessages, () => {
                replayComplete = true;
                send(ws, {
                  type: "session:switched",
                  sessionId: parsed.sessionId,
                });
                for (const message of pendingLiveMessages) {
                  send(ws, message as ServerMessage);
                }
                pendingLiveMessages.length = 0;
              });
              return;
            }

            send(ws, { type: "session:switched", sessionId: parsed.sessionId });
            return;
          }

          if (parsed.type === "approval_response" && approvalBridge) {
            approvalBridge.handleResponse({ id: parsed.id, approved: parsed.approved });
            return;
          }

          if (parsed.type === "sync:subscribe" && syncPeerRegistry) {
            syncPeerLifecycle?.subscribe({
              peerId: parsed.peerId,
              hostname: parsed.hostname,
              platform: parsed.platform,
              clientVersion: parsed.clientVersion,
            });
            return;
          }

          if (parsed.type === "abort") {
            const controller = abortControllers.get(parsed.requestId);
            if (controller) {
              controller.abort();
              // Map cleanup happens in the dispatcher's terminal-event
              // path (kernel:aborted -> delete). No need to delete here.
            }
            return;
          }

          if (parsed.type === "message") {
            clearConversationRunAttachment();
            pendingText = parsed.text;
            const requestId = parsed.requestId;
            let lastToolName: string | undefined;

            // Register abort controller so the user can stop this run.
            // Skip if no requestId (legacy clients) -- they can't target
            // a specific run anyway.
            const abortController = requestId ? new AbortController() : undefined;
            if (requestId && abortController) {
              abortControllers.set(requestId, abortController);
            }

            dispatcher
              .dispatch(parsed.text, parsed.sessionId, (event) => {
                const msg = kernelEventToServerMessage(event, requestId);
                send(ws, msg);

                if (msg.type === "kernel:init") {
                  activeSessionId = msg.sessionId;
                  conversationRuns.begin(msg.sessionId);
                  publishConversationRunMessage(msg.sessionId, msg);
                  conversations.begin(msg.sessionId);
                  if (pendingText) {
                    conversations.addUserMessage(msg.sessionId, pendingText);
                    pendingText = undefined;
                  }
                } else if (msg.type === "kernel:text" && activeSessionId) {
                  publishConversationRunMessage(activeSessionId, msg);
                  conversations.appendAssistantText(activeSessionId, msg.text);
                } else if (msg.type === "kernel:tool_start" && activeSessionId) {
                  publishConversationRunMessage(activeSessionId, msg);
                  lastToolName = msg.tool;
                  conversations.addToolStart(activeSessionId, msg.tool);
                } else if (msg.type === "kernel:tool_end" && activeSessionId) {
                  publishConversationRunMessage(activeSessionId, msg);
                  conversations.addToolEnd(activeSessionId, lastToolName ?? "unknown", msg.input);
                } else if (msg.type === "kernel:result" && activeSessionId) {
                  publishConversationRunMessage(activeSessionId, msg);
                  finalizeWithSummary(activeSessionId);
                  conversationRuns.complete(activeSessionId);
                } else if (msg.type === "kernel:error" && activeSessionId) {
                  publishConversationRunMessage(activeSessionId, {
                    ...msg,
                    message: CLIENT_KERNEL_ERROR_MESSAGE,
                  });
                  finalizeWithSummary(activeSessionId);
                  conversationRuns.complete(activeSessionId);
                } else if (msg.type === "kernel:aborted" && activeSessionId) {
                  publishConversationRunMessage(activeSessionId, msg);
                  finalizeWithSummary(activeSessionId);
                  conversationRuns.complete(activeSessionId);
                }
              }, undefined, abortController)
              .catch((err: Error) => {
                console.error("[gateway] Conversation dispatch failed:", err);
                if (activeSessionId) {
                  publishConversationRunMessage(activeSessionId, {
                    type: "kernel:error",
                    message: CLIENT_KERNEL_ERROR_MESSAGE,
                    requestId,
                  });
                  finalizeWithSummary(activeSessionId);
                  conversationRuns.complete(activeSessionId);
                }
                send(ws, {
                  type: "kernel:error",
                  message: CLIENT_KERNEL_ERROR_MESSAGE,
                  requestId,
                });
              })
              .finally(() => {
                if (requestId) abortControllers.delete(requestId);
              });
          }
        },

        onClose(_evt, ws) {
          clearConversationRunAttachment();
          syncPeerLifecycle?.close();
          syncPeerSocket = null;
          // Abort any in-flight runs for this client so the kernel doesn't
          // keep burning tokens after the WS closes.
          for (const controller of abortControllers.values()) {
            controller.abort();
          }
          abortControllers.clear();
          if (clients.delete(ws)) {
            wsConnectionsActive.dec();
          }
        },
      };
    }),
  );

  app.get(
    "/ws/terminal",
    upgradeWebSocket((c) => {
      const cwdParam = c.req.query("cwd");
      const namedSession = c.req.query("session");
      const fromSeqParam = c.req.query("fromSeq");
      let handle: SessionHandle | null = null;
      let namedHandle: { onMessage(raw: string): void; onClose(): void } | null = null;
      let namedSocketClosed = false;
      let autoCreateTimer: ReturnType<typeof setTimeout> | null = null;
      let autoCreatedSessionId: string | null = null;

      const cleanupAutoCreatedSession = (destroyAutoCreated = true) => {
        logTerminalDebug("ws-cleanup", {
          destroyAutoCreated,
          handleSessionId: handle?.sessionId ?? null,
          autoCreatedSessionId,
        });
        if (handle) {
          const shouldDestroyAutoCreated = autoCreatedSessionId === handle.sessionId;
          handle.detach();
          handle = null;
          if (destroyAutoCreated && shouldDestroyAutoCreated && autoCreatedSessionId) {
            sessionRegistry.destroy(autoCreatedSessionId);
          }
        } else if (destroyAutoCreated && autoCreatedSessionId) {
          sessionRegistry.destroy(autoCreatedSessionId);
        }
        autoCreatedSessionId = null;
      };

      return {
        onOpen(_evt, ws) {
          logTerminalDebug("ws-open", {
            cwdParam: cwdParam ?? null,
            namedSession: namedSession ?? null,
          });
          const sendJson = (msg: PtyServerMessage) => {
            try {
              ws.send(JSON.stringify(msg));
            } catch (err: unknown) {
              logUnexpectedWsSendFailure("Terminal WebSocket send failed", err);
            }
          };

          if (namedSession) {
            const fromSeq =
              typeof fromSeqParam === "string" && /^\d+$/.test(fromSeqParam)
                ? Number(fromSeqParam)
                : 0;
            void zellijShellWs.open({
              ws,
              session: namedSession,
              fromSeq,
            }).then((session) => {
              if (namedSocketClosed) {
                session.onClose();
                return;
              }
              namedHandle = session;
            }).catch((err: unknown) => {
              console.warn("[shell] zellij terminal attach failed:", err instanceof Error ? err.message : String(err));
              if (namedSocketClosed) {
                return;
              }
              try {
                ws.send(JSON.stringify({
                  type: "error",
                  code: "attach_failed",
                  message: "Shell attach failed",
                }));
              } catch (sendErr: unknown) {
                logUnexpectedWsSendFailure("Terminal WebSocket send failed", sendErr);
              }
              ws.close();
            });
            return;
          }

          // Backward compat: auto-create session if no attach message within 100ms
          if (cwdParam && cwdParam.length >= 1 && cwdParam.length <= 4096) {
            autoCreateTimer = setTimeout(() => {
              autoCreateTimer = null;
              if (handle) return;
              let sessionId: string | null = null;
              try {
                sessionId = sessionRegistry.create(cwdParam);
                logTerminalDebug("auto-create-session", { cwd: cwdParam, sessionId });
                autoCreatedSessionId = sessionId;
                handle = sessionRegistry.attach(sessionId);
                if (handle) {
                  handle.subscribe(sendJson);
                  sendJson({ type: "attached", sessionId, state: "running" });
                  handle.replay(0);
                } else {
                  sessionRegistry.destroy(sessionId);
                  autoCreatedSessionId = null;
                }
              } catch (err: unknown) {
                if (handle) {
                  handle.detach();
                  handle = null;
                }
                if (sessionId) {
                  sessionRegistry.destroy(sessionId);
                  autoCreatedSessionId = null;
                }
                console.error("Terminal session create error:", err);
                sendJson({ type: "error", message: "Failed to create session" });
              }
            }, 100);
          }
        },

        onMessage(evt, ws) {
          const raw = typeof evt.data === "string" ? evt.data : "";
          if (namedSession) {
            namedHandle?.onMessage(raw);
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (err: unknown) {
            logUnexpectedJsonParseFailure("Failed to parse terminal WebSocket message", err);
            ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
            return;
          }

          const result = ClientMessageSchema.safeParse(parsed);
          if (!result.success) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
            return;
          }

          const msg = result.data;
          const sendJson = (m: PtyServerMessage) => {
            try {
              ws.send(JSON.stringify(m));
            } catch (err: unknown) {
              logUnexpectedWsSendFailure("Terminal WebSocket send failed", err);
            }
          };

          switch (msg.type) {
            case "ping":
              ws.send(JSON.stringify({ type: "pong" }));
              break;
            case "attach": {
              logTerminalDebug("ws-attach-request", {
                mode: "cwd" in msg ? "create" : "reattach",
                cwd: "cwd" in msg ? msg.cwd : null,
                sessionId: "sessionId" in msg ? msg.sessionId : null,
                fromSeq: "fromSeq" in msg ? (msg.fromSeq ?? 0) : null,
              });
              if (autoCreateTimer) {
                clearTimeout(autoCreateTimer);
                autoCreateTimer = null;
              }
              if (handle) {
                cleanupAutoCreatedSession();
              }

              if ("cwd" in msg) {
                let sessionId: string | null = null;
                try {
                  sessionId = sessionRegistry.create(msg.cwd, msg.shell);
                  logTerminalDebug("create-session", {
                    cwd: msg.cwd,
                    shell: msg.shell ?? null,
                    sessionId,
                  });
                  autoCreatedSessionId = null;
                  handle = sessionRegistry.attach(sessionId);
                  if (handle) {
                    handle.subscribe(sendJson);
                    sendJson({ type: "attached", sessionId, state: "running" });
                    handle.replay(0);
                  } else {
                    sessionRegistry.destroy(sessionId);
                  }
                } catch (err: unknown) {
                  if (handle) {
                    handle.detach();
                    handle = null;
                  }
                  if (sessionId) {
                    sessionRegistry.destroy(sessionId);
                  }
                  console.error("Terminal session create error:", err);
                  sendJson({ type: "error", message: "Failed to create session" });
                }
              } else {
                try {
                  handle = sessionRegistry.attach(msg.sessionId);
                  if (handle) {
                    logTerminalDebug("attach-existing-success", { sessionId: msg.sessionId });
                    const info = sessionRegistry.getSession(msg.sessionId);
                    autoCreatedSessionId = null;
                    handle.subscribe(sendJson);
                    sendJson({
                      type: "attached",
                      sessionId: msg.sessionId,
                      state: info?.state ?? "running",
                      exitCode: info?.exitCode,
                    });
                    handle.replay(msg.fromSeq ?? 0);
                  } else {
                    logTerminalDebug("attach-existing-miss", { sessionId: msg.sessionId });
                    sendJson({ type: "error", message: "Session not found" });
                  }
                } catch (err: unknown) {
                  if (handle) {
                    handle.detach();
                    handle = null;
                  }
                  console.error("Terminal session attach error:", err);
                  sendJson({ type: "error", message: "Failed to attach session" });
                }
              }
              break;
            }
            case "input":
            case "resize":
              if (handle) {
                handle.send(msg);
              }
              break;
            case "detach":
              if (handle) {
                logTerminalDebug("ws-detach", { sessionId: handle.sessionId });
                handle.detach();
                handle = null;
              }
              break;
            case "destroy":
              if (handle) {
                const sessionId = handle.sessionId;
                logTerminalDebug("ws-destroy", { sessionId });
                handle.detach();
                handle = null;
                sessionRegistry.destroy(sessionId);
                if (autoCreatedSessionId === sessionId) {
                  autoCreatedSessionId = null;
                }
              }
              break;
          }
        },

        onClose() {
          namedSocketClosed = true;
          if (namedHandle) {
            namedHandle.onClose();
            namedHandle = null;
          }
          logTerminalDebug("ws-close", {
            handleSessionId: handle?.sessionId ?? null,
            autoCreatedSessionId,
          });
          if (autoCreateTimer) {
            clearTimeout(autoCreateTimer);
            autoCreateTimer = null;
          }
          cleanupAutoCreatedSession(false);
        },
      };
    }),
  );

  // --- Onboarding WebSocket ---
  const onboardingHandler = createOnboardingHandler({
    homePath,
    geminiConnection: geminiLiveConnection,
    geminiModel: process.env.ONBOARDING_GEMINI_MODEL ?? "gemini-3.1-flash-live-preview",
  });

  app.get(
    "/ws/onboarding",
    upgradeWebSocket(() => {
      return {
        onOpen(_evt, ws) {
          try {
            onboardingHandler.activate();
          } catch (err) {
            console.warn("[onboarding] activate failed:", err instanceof Error ? err.message : String(err));
            ws.send(JSON.stringify({ type: "error", code: "connection_limit", stage: "greeting", message: "Another onboarding session is active", retryable: true }));
            ws.close();
            return;
          }
          // onOpen awaits isOnboardingComplete; if that rejects (e.g. fs
          // permission error), we must release the `active` flag and close
          // the socket, otherwise the singleton stays locked and all future
          // connections hang on initial message.
          onboardingHandler.onOpen((msg) => {
            ws.send(JSON.stringify(msg));
          }).catch((err: unknown) => {
            console.warn(
              "[onboarding] onOpen failed:",
              err instanceof Error ? err.message : String(err),
            );
            try {
              ws.send(JSON.stringify({ type: "error", code: "internal", stage: "greeting", message: "onboarding failed to initialize", retryable: true }));
            } catch (sendErr) {
              console.warn(
                "[onboarding] failed to send initialization error:",
                sendErr instanceof Error ? sendErr.message : String(sendErr),
              );
            }
            onboardingHandler.onClose();
            ws.close();
          });
        },
        onMessage(evt, ws) {
          const data = typeof evt.data === "string" ? evt.data : evt.data.toString();
          void onboardingHandler.onMessage(data).catch((err: unknown) => {
            console.warn(
              "[onboarding] onMessage failed:",
              err instanceof Error ? err.message : String(err),
            );
            try {
              ws.send(JSON.stringify({ type: "error", code: "internal", stage: "unknown", message: "Onboarding message failed", retryable: true }));
            } catch (sendErr) {
              console.warn(
                "[onboarding] failed to send message error:",
                sendErr instanceof Error ? sendErr.message : String(sendErr),
              );
            }
            ws.close();
          });
        },
        onClose() {
          onboardingHandler.onClose();
        },
      };
    }),
  );

  // --- Vocal mode WebSocket ---
  // Each connection gets its own isolated handler so multiple users (or
  // reconnecting tabs) don't share a Gemini Live session.
  app.get(
    "/ws/vocal",
    upgradeWebSocket(() => {
      const vocalHandler = createVocalHandler({
        homePath,
        geminiConnection: geminiLiveConnection,
        // VOCAL_GEMINI_MODEL keeps Aoede independently configurable from
        // onboarding; fall back to ONBOARDING_GEMINI_MODEL so existing
        // deployments don't regress until operators set the vocal-specific
        // var.
        geminiModel:
          process.env.VOCAL_GEMINI_MODEL ??
          process.env.ONBOARDING_GEMINI_MODEL ??
          "gemini-3.1-flash-live-preview",
      });
      return {
        onOpen(_evt, ws) {
          vocalHandler.onOpen((msg) => {
            ws.send(JSON.stringify(msg));
          });
        },
        onMessage(evt, ws) {
          const data = typeof evt.data === "string" ? evt.data : evt.data.toString();
          void vocalHandler.onMessage(data).catch((err: unknown) => {
            console.warn(
              "[vocal] onMessage failed:",
              err instanceof Error ? err.message : String(err),
            );
            try {
              ws.send(JSON.stringify({ type: "error", message: "Voice message failed", retryable: true }));
            } catch (sendErr) {
              console.warn(
                "[vocal] failed to send message error:",
                sendErr instanceof Error ? sendErr.message : String(sendErr),
              );
            }
            ws.close();
          });
        },
        onClose() {
          vocalHandler.onClose();
        },
      };
    }),
  );

  app.get("/api/files/tree", async (c) => {
    const pathParam = c.req.query("path") ?? "";
    const result = await listDirectory(homePath, pathParam);
    if (!result) {
      return c.json({ error: "Invalid path" }, 400);
    }
    return c.json(result);
  });

  app.get("/api/files/list", async (c) => {
    const pathParam = c.req.query("path") ?? "";
    const result = await listDirectory(homePath, pathParam);
    if (!result) {
      return c.json({ error: "Invalid path" }, 400);
    }
    return c.json({ path: pathParam, entries: result });
  });

  app.get("/api/files/stat", async (c) => {
    const pathParam = c.req.query("path");
    if (!pathParam) return c.json({ error: "path required" }, 400);
    const result = await fileStat(homePath, pathParam);
    if (!result) return c.json({ error: "Not found" }, 404);
    return c.json(result);
  });

  app.get("/api/files/search", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "q required" }, 400);
    if (q.length > 500) return c.json({ error: "q too long" }, 400);
    const rawLimit = c.req.query("limit");
    let limit: number | undefined;
    if (rawLimit) {
      limit = parseInt(rawLimit, 10);
      if (isNaN(limit) || limit < 1 || limit > 500) return c.json({ error: "limit must be 1-500" }, 400);
    }
    const result = await fileSearch(homePath, {
      q,
      path: c.req.query("path"),
      content: c.req.query("content") === "true",
      limit,
    });
    return c.json(result);
  });

  const fileBodyLimit = bodyLimit({ maxSize: 10 * 1024 * 1024 });
  const apiMessageBodyLimit = bodyLimit({ maxSize: 64 * 1024 });
  const bridgeQueryBodyLimit = bodyLimit({ maxSize: 1_000_000 });
  const bridgeDataBodyLimit = bodyLimit({ maxSize: 1_000_000 });
  const conversationBodyLimit = bodyLimit({ maxSize: 4096 });
  const layoutBodyLimit = bodyLimit({ maxSize: 100_000 });
  const canvasBodyLimit = bodyLimit({ maxSize: 100_000 });
  const taskBodyLimit = bodyLimit({ maxSize: 64 * 1024 });
  const renameAppBodyLimit = bodyLimit({ maxSize: 4096 });
  const appIconBodyLimit = bodyLimit({ maxSize: 4096 });
  const cronBodyLimit = bodyLimit({ maxSize: 64 * 1024 });
  const upgradeBodyLimit = bodyLimit({ maxSize: 4096 });
  const pushRegistrationBodyLimit = bodyLimit({ maxSize: 4096 });
  app.route("/", createWorkspaceRoutes({
    homePath,
    zellijRuntime: workspaceZellijRuntime,
    sessionRuntimeBridge: workspaceSessionRuntimeBridge,
    getOwnerScope: (c) => ({ type: "user", id: requireRequestPrincipal(c).userId }),
  }));
  let matrixSymphonyOrchestrator: ReturnType<typeof createMatrixSymphonyOrchestrator> | null = null;
  let matrixSymphonyStatusHub: ReturnType<typeof createSymphonyStatusHub> | null = null;
  if (kyselyInstance) {
    const repository = new KyselySymphonyRepository(kyselyInstance as Kysely<any>);
    await repository.bootstrap();
    const credentialStore = createFileSymphonyCredentialStore({ homePath });
    const linearSource = createLinearSource();
    const projectManager = createProjectManager({ homePath });
    const worktreeManager = createWorktreeManager({ homePath });
    const agentLauncher = createAgentLauncher({ cwd: homePath });
    const agentSessionManager = createAgentSessionManager({
      homePath,
      worktreeManager,
      agentLauncher,
      zellijRuntime: workspaceZellijRuntime,
    });
    matrixSymphonyStatusHub = createSymphonyStatusHub();
    matrixSymphonyOrchestrator = createMatrixSymphonyOrchestrator({
      homePath,
      repository,
      credentialStore,
      linearSource,
      worktreeManager,
      agentSessionManager,
      statusHub: matrixSymphonyStatusHub,
    });
    await matrixSymphonyOrchestrator.resumeEnabledInstallations();
    app.route("/api/symphony", createSymphonyRoutes({
      repository,
      credentialStore,
      linearSource,
      orchestrator: matrixSymphonyOrchestrator,
      statusHub: matrixSymphonyStatusHub,
      listMatrixProjects: async () => {
        const result = await projectManager.listManagedProjects();
        return result.projects.map((project) => ({
          slug: project.slug,
          name: project.name,
          repositoryUrl: project.github?.htmlUrl ?? project.remote,
          updatedAt: project.updatedAt,
        }));
      },
    }));
  } else {
    console.warn("[symphony] Matrix-native Symphony requires owner Postgres; routes are disabled");
    const unavailable = new Hono();
    unavailable.all("*", (c) => c.json({ error: { code: "symphony_unavailable", message: "Symphony is unavailable" } }, 503));
    app.route("/api/symphony", unavailable);
  }
  const workspaceStartupRecovery = await createWorkspaceStartupRecovery({ homePath }).run();
  if (workspaceStartupRecovery.status === "degraded") {
    console.warn("[gateway] Workspace startup recovery completed with degraded steps");
  }

  async function parseJson<T>(c: Parameters<MiddlewareHandler>[0]): Promise<T | null> {
    try {
      return await c.req.json<T>();
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        return null;
      }
      console.error("[gateway] Unexpected request JSON parse failure:", err);
      throw err;
    }
  }

  app.post("/api/files/mkdir", fileBodyLimit, async (c) => {
    const body = await parseJson<{ path: string }>(c);
    if (!body?.path) return c.json({ error: "path required" }, 400);
    const result = await fileMkdir(homePath, body.path);
    return c.json(result, result.ok ? 200 : 400);
  });

  app.post("/api/files/touch", fileBodyLimit, async (c) => {
    const body = await parseJson<{ path: string; content?: string }>(c);
    if (!body?.path) return c.json({ error: "path required" }, 400);
    const result = await fileTouch(homePath, body.path, body.content);
    return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
  });

  app.post("/api/files/duplicate", fileBodyLimit, async (c) => {
    const body = await parseJson<{ path: string }>(c);
    if (!body?.path) return c.json({ error: "path required" }, 400);
    const result = await fileDuplicate(homePath, body.path);
    return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
  });

  app.post("/api/files/rename", fileBodyLimit, async (c) => {
    const body = await parseJson<{ from: string; to: string }>(c);
    if (!body?.from || !body?.to) return c.json({ error: "from and to required" }, 400);
    const result = await fileRename(homePath, body.from, body.to);
    return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
  });

  app.post("/api/files/copy", fileBodyLimit, async (c) => {
    const body = await parseJson<{ from: string; to: string }>(c);
    if (!body?.from || !body?.to) return c.json({ error: "from and to required" }, 400);
    const result = await fileCopy(homePath, body.from, body.to);
    return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
  });

  app.post("/api/files/delete", fileBodyLimit, async (c) => {
    const body = await parseJson<{ path: string }>(c);
    if (!body?.path) return c.json({ error: "path required" }, 400);
    const result = await fileDelete(homePath, body.path);
    return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
  });

  app.get("/api/files/trash", async (c) => {
    const result = await trashList(homePath);
    return c.json(result);
  });

  app.post("/api/files/trash/restore", fileBodyLimit, async (c) => {
    const body = await parseJson<{ trashPath: string }>(c);
    if (!body?.trashPath) return c.json({ error: "trashPath required" }, 400);
    const result = await trashRestore(homePath, body.trashPath);
    return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
  });

  app.post("/api/files/trash/empty", fileBodyLimit, async (c) => {
    const result = await trashEmpty(homePath);
    return c.json(result);
  });

  app.get("/api/projects", async (c) => {
    const rootParam = (c.req.query("root") ?? "projects").trim();
    const result = await listProjects(homePath, rootParam);
    if (!result.ok) return c.json({ error: result.error }, result.status as ContentfulStatusCode);
    return c.json({ root: result.root, projects: result.projects });
  });

  app.get("/api/terminal/layout", async (c) => {
    const layoutPath = join(homePath, "system", "terminal-layout.json");
    try {
      const { readFile } = await import("node:fs/promises");
      const data = await readFile(layoutPath, "utf-8");
      return c.json(JSON.parse(data));
    } catch (err: unknown) {
      logBestEffortFailure("Failed to read terminal layout", err);
      return c.json({});
    }
  });

  const terminalLayoutBodyLimit = bodyLimit({ maxSize: 100_000 });
  app.put("/api/terminal/layout", terminalLayoutBodyLimit, async (c) => {
    const layoutPath = join(homePath, "system", "terminal-layout.json");
    const raw = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch (err: unknown) {
      logUnexpectedJsonParseFailure("Failed to parse terminal layout payload", err);
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (typeof body !== "object" || body === null || !Array.isArray((body as Record<string, unknown>).tabs)) {
      return c.json({ error: "Invalid layout schema" }, 400);
    }
    try {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(dirname(layoutPath), { recursive: true });
      await writeFile(layoutPath, JSON.stringify(body, null, 2));
      return c.json({ ok: true });
    } catch (err: unknown) {
      console.error("[gateway] Failed to save terminal layout:", err);
      return c.json({ error: "Failed to save layout" }, 500);
    }
  });

  registerTerminalSessionRoutes(app, { homePath, sessionRegistry });

  app.post("/api/message", apiMessageBodyLimit, async (c) => {
    const body = await c.req.json<{
      text: string;
      sessionId?: string;
      from?: { handle: string; displayName?: string };
    }>();
    const events: KernelEvent[] = [];

    const context: DispatchContext | undefined = body.from
      ? { senderId: body.from.handle, senderName: body.from.displayName ?? body.from.handle }
      : undefined;

    await dispatcher.dispatch(body.text, body.sessionId, (event) => {
      events.push(event);
    }, context);

    return c.json({ events });
  });

  function resolveServedFilePath(filePath: string): string | null {
    const fullPath = resolveWithinHome(homePath, filePath);
    if (!fullPath) {
      return null;
    }
    if (existsSync(fullPath)) {
      return fullPath;
    }

    if (!filePath.endsWith("/manifest.json")) {
      return fullPath;
    }

    const dirPath = dirname(fullPath);
    const fallbackCandidates = [join(dirPath, "module.json"), join(dirPath, "matrix.json")];
    for (const candidate of fallbackCandidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return fullPath;
  }

  app.on("HEAD", "/files/*", (c) => {
    const filePath = c.req.path.replace("/files/", "");
    const fullPath = resolveServedFilePath(filePath);
    if (!fullPath) return c.text("Forbidden", 403);
    if (!existsSync(fullPath)) return c.text("Not found", 404);
    if (statSync(fullPath).isDirectory()) return c.text("Is a directory", 400);
    return c.body(null, 200);
  });

  app.get("/files/*", (c) => {
    const filePath = c.req.path.replace("/files/", "");
    const fullPath = resolveServedFilePath(filePath);

    if (!fullPath) {
      return c.text("Forbidden", 403);
    }

    if (!existsSync(fullPath)) {
      return c.text("Not found", 404);
    }

    if (statSync(fullPath).isDirectory()) {
      return c.text("Is a directory", 400);
    }

    const ext = filePath.split(".").pop() ?? "";

    const textMimeTypes: Record<string, string> = {
      html: "text/html",
      json: "application/json",
      js: "application/javascript",
      css: "text/css",
      md: "text/markdown",
      txt: "text/plain",
    };

    const imageMimeTypes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
    };

    if (imageMimeTypes[ext]) {
      const stat = statSync(fullPath);
      const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
      if (c.req.header("if-none-match") === etag) {
        return c.body(null, 304);
      }
      const buffer = readFileSync(fullPath);
      return c.body(buffer, 200, {
        "Content-Type": imageMimeTypes[ext],
        "Cache-Control": "public, max-age=86400, immutable",
        "CDN-Cache-Control": "public, max-age=86400",
        "ETag": etag,
      });
    }

    const content = readFileSync(fullPath, "utf-8");
    return c.body(content, 200, {
      "Content-Type": textMimeTypes[ext] ?? "text/plain",
    });
  });

  app.put("/files/*", fileBodyLimit, async (c) => {
    const filePath = c.req.path.replace("/files/", "");
    const fullPath = resolveWithinHome(homePath, filePath);
    if (!fullPath) return c.text("Invalid path", 403);
    const content = await c.req.text();
    const dir = dirname(fullPath);
    await mkdirAsync(dir, { recursive: true });
    await writeFileAsync(fullPath, content, "utf-8");
    return c.json({ ok: true });
  });

  // Structured query API (Postgres-backed)
  app.post("/api/bridge/query", bridgeQueryBodyLimit, async (c) => {
    if (!queryEngine || !appRegistry) {
      return c.json({ error: "Database not configured (no DATABASE_URL)" }, 503);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      console.error("[bridge/query] Failed to read request body:", err);
      return c.json({ error: "Failed to read request body" }, 500);
    }

    const rawSlug = body.app as string;
    const action = body.action as string;
    const appSlug = rawSlug?.replace(/[^a-zA-Z0-9_-]/g, "");

    if (!action) {
      return c.json({ error: "action is required" }, 400);
    }

    if (action !== "listApps" && !appSlug) {
      return c.json({ error: "app is required and must contain valid characters" }, 400);
    }

    // Validate data for insert/update
    if ((action === "insert" || action === "update") && (body.data == null || typeof body.data !== "object" || Array.isArray(body.data))) {
      return c.json({ error: "data must be a non-null object" }, 400);
    }
    if ((action === "insert" || action === "update") && JSON.stringify(body.data).length > 1_000_000) {
      return c.json({ error: "data too large (max 1MB)" }, 413);
    }

    // Validate table is present for actions that need it
    const needsTable = ["find", "findOne", "insert", "update", "delete", "count"].includes(action);
    const safeTable = typeof body.table === "string" ? body.table.replace(/[^a-zA-Z0-9_-]/g, "") : "";
    if (needsTable && !safeTable) {
      return c.json({ error: "table is required and must contain valid characters" }, 400);
    }

    // Validate id is present for actions that need it
    const needsId = ["findOne", "update", "delete"].includes(action);
    if (needsId && !body.id) {
      return c.json({ error: "id is required" }, 400);
    }

    // Validate filter: must be a plain object with string keys (parseSafeName validates in query engine)
    if (body.filter != null && (typeof body.filter !== "object" || Array.isArray(body.filter))) {
      return c.json({ error: "filter must be a plain object" }, 400);
    }

    // Validate orderBy: must be a plain object with only "asc"/"desc" values
    if (body.orderBy != null) {
      if (typeof body.orderBy !== "object" || Array.isArray(body.orderBy)) {
        return c.json({ error: "orderBy must be a plain object" }, 400);
      }
      for (const [, dir] of Object.entries(body.orderBy as Record<string, unknown>)) {
        if (dir !== "asc" && dir !== "desc") {
          return c.json({ error: "orderBy values must be 'asc' or 'desc'" }, 400);
        }
      }
    }

    // Validate limit/offset are non-negative integers
    if (body.limit != null && (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 0)) {
      return c.json({ error: "limit must be a non-negative integer" }, 400);
    }
    if (body.offset != null && (typeof body.offset !== "number" || !Number.isInteger(body.offset) || body.offset < 0)) {
      return c.json({ error: "offset must be a non-negative integer" }, 400);
    }

    try {
      switch (action) {
        case "find":
          return c.json(await queryEngine.find(appSlug, safeTable, {
            filter: body.filter as Record<string, FilterValue> | undefined,
            orderBy: body.orderBy as Record<string, "asc" | "desc"> | undefined,
            limit: body.limit as number | undefined,
            offset: body.offset as number | undefined,
          }));
        case "findOne":
          return c.json(await queryEngine.findOne(appSlug, safeTable, body.id as string));
        case "insert": {
          const result = await queryEngine.insert(appSlug, safeTable, body.data as Record<string, unknown>);
          broadcast({ type: "data:change", app: appSlug, key: safeTable });
          return c.json(result, 201);
        }
        case "update": {
          await queryEngine.update(appSlug, safeTable, body.id as string, body.data as Record<string, unknown>);
          broadcast({ type: "data:change", app: appSlug, key: safeTable });
          return c.json({ ok: true });
        }
        case "delete": {
          await queryEngine.delete(appSlug, safeTable, body.id as string);
          broadcast({ type: "data:change", app: appSlug, key: safeTable });
          return c.json({ ok: true });
        }
        case "count":
          return c.json({ count: await queryEngine.count(appSlug, safeTable, body.filter as Record<string, FilterValue> | undefined) });
        case "schema":
          return c.json(await appRegistry.getSchema(appSlug));
        case "listApps":
          return c.json(await appRegistry.listApps());
        default:
          return c.json({ error: `Unknown action: ${action}` }, 400);
      }
    } catch (e) {
      const msg = (e as Error).message;
      console.error("[app-db] Query error:", msg);
      const isValidation = msg.startsWith("Invalid ") || msg.startsWith("insert:") || msg.startsWith("update:");
      const safe = isValidation ? msg : "Query failed";
      return c.json({ error: safe }, isValidation ? 400 : 500);
    }
  });

  // Key-value bridge: GET for reads (query params), POST for read/write (JSON body)
  app.get("/api/bridge/data", async (c) => {
    const appName = c.req.query("app");
    const key = c.req.query("key");
    if (!appName || !key) return c.json({ error: "app and key query params required" }, 400);

    const safeApp = appName.replace(/[^a-zA-Z0-9_-]/g, "");
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeApp || !safeKey) return c.json({ error: "Invalid app or key" }, 400);

    if (kvStore) {
      try {
        const value = await kvStore.read(safeApp, safeKey);
        return c.json({ value });
      } catch (e) {
        console.error(`[app-db] KV read error for ${safeApp}/${safeKey}:`, (e as Error).message);
        return c.json({ error: "Database read failed" }, 500);
      }
    }

    const dataDir = join(homePath, "data", safeApp);
    const filePath = normalize(join(dataDir, `${safeKey}.json`));
    if (!filePath.startsWith(normalize(dataDir))) return c.json({ error: "Path traversal denied" }, 403);
    if (!existsSync(filePath)) return c.json({ value: null });
    const content = readFileSync(filePath, "utf-8");
    let value = content;
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === "string") value = parsed;
    } catch (err: unknown) {
      logUnexpectedJsonParseFailure("Failed to parse stored bridge value", err);
    }
    return c.json({ value });
  });

  app.post("/api/bridge/data", bridgeDataBodyLimit, async (c) => {
    let body: { action: "read" | "write"; app: string; key: string; value?: string };
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      console.error("[bridge/data] Failed to read request body:", err);
      return c.json({ error: "Failed to read request body" }, 500);
    }

    if (!body.app || typeof body.app !== "string" || !body.key || typeof body.key !== "string") {
      return c.json({ error: "app and key are required strings" }, 400);
    }

    const safeApp = body.app.replace(/[^a-zA-Z0-9_-]/g, "");
    const safeKey = body.key.replace(/[^a-zA-Z0-9_-]/g, "");

    if (!safeApp || !safeKey) {
      return c.json({ error: "app and key must contain valid characters" }, 400);
    }

    // Postgres-backed path
    if (kvStore) {
      try {
        if (body.action === "read") {
          const value = await kvStore.read(safeApp, safeKey);
          return c.json({ value });
        }
        await kvStore.write(safeApp, safeKey, body.value ?? "");
        broadcast({ type: "data:change", app: safeApp, key: safeKey });
        return c.json({ ok: true });
      } catch (e) {
        console.error(`[app-db] KV ${body.action} error for ${safeApp}/${safeKey}:`, (e as Error).message);
        return c.json({ error: "Database operation failed" }, 500);
      }
    }

    // File-based fallback (no Postgres)
    const dataDir = join(homePath, "data", safeApp);
    const filePath = normalize(join(dataDir, `${safeKey}.json`));

    if (!filePath.startsWith(normalize(dataDir))) {
      return c.json({ error: "Path traversal denied" }, 403);
    }

    if (body.action === "read") {
      if (!existsSync(filePath)) return c.json({ value: null });
      const content = readFileSync(filePath, "utf-8");
      let value = content;
      try {
        const parsed = JSON.parse(content);
        if (typeof parsed === "string") {
          value = parsed;
        }
      } catch (err: unknown) {
        logUnexpectedJsonParseFailure("Failed to parse stored bridge data", err);
      }
      return c.json({ value });
    }

    await mkdirAsync(dataDir, { recursive: true });
    const raw = body.value ?? "";
    await writeFileAsync(filePath, typeof raw === "string" ? raw : String(raw), "utf-8");
    broadcast({ type: "data:change", app: safeApp, key: safeKey });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Bridge: Integration service calls (for apps in iframes)
  // ---------------------------------------------------------------------------

  app.get("/api/bridge/service", async (c) => {
    if (!platformDb || !resolveIntegrationUserId) {
      return c.json({ error: "Integrations not configured" }, 503);
    }
    const uid = await resolveIntegrationUserId(c);
    if (!uid) return c.json({ error: "Unauthorized" }, 401);
    const services = await platformDb.listConnectedServices(uid);
    return c.json({
      services: services.map((s) => ({
        service: s.service,
        account_label: s.account_label,
        account_email: s.account_email,
        status: s.status,
      })),
    });
  });

  app.post("/api/bridge/service", bodyLimit({ maxSize: 65536 }), async (c) => {
    if (process.env.NODE_ENV === "production") {
      return c.json({ error: "Bridge not available in production" }, 403);
    }
    if (!platformDb || !pipedreamClient || !resolveIntegrationUserId) {
      return c.json({ error: "Integrations not configured" }, 503);
    }

    // Mirror CallBodySchema from integrations/routes.ts. The route is dev-only
    // (production returns 403 above) so the security risk of an unvalidated
    // body is minimal, but the cast was inconsistent with every other mutating
    // endpoint in this PR and provided zero runtime protection.
    let parsedJson: unknown;
    try {
      parsedJson = await c.req.json();
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        return c.json({ error: "Invalid JSON" }, 400);
      }
      console.error("[bridge/service] Failed to read request body:", err);
      return c.json({ error: "Failed to read request body" }, 500);
    }
    const parsed = BridgeCallBodySchema.safeParse(parsedJson);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }

    const { service, action, label, params } = parsed.data;

    const def = getService(service);
    if (!def) return c.json({ error: `Unknown service: ${service}` }, 400);
    const actionDef = getAction(service, action);
    if (!actionDef) return c.json({ error: `Unknown action: ${action}` }, 400);

    const paramValidation = validateActionParams(actionDef, params);
    if (!paramValidation.valid) {
      const parts: string[] = [];
      if (paramValidation.missing.length > 0) parts.push(`Missing required params: ${paramValidation.missing.join(", ")}`);
      if (paramValidation.typeErrors.length > 0) parts.push(`Invalid param type: ${paramValidation.typeErrors.join("; ")}`);
      return c.json({ error: parts.join(". ") }, 400);
    }

    const uid = await resolveIntegrationUserId(c);
    if (!uid) return c.json({ error: "Unauthorized" }, 401);

    const connections = await platformDb.listConnectedServices(uid);
    let connection;
    if (label) {
      connection = connections.find((s) => s.service === service && s.account_label === label);
    } else {
      connection = connections.find((s) => s.service === service);
    }
    if (!connection) {
      return c.json({ error: `Service ${service} is not connected` }, 404);
    }

    const fullUser = await platformDb.getUserById(uid);
    const externalId = fullUser?.pipedream_external_id || uid;
    if (!fullUser?.pipedream_external_id) {
      await platformDb.updatePipedreamExternalId(uid, externalId);
    }

    try {
      const { data, summary } = await executeIntegrationAction({
        pipedream: pipedreamClient,
        externalUserId: externalId,
        connection,
        def,
        actionDef,
        serviceId: service,
        actionId: action,
        params,
      });
      await platformDb.touchServiceUsage(connection.id);
      return c.json({ data, service, action, ...(summary ? { summary } : {}) });
    } catch (err) {
      if (err instanceof IntegrationActionNotImplementedError) {
        return c.json({ error: err.message }, 501);
      }
      if (getErrorStatusCode(err) === 429) {
        const retryAfter = getRetryAfterSeconds(err);
        return c.json(
          { error: "Rate limited by provider. Please try again later.", retry_after: retryAfter },
          { status: 429, headers: { "Retry-After": String(retryAfter) } },
        );
      }
      const isAbort = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      if (isAbort) {
        console.error(`[bridge/service] ${service}/${action} timeout`);
        return c.json({ error: "Integration call timed out" }, 504);
      }
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("enetunreach")) {
        console.error(`[bridge/service] ${service}/${action} connection error:`, err);
        return c.json({ error: "Integration service unavailable" }, 503);
      }
      console.error(`[bridge/service] ${service}/${action} error:`, err instanceof Error ? err.message : err);
      return c.json({ error: "Integration call failed" }, 502);
    }
  });

  app.get("/api/conversations", (c) => {
    return c.json(conversations.list());
  });

  app.post("/api/conversations", conversationBodyLimit, async (c) => {
    let body: { channel?: string } = {};
    try {
      body = await c.req.json<{ channel?: string }>();
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        console.error("[gateway] Failed to read conversation create body:", err);
      }
    }
    const id = conversations.create(body.channel);
    return c.json({ id }, 201);
  });

  app.delete("/api/conversations/:id", (c) => {
    const id = c.req.param("id");
    const deleted = conversations.delete(id);
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/api/conversations/:id/search", (c) => {
    const query = c.req.query("q");
    if (!query) return c.json({ error: "q parameter required" }, 400);
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    const results = conversations.search(query, { limit });
    return c.json(results);
  });

  app.get("/api/layout", (c) => {
    const layoutPath = join(homePath, "system/layout.json");
    if (!existsSync(layoutPath)) {
      return c.json({});
    }
    try {
      const data = JSON.parse(readFileSync(layoutPath, "utf-8"));
      return c.json(data);
    } catch (err: unknown) {
      logBestEffortFailure("Failed to read layout", err);
      return c.json({});
    }
  });

  app.put("/api/layout", layoutBodyLimit, async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    if (!body || typeof body !== "object" || !Array.isArray(body.windows)) {
      return c.json({ error: "Invalid layout: requires windows array" }, 400);
    }
    const layoutPath = join(homePath, "system/layout.json");
    await mkdirAsync(dirname(layoutPath), { recursive: true });
    await writeFileAsync(layoutPath, JSON.stringify(body, null, 2));
    return c.json({ ok: true });
  });

  app.get("/api/canvas", async (c) => {
    if (!canvasService) {
      return c.json({ error: "Database not configured (no DATABASE_URL)" }, 503);
    }
    try {
      const userId = requireRequestPrincipal(c).userId;
      const result = await canvasService.listCanvases(userId);
      return c.json({
        legacy: true,
        canvasesEndpoint: "/api/canvases",
        canvases: result.canvases,
      });
    } catch (err: unknown) {
      if (isRequestPrincipalError(err)) {
        const mapped = mapRequestPrincipalError(err, "Canvas request failed");
        if (mapped.log) {
          console.error("[canvas] Legacy canvas route request principal misconfigured:", err.name);
        }
        return c.json(mapped.body, mapped.status);
      }
      logBestEffortFailure("Failed to read Postgres-backed canvas summaries", err);
      return c.json({ error: "Canvas request failed" }, 500);
    }
  });

  app.put("/api/canvas", canvasBodyLimit, (c) => {
    if (!canvasService) {
      return c.json({ error: "Database not configured (no DATABASE_URL)" }, 503);
    }
    return c.json({
      error: "Legacy canvas writes moved to /api/canvases",
      canvasesEndpoint: "/api/canvases",
    }, 410);
  });

  app.get("/api/theme", (c) => {
    const themePath = join(homePath, "system/theme.json");
    if (!existsSync(themePath)) {
      return c.json({ error: "No theme" }, 404);
    }
    const theme = JSON.parse(readFileSync(themePath, "utf-8"));
    return c.json(theme);
  });

  app.all("/modules/:name/*", async (c) => {
    const moduleName = c.req.param("name");
    const modulesPath = join(homePath, "system/modules.json");

    if (!existsSync(modulesPath)) {
      return c.text("No modules registered", 404);
    }

    const modules = JSON.parse(readFileSync(modulesPath, "utf-8")) as Array<{
      name: string;
      port: number;
      status: string;
    }>;

    const mod = modules.find((m) => m.name === moduleName);
    if (!mod) {
      return c.text(`Module "${moduleName}" not found`, 404);
    }

    const subPath = c.req.path.replace(`/modules/${moduleName}`, "") || "/";
    const targetUrl = `http://localhost:${mod.port}${subPath}`;

    const res = await fetch(targetUrl, {
      method: c.req.method,
      headers: c.req.raw.headers,
      signal: AbortSignal.timeout(30_000),
      body: c.req.method !== "GET" && c.req.method !== "HEAD"
        ? c.req.raw.body
        : undefined,
    });

    return new Response(res.body, {
      status: res.status,
      headers: res.headers,
    });
  });

  app.get("/api/tasks", (c) => {
    const status = c.req.query("status");
    const tasks = listTasks(dispatcher.db, status ? { status } : undefined);
    return c.json(tasks);
  });

  app.post("/api/tasks", taskBodyLimit, async (c) => {
    const body = await c.req.json<{ type?: string; input: string; priority?: number }>();
    if (!body.input || typeof body.input !== "string") {
      return c.json({ error: "input is required" }, 400);
    }
    const id = createTask(dispatcher.db, {
      type: body.type ?? "todo",
      input: body.input,
      priority: body.priority,
    });
    const task = getTask(dispatcher.db, id);
    broadcast({
      type: "task:created",
      task: { id, type: body.type ?? "todo", status: "pending", input: body.input },
    });
    return c.json({ id, task }, 201);
  });

  app.get("/api/tasks/:id", (c) => {
    const task = getTask(dispatcher.db, c.req.param("id"));
    if (!task) return c.json({ error: "Not found" }, 404);
    return c.json(task);
  });

  app.get("/api/apps", async (c) => {
    return c.json(await listApps(homePath));
  });

  const redirectIconRequest = async (c: Context) => {
    const file = c.req.param("file");
    if (!file) return c.text("Icon not found", 404);
    const target = await resolveSystemIconUrl(homePath, file);
    if (!target) return c.text("Icon not found", 404);
    return c.redirect(target, 307);
  };

  app.on("HEAD", "/icons/:file", redirectIconRequest);
  app.get("/icons/:file", redirectIconRequest);

  app.put("/api/apps/:slug/rename", renameAppBodyLimit, async (c) => {
    const slug = c.req.param("slug");
    const { name } = await c.req.json<{ name: string }>();
    const result = renameApp(homePath, slug, name);
    if (!result.success) {
      const status = result.error?.includes("not found") ? 404 : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json({ ok: true, newSlug: result.newSlug });
  });

  app.delete("/api/apps/:slug", async (c) => {
    const slug = c.req.param("slug");
    const result = deleteApp(homePath, slug);
    if (!result.success) {
      const status = result.error?.includes("not found") ? 404 : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json({ ok: true });
  });

  app.post("/api/apps/:slug/icon", appIconBodyLimit, async (c) => {
    const slug = c.req.param("slug");
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
      return c.json({ error: "Invalid slug" }, 400);
    }

    let body: { style?: string; regenerate?: boolean } = {};
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        console.error("[gateway] Failed to parse icon generation body:", err);
        return c.json({ error: "Failed to read request body" }, 500);
      }
    }

    const explicitRegeneration = isExplicitIconRegeneration(body);
    const shippedDefaultIcon = explicitRegeneration ? null : await resolveDefaultAppIconUrl(homePath, slug);
    if (shippedDefaultIcon) {
      return c.json({
        iconUrl: shippedDefaultIcon,
        generated: false,
        shipped: true,
      });
    }
    const geminiKey = process.env.GEMINI_API_KEY ?? "";
    if (!geminiKey) {
      return c.json({
        iconUrl: (await resolveSystemIconUrl(homePath, `${slug}.png`)) ?? "/files/system/icons/game.svg",
        generated: false,
      });
    }
    try {
      const iconStyle = body.style || loadIconStyle(homePath);
      const client = createImageClient(geminiKey);
      const prompt = buildIconPrompt(slug, iconStyle);
      const iconsDir = join(homePath, "system/icons");
      const result = await client.generateImage(prompt, {
        aspectRatio: "1:1",
        imageDir: iconsDir,
        saveAs: `${slug}.png`,
      });
      const iconPath = join(iconsDir, `${slug}.png`);
      const stat = statSync(iconPath);
      const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
      c.header("ETag", etag);
      return c.json({
        iconUrl: `/files/system/icons/${slug}.png`,
        etag,
        cost: result.cost,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`Icon generation failed for "${slug}":`, message);
      return c.json({ error: "Icon generation failed" }, 500);
    }
  });

  app.post("/api/icons/regenerate-all", appIconBodyLimit, async (c) => {
    const geminiKey = process.env.GEMINI_API_KEY ?? "";
    if (!geminiKey) {
      return c.json({ regenerated: 0, failed: [], generated: false });
    }

    const iconsDir = join(homePath, "system/icons");
    if (!existsSync(iconsDir)) {
      return c.json({ regenerated: 0, failed: [] });
    }

    const apps = await listApps(homePath);
    const appSlugs = new Set(apps.map((a) => a.slug).filter(Boolean));
    const pngFiles = readdirSync(iconsDir)
      .filter((f: string) => f.endsWith(".png"))
      .filter((f: string) => appSlugs.has(f.replace(/\.png$/, "")));

    const iconStyle = loadIconStyle(homePath);
    const total = pngFiles.length;

    // Return 202 immediately, regenerate in background
    const regeneration = (async () => {
      const client = createImageClient(geminiKey);
      let regenerated = 0;
      const failed: string[] = [];
      for (const file of pngFiles) {
        const slug = file.replace(/\.png$/, "");
        try {
          await client.generateImage(buildIconPrompt(slug, iconStyle), {
            aspectRatio: "1:1",
            imageDir: iconsDir,
            saveAs: `${slug}.png`,
          });
          regenerated++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          console.error(`Icon regeneration failed for "${slug}":`, msg);
          failed.push(slug);
        }
      }
      console.log(`[icons] Regeneration complete: ${regenerated}/${total} succeeded, ${failed.length} failed`);
    })();
    regeneration.catch((err) => console.error("[icons] Regeneration error:", err));

    return c.json({ accepted: true, total }, 202);
  });

  app.get("/api/cron", (c) => {
    return c.json(cronService.listJobs());
  });

  app.post("/api/cron", cronBodyLimit, async (c) => {
    const body = await c.req.json<{
      name: string;
      message: string;
      schedule: { type: string; intervalMs?: number; cron?: string; at?: string };
      target?: { channel: string; chatId: string };
    }>();
    if (!body.name || !body.message || !body.schedule?.type) {
      return c.json({ error: "name, message, and schedule.type are required" }, 400);
    }
    const { type } = body.schedule;
    let schedule: import("./cron/types.js").CronSchedule;
    if (type === "interval" && body.schedule.intervalMs) {
      schedule = { type: "interval", intervalMs: body.schedule.intervalMs };
    } else if (type === "cron" && body.schedule.cron) {
      schedule = { type: "cron", cron: body.schedule.cron };
    } else if (type === "once" && body.schedule.at) {
      schedule = { type: "once", at: body.schedule.at };
    } else {
      return c.json({ error: "Invalid schedule" }, 400);
    }
    const job: import("./cron/types.js").CronJob = {
      id: crypto.randomUUID(),
      name: body.name,
      message: body.message,
      schedule,
      target: body.target as import("./cron/types.js").CronTarget | undefined,
      createdAt: new Date().toISOString(),
    };
    cronService.addJob(job);
    return c.json(job, 201);
  });

  app.delete("/api/cron/:id", (c) => {
    const id = c.req.param("id");
    const removed = cronService.removeJob(id);
    if (!removed) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/api/channels/status", (c) => {
    return c.json(channelManager.status());
  });

  app.get("/api/identity", (c) => {
    return c.json(loadHandle(homePath));
  });

  app.get("/api/profile", (c) => {
    const profilePath = join(homePath, "system", "profile.md");
    if (!existsSync(profilePath)) return c.text("No profile", 404);
    return c.text(readFileSync(profilePath, "utf-8"));
  });

  app.get("/api/ai-profile", (c) => {
    const aiProfilePath = join(homePath, "system", "ai-profile.md");
    if (!existsSync(aiProfilePath)) return c.text("No AI profile", 404);
    return c.text(readFileSync(aiProfilePath, "utf-8"));
  });

  app.get("/api/logs", (c) => {
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    const source = c.req.query("source");
    const entries = interactionLogger.query({ date, source });
    return c.json({ entries, totalCost: interactionLogger.totalCost(date) });
  });

  app.get("/api/security/audit", async (c) => {
    const { runSecurityAudit } = await import("@matrix-os/kernel/security/audit");
    const report = await runSecurityAudit(homePath);
    return c.json(report);
  });

  app.get("/api/system/info", (c) => {
    const info = getSystemInfo(homePath);
    const today = new Date().toISOString().slice(0, 10);
    return c.json({ ...info, todayCost: interactionLogger.totalCost(today) });
  });

  app.get("/api/system/update", async (c) => {
    const info = getSystemInfo(homePath);
    const channel = resolveSystemUpdateChannel(c.req.query("channel"), {
      envChannel: process.env.MATRIX_UPDATE_CHANNEL,
      installedChannel: info.release?.channel,
    });
    if (!channel) return c.json({ error: "Invalid update channel" }, 400);
    const result = await checkForSystemUpdate({
      installed: info.release ?? {
        version: info.version,
        gitCommit: info.build.sha,
        gitRef: info.build.ref,
        buildTime: info.build.date,
      },
      platformUrl: process.env.MATRIX_UPDATE_MANIFEST_BASE_URL ?? process.env.PLATFORM_INTERNAL_URL,
      channel,
    });
    return c.json(result);
  });

  app.get("/api/system/releases", async (c) => {
    const info = getSystemInfo(homePath);
    const channel = resolveSystemUpdateChannel(c.req.query("channel"), {
      envChannel: process.env.MATRIX_UPDATE_CHANNEL,
      installedChannel: info.release?.channel,
    });
    if (!channel) return c.json({ error: "Invalid update channel" }, 400);
    const result = await listSystemReleases({
      platformUrl: process.env.MATRIX_UPDATE_MANIFEST_BASE_URL ?? process.env.PLATFORM_INTERNAL_URL,
      channel,
    });
    return c.json(result);
  });

  app.post("/system/backup", bodyLimit({ maxSize: 1024 }), (c) => {
    const token = process.env.MATRIX_SYSTEM_BACKUP_TOKEN;
    if (!token) {
      return c.json({ error: "Backup trigger not configured" }, 503);
    }
    const authHeader = c.req.header("authorization");
    const presented = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!timingSafeStringEquals(presented, token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.json({ error: "Backup trigger not implemented" }, 501);
  });

  async function startUpdateFromRequest(c: Context) {
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        console.warn("[system-update] Failed to parse update request:", err);
      }
    }
    const info = getSystemInfo(homePath);
    const parsedTarget = parseInternalUpgradeTarget(body);
    if (!parsedTarget.ok) return c.json({ error: parsedTarget.error }, 400);
    const target = parsedTarget.target ?? (() => {
      const channel = resolveSystemUpdateChannel(undefined, {
        envChannel: process.env.MATRIX_UPDATE_CHANNEL,
        installedChannel: info.release?.channel,
      });
      return channel ? { type: "channel" as const, value: channel } : null;
    })();
    if (!target) return c.json({ error: "Invalid update channel" }, 400);

    const result = await startSystemUpdate({ target });
    if (!result.ok) {
      return c.json({ error: "Update not configured" }, 503);
    }
    void posthogErrorTracker.captureEvent("matrix_system_update_requested", {
      distinctId: process.env.MATRIX_HANDLE ?? "matrix-gateway",
      properties: {
        targetType: target.type,
        targetValue: target.value,
        channel: target.type === "channel" ? target.value : undefined,
        handle: process.env.MATRIX_HANDLE,
      },
    }).catch((err: unknown) => {
      const kind = err instanceof Error ? err.name : typeof err;
      console.warn(`[posthog] Failed to queue system update event: ${kind}`);
    });
    return c.json({
      ok: true,
      status: result.status,
      target,
      ...(target.type === "channel" ? { channel: target.value } : { version: target.value }),
    }, 202);
  }

  app.post("/api/system/update", upgradeBodyLimit, startUpdateFromRequest);

  app.post("/api/system/upgrade", upgradeBodyLimit, async (c) => {
    return startUpdateFromRequest(c);
  });

  const usageTracker = createUsageTracker(homePath);

  app.get("/api/usage", (c) => {
    try {
      const period = (c.req.query("period") ?? "daily") as string;
      const date = c.req.query("date") as string | undefined;
      const month = c.req.query("month") as string | undefined;

      if (period === "monthly") {
        return c.json(usageTracker.getMonthly(month));
      }
      return c.json(usageTracker.getDaily(date));
    } catch (err: unknown) {
      logBestEffortFailure("Failed to read usage stats", err);
      return c.json({ total: 0, byAction: {} });
    }
  });

  app.post("/api/push/register", pushRegistrationBodyLimit, async (c) => {
    const body = await c.req.json<{ token: string; platform: string }>();
    if (!body.token || !body.platform) {
      return c.json({ error: "token and platform are required" }, 400);
    }
    pushAdapter.registerToken(body.token, body.platform);
    return c.json({ ok: true });
  });

  app.delete("/api/push/register", pushRegistrationBodyLimit, async (c) => {
    const body = await c.req.json<{ token: string }>();
    if (!body.token) {
      return c.json({ error: "token is required" }, 400);
    }
    pushAdapter.removeToken(body.token);
    return c.json({ ok: true });
  });

  // T978-T979: Settings API routes
  const settingsRoutes = createSettingsRoutes({ homePath, channelManager });
  app.route("/api/settings", settingsRoutes);

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

  if (canvasService) {
    // Global authMiddleware is mounted before route registration; routes still resolve user IDs defensively.
    app.route("/api/canvases", createCanvasRoutes({
      service: canvasService,
      getUserId: (c) => requireRequestPrincipal(c).userId,
      broadcastCanvasUpdate: (canvasId, message) => canvasSubscriptionHub?.broadcast(canvasId, message),
    }));

    app.get(
      "/api/canvases/:canvasId/ws",
      upgradeWebSocket((c) => {
        const connectionId = `canvas_${randomBytes(12).toString("hex")}`;
        let canvasId: string;
        let userId: string;
        try {
          canvasId = CanvasIdSchema.parse(c.req.param("canvasId"));
          userId = requireRequestPrincipal(c).userId;
        } catch (err: unknown) {
          console.error("[canvas/ws] Upgrade rejected:", err instanceof Error ? err.message : String(err));
          return {
            onOpen(_evt, ws) {
              try {
                ws.send(JSON.stringify({ type: "error", error: "Canvas realtime failed" }));
              } catch (sendErr: unknown) {
                logUnexpectedWsSendFailure("Canvas WebSocket rejected error send failed", sendErr);
              } finally {
                ws.close();
              }
            },
          };
        }

        return {
          async onOpen(_evt, ws) {
            try {
              await canvasSubscriptionHub?.subscribe({
                connectionId,
                canvasId,
                userId,
                send: (message) => {
                  try {
                    ws.send(message);
                  } catch (err: unknown) {
                    logUnexpectedWsSendFailure("Canvas WebSocket send failed", err);
                  }
                },
              });
              ws.send(JSON.stringify({ type: "canvas:subscribed", canvasId }));
            } catch (err: unknown) {
              console.error("[canvas/ws] Subscribe failed:", err instanceof Error ? err.message : String(err));
              try {
                ws.send(JSON.stringify({ type: "error", error: "Canvas realtime failed" }));
              } catch (sendErr: unknown) {
                logUnexpectedWsSendFailure("Canvas WebSocket error send failed", sendErr);
              } finally {
                ws.close();
              }
            }
          },
          onMessage(evt) {
            try {
              const parsed = canvasSubscriptionHub?.validateInboundFrame(
                typeof evt.data === "string" ? evt.data : "",
              );
              if (
                typeof parsed === "object" &&
                parsed !== null &&
                (parsed as { type?: unknown }).type === "presence"
              ) {
                canvasSubscriptionHub?.updatePresence(
                  connectionId,
                  canvasSubscriptionHub.validatePresenceFrame(parsed),
                );
              }
            } catch (err: unknown) {
              canvasSubscriptionHub?.sendSafeError(connectionId, err);
            }
          },
          onClose() {
            canvasSubscriptionHub?.unsubscribe(connectionId);
          },
        };
      }),
    );
  } else {
    app.all("/api/canvases/*", (c) => c.json({ error: "Database not configured (no DATABASE_URL)" }, 503));
    app.all("/api/canvases", (c) => c.json({ error: "Database not configured (no DATABASE_URL)" }, 503));
  }

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

  // T2036: Activity auto-posting
  const activityService = createActivityService({
    homePath,
    createPost: queryEngine ? (post) => insertPost(queryEngine, post) : async () => "",
  });

  // T946: Plugin list endpoint
  app.get("/api/plugins", (c) => {
    return c.json(
      loadedPlugins.map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name ?? p.manifest.id,
        version: p.manifest.version ?? "0.0.0",
        description: p.manifest.description,
        origin: p.origin,
        status: p.status,
        error: p.error,
        contributions: pluginRegistry.getPluginContributions(p.manifest.id),
      })),
    );
  });

  // T2063: Leaderboard API routes
  const { getLeaderboard } = await import("./leaderboard.js");

  app.get("/api/games/leaderboard", (c) => {
    return c.json(getLeaderboard(homePath));
  });

  app.get("/api/games/leaderboard/:game", (c) => {
    const game = c.req.param("game");
    return c.json(getLeaderboard(homePath, game));
  });

  app.get("/health", (c) => c.json({
    status: "ok",
    cronJobs: cronService.listJobs().length,
    channels: channelManager.status(),
    plugins: loadedPlugins.length,
    workspace: {
      status: "ok",
    },
    sessions: {
      status: "ok",
    },
    reviews: {
      status: "ok",
    },
    sandbox: {
      status: typeof process.getuid === "function" && process.getuid() === 0 ? "degraded" : "ok",
    },
    browserIde: {
      status: process.env.MATRIX_CODE_SERVER_PORT ? "configured" : "disabled",
    },
  }));

  app.post("/api/internal/upgrade", upgradeBodyLimit, async (c) => {
    const upgradeToken = process.env.UPGRADE_TOKEN;
    if (!upgradeToken) return c.json({ error: "UPGRADE_TOKEN not configured" }, 503);
    const auth = c.req.header("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!timingSafeStringEquals(token, upgradeToken)) return c.json({ error: "Unauthorized" }, 401);

    let body: unknown = {};
    const raw = await c.req.text();
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch (err: unknown) {
        logUnexpectedJsonParseFailure("Failed to parse internal upgrade payload", err);
        return c.json({ error: "Invalid JSON" }, 400);
      }
    }

    const result = await writeInternalUpgradeTrigger({ body });
    if (!result.ok) return c.json({ error: result.error }, 400);

    return c.json({ status: "upgrading", target: result.target }, 202);
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
      if (canvasCleanupTimer) clearInterval(canvasCleanupTimer);
      canvasSubscriptionHub?.close();
      await channelManager.stop();
      await processManager.shutdownAll();
      await matrixSymphonyOrchestrator?.shutdown();
      await symphonyRunner.stop();
      await sessionRegistry.shutdown();
      await watcher.close();
      await homeMirror?.stop();
      await homeMirrorStart?.catch((err: unknown) => {
        logBestEffortFailure("Home mirror startup failed during shutdown", err);
      });
      syncR2?.destroy();
      await canvasRepository?.destroy();
      await socialRoutes?.shutdownPostHog();
      await appDb?.destroy();
      await posthogErrorTracker.shutdown();
      server.close();
    },
  };
}
