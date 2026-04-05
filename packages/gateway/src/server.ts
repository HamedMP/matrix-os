import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, normalize, resolve, relative } from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { createDispatcher, type Dispatcher, type BatchEntry, type DispatchContext } from "./dispatcher.js";
import { createWatcher, type Watcher } from "./watcher.js";
import { createPtyHandler, type PtyMessage } from "./pty.js";
import { SessionRegistry, ClientMessageSchema, UUID_REGEX, type SessionHandle, type PtyServerMessage, type SessionInfo } from "./session-registry.js";
import { createConversationStore, type ConversationStore } from "./conversations.js";
import { summarizeConversation, saveSummary } from "./conversation-summary.js";
import { extractMemoriesLocal } from "./memory-extractor.js";
import { resolveWithinHome } from "./path-security.js";
import { listDirectory } from "./files-tree.js";
import { fileStat, fileMkdir, fileTouch, fileRename, fileCopy, fileDuplicate } from "./file-ops.js";
import { fileSearch } from "./file-search.js";
import { fileDelete, trashList, trashRestore, trashEmpty } from "./trash.js";
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
  createUsageTracker,
  createMemoryStore,
} from "@matrix-os/kernel";
import { createProvisioner } from "./provisioner.js";
import { authMiddleware } from "./auth.js";
import { securityHeadersMiddleware } from "./security/headers.js";
import { getSystemInfo } from "./system-info.js";
import { createInteractionLogger, type InteractionLogger } from "./logger.js";
import { createApprovalBridge, type ApprovalBridge } from "./approval.js";
import { DEFAULT_APPROVAL_POLICY, type ApprovalPolicy } from "@matrix-os/kernel";
import { listApps } from "./apps.js";
import { createAppDb, type AppDb } from "./app-db.js";
import { createAppRegistry, type AppRegistry } from "./app-db-registry.js";
import { createQueryEngine, type QueryEngine } from "./app-db-query.js";
import { createKvStore, type KvStore } from "./app-db-kv.js";
import { renameApp, deleteApp } from "./app-ops.js";
import {
  createPluginRegistry,
  loadAllPlugins,
  createHookRunner,
  type PluginRegistry,
  type HookRunner,
  type LoadedPlugin,
} from "./plugins/index.js";
import { createSettingsRoutes } from "./routes/settings.js";
import {
  handleInstall,
  handleUninstall,
  handlePublish,
  handleResubmit,
  handleUpdate,
  handleRollback,
  readAppFiles,
  type GalleryInstallDeps,
  type GalleryPublishDeps,
  type GalleryUpdateDeps,
} from "./gallery-routes.js";
import { createOrUpdateFromPublish } from "../../platform/src/gallery/listings.js";
import { createInstallation, getByUserAndListing, deleteInstallation as deleteGalleryInstallation, incrementInstallCount, decrementInstallCount } from "../../platform/src/gallery/installations.js";
import { createVersion, setCurrent } from "../../platform/src/gallery/versions.js";
import { runFullAudit } from "../../platform/src/gallery/security-audit.js";
import { markInstallationUpdated, getPreviousVersion } from "../../platform/src/gallery/update-detection.js";
import { applyUpdate, rollbackUpdate, snapshotAppData } from "./app-update.js";
import { getGalleryDb } from "../../platform/src/gallery/pg.js";
import { validateForPublish, generateSlug } from "./app-publish.js";
import { z } from "zod/v4";

const InstallBodySchema = z.object({
  listingId: z.string().min(1),
  target: z.enum(["personal", "organization"]).default("personal"),
  orgId: z.string().optional(),
  approvedPermissions: z.array(z.string()).default([]),
});

const PublishBodySchema = z.object({
  description: z.string().min(1).max(5000),
  longDescription: z.string().max(20000).optional(),
  category: z.string().min(1).max(50),
  tags: z.array(z.string().max(50)).max(20).optional(),
  screenshots: z.array(z.string()).max(10).optional(),
  visibility: z.enum(["public", "organization", "unlisted"]).default("public"),
  orgId: z.string().optional(),
  version: z.string().min(1).max(50),
  changelog: z.string().max(5000).optional(),
});

const UpdateBodySchema = z.object({
  listingId: z.string().min(1),
});

const ResubmitBodySchema = z.object({
  versionId: z.string().min(1),
});
import { createSocialRoutes, insertPost, bootstrapSocialSchema } from "./social.js";
import { createActivityService } from "./social-activity.js";
import type { WSContext } from "hono/ws";
import {
  metricsRegistry,
  httpRequestsTotal,
  httpRequestDuration,
  wsConnectionsActive,
  normalizePath,
} from "./metrics.js";

export interface GatewayConfig {
  homePath: string;
  port?: number;
  model?: string;
  maxTurns?: number;
  syncReport?: { added: string[]; updated: string[]; skipped: string[] };
}

type ClientMessage =
  | { type: "message"; text: string; sessionId?: string; requestId?: string }
  | { type: "switch_session"; sessionId: string }
  | { type: "approval_response"; id: string; approved: boolean };

export type ServerMessage =
  | { type: "kernel:init"; sessionId: string; requestId?: string }
  | { type: "kernel:text"; text: string; requestId?: string }
  | { type: "kernel:tool_start"; tool: string; requestId?: string }
  | { type: "kernel:tool_end"; input?: Record<string, unknown>; requestId?: string }
  | { type: "kernel:result"; data: unknown; requestId?: string }
  | { type: "kernel:error"; message: string; requestId?: string }
  | { type: "file:change"; path: string; event: string }
  | { type: "task:created"; task: { id: string; type: string; status: string; input: string } }
  | { type: "task:updated"; taskId: string; status: string }
  | { type: "provision:start"; appCount: number }
  | { type: "provision:complete"; total: number; succeeded: number; failed: number }
  | { type: "session:switched"; sessionId: string }
  | { type: "approval:request"; id: string; toolName: string; args: unknown; timeout: number }
  | { type: "os:sync-report"; payload: { added: string[]; updated: string[]; skipped: string[] } }
  | { type: "data:change"; app: string; key: string };

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
  }
}

function send(ws: WSContext, msg: ServerMessage) {
  ws.send(JSON.stringify(msg));
}

export async function createGateway(config: GatewayConfig) {
  const { homePath: rawHomePath, port = 4000, syncReport } = config;
  const homePath = resolve(rawHomePath);
  let syncReportSent = false;
  const allowedOrigins = Array.from(new Set(
    [
      process.env.SHELL_ORIGIN,
      process.env.PROXY_ORIGIN,
      "http://localhost:3000",
      "http://localhost:4001",
    ].filter((origin): origin is string => Boolean(origin)),
  ));

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const sessionRegistry = new SessionRegistry(homePath, {
    maxSessions: 20,
    bufferSize: 5 * 1024 * 1024,
    persistPath: join(homePath, "system", "terminal-sessions.json"),
  });

  const dispatcher: Dispatcher = createDispatcher({
    homePath,
    model: config.model,
    maxTurns: config.maxTurns,
  });

  const watcher: Watcher = createWatcher(homePath);
  const conversations: ConversationStore = createConversationStore(homePath);
  const clients = new Set<WSContext>();

  // App data layer (Postgres-backed when DATABASE_URL is set)
  const databaseUrl = process.env.DATABASE_URL;
  let appDb: AppDb | null = null;
  let queryEngine: QueryEngine | null = null;
  let kvStore: KvStore | null = null;
  let appRegistry: AppRegistry | null = null;

  if (databaseUrl) {
    try {
      const { db, kysely } = createAppDb(databaseUrl);
      appDb = db;
      await appDb.bootstrap();
      queryEngine = createQueryEngine(appDb);
      kvStore = createKvStore(kysely);
      appRegistry = createAppRegistry(appDb, kysely);
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
        const apps = listApps(homePath);
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
    }
  }

  function logHealing(message: string) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [heal] ${message}\n`;
    const logPath = join(homePath, "system/activity.log");
    try { appendFileSync(logPath, line); } catch { /* log dir may not exist yet */ }
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

  function finalizeWithSummary(sid: string) {
    conversations.finalize(sid);
    try {
      const conv = conversations.get(sid);
      if (conv && conv.messages.length > 0) {
        const summary = summarizeConversation({ id: conv.id, messages: conv.messages });
        if (summary) saveSummary(homePath, sid, summary);

        const candidates = extractMemoriesLocal(
          conv.messages.map((m) => ({ role: m.role, content: m.content })),
        );
        if (candidates.length > 0) {
          try {
            const memStore = createMemoryStore(dispatcher.db);
            for (const c of candidates) {
              memStore.remember(c.content, { source: sid, category: c.category });
            }
          } catch { /* memory extraction is best-effort */ }
        }
      }
    } catch { /* summary is best-effort */ }
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
  } catch { /* no channel config */ }

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
    channelManager.replay().catch(() => {});

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
            bot.setMyCommands(commands.slice(0, 100)).catch(() => {});
          }
        }
      } catch { /* best-effort */ }
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
  } catch { /* no heartbeat config */ }

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
  } catch { /* no approval config */ }

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
  } catch { /* no plugins config */ }

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
      if (!origin) {
        return undefined;
      }
      return allowedOrigins.includes(origin) ? origin : undefined;
    },
  }));
  app.use("*", securityHeadersMiddleware());
  app.use("*", authMiddleware(process.env.MATRIX_AUTH_TOKEN));

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
    upgradeWebSocket(() => {
      let pendingText: string | undefined;
      let activeSessionId: string | undefined;
      let approvalBridge: ApprovalBridge | undefined;

      return {
        onOpen(_evt, ws) {
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
          let parsed: ClientMessage;
          try {
            parsed = JSON.parse(
              typeof evt.data === "string" ? evt.data : "",
            ) as ClientMessage;
          } catch {
            send(ws, { type: "kernel:error", message: "Invalid JSON" });
            return;
          }

          if (parsed.type === "switch_session") {
            activeSessionId = parsed.sessionId;
            send(ws, { type: "session:switched", sessionId: parsed.sessionId });
            return;
          }

          if (parsed.type === "approval_response" && approvalBridge) {
            approvalBridge.handleResponse({ id: parsed.id, approved: parsed.approved });
            return;
          }

          if (parsed.type === "message") {
            pendingText = parsed.text;
            const requestId = parsed.requestId;

            dispatcher
              .dispatch(parsed.text, parsed.sessionId, (event) => {
                const msg = kernelEventToServerMessage(event, requestId);
                send(ws, msg);

                if (msg.type === "kernel:init") {
                  activeSessionId = msg.sessionId;
                  conversations.begin(msg.sessionId);
                  if (pendingText) {
                    conversations.addUserMessage(msg.sessionId, pendingText);
                    pendingText = undefined;
                  }
                } else if (msg.type === "kernel:text" && activeSessionId) {
                  conversations.appendAssistantText(activeSessionId, msg.text);
                } else if (msg.type === "kernel:result" && activeSessionId) {
                  finalizeWithSummary(activeSessionId);
                }
              })
              .catch((err: Error) => {
                if (activeSessionId) {
                  finalizeWithSummary(activeSessionId);
                }
                send(ws, {
                  type: "kernel:error",
                  message: err.message ?? "Kernel error",
                  requestId,
                });
              });
          }
        },

        onClose(_evt, ws) {
          clients.delete(ws);
          wsConnectionsActive.dec();
        },
      };
    }),
  );

  app.get(
    "/ws/terminal",
    upgradeWebSocket((c) => {
      const cwdParam = c.req.query("cwd");
      let handle: SessionHandle | null = null;
      let autoCreateTimer: ReturnType<typeof setTimeout> | null = null;
      let autoCreatedSessionId: string | null = null;

      const cleanupAutoCreatedSession = () => {
        if (handle) {
          const shouldDestroyAutoCreated = autoCreatedSessionId === handle.sessionId;
          handle.detach();
          handle = null;
          if (shouldDestroyAutoCreated && autoCreatedSessionId) {
            sessionRegistry.destroy(autoCreatedSessionId);
          }
        } else if (autoCreatedSessionId) {
          sessionRegistry.destroy(autoCreatedSessionId);
        }
        autoCreatedSessionId = null;
      };

      return {
        onOpen(_evt, ws) {
          const sendJson = (msg: PtyServerMessage) => {
            try { ws.send(JSON.stringify(msg)); } catch { /* ws closed */ }
          };

          // Backward compat: auto-create session if no attach message within 100ms
          if (cwdParam && cwdParam.length >= 1 && cwdParam.length <= 4096) {
            autoCreateTimer = setTimeout(() => {
              autoCreateTimer = null;
              if (handle) return;
              let sessionId: string | null = null;
              try {
                sessionId = sessionRegistry.create(cwdParam);
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
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch {
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
            try { ws.send(JSON.stringify(m)); } catch { /* ws closed */ }
          };

          switch (msg.type) {
            case "attach": {
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
                handle.detach();
                handle = null;
              }
              break;
          }
        },

        onClose() {
          if (autoCreateTimer) {
            clearTimeout(autoCreateTimer);
            autoCreateTimer = null;
          }
          cleanupAutoCreatedSession();
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

  async function parseJson<T>(c: Parameters<MiddlewareHandler>[0]): Promise<T | null> {
    try { return await c.req.json<T>(); } catch { return null; }
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
    return c.json(result, result.ok ? 200 : (result.status ?? 400));
  });

  app.post("/api/files/duplicate", fileBodyLimit, async (c) => {
    const body = await parseJson<{ path: string }>(c);
    if (!body?.path) return c.json({ error: "path required" }, 400);
    const result = await fileDuplicate(homePath, body.path);
    return c.json(result, result.ok ? 200 : (result.status ?? 400));
  });

  app.post("/api/files/rename", fileBodyLimit, async (c) => {
    const body = await parseJson<{ from: string; to: string }>(c);
    if (!body?.from || !body?.to) return c.json({ error: "from and to required" }, 400);
    const result = await fileRename(homePath, body.from, body.to);
    return c.json(result, result.ok ? 200 : (result.status ?? 400));
  });

  app.post("/api/files/copy", fileBodyLimit, async (c) => {
    const body = await parseJson<{ from: string; to: string }>(c);
    if (!body?.from || !body?.to) return c.json({ error: "from and to required" }, 400);
    const result = await fileCopy(homePath, body.from, body.to);
    return c.json(result, result.ok ? 200 : (result.status ?? 400));
  });

  app.post("/api/files/delete", fileBodyLimit, async (c) => {
    const body = await parseJson<{ path: string }>(c);
    if (!body?.path) return c.json({ error: "path required" }, 400);
    const result = await fileDelete(homePath, body.path);
    return c.json(result, result.ok ? 200 : (result.status ?? 400));
  });

  app.get("/api/files/trash", async (c) => {
    const result = await trashList(homePath);
    return c.json(result);
  });

  app.post("/api/files/trash/restore", fileBodyLimit, async (c) => {
    const body = await parseJson<{ trashPath: string }>(c);
    if (!body?.trashPath) return c.json({ error: "trashPath required" }, 400);
    const result = await trashRestore(homePath, body.trashPath);
    return c.json(result, result.ok ? 200 : (result.status ?? 400));
  });

  app.post("/api/files/trash/empty", fileBodyLimit, async (c) => {
    const result = await trashEmpty(homePath);
    return c.json(result);
  });

  app.get("/api/terminal/layout", async (c) => {
    const layoutPath = join(homePath, "system", "terminal-layout.json");
    try {
      const { readFile } = await import("node:fs/promises");
      const data = await readFile(layoutPath, "utf-8");
      return c.json(JSON.parse(data));
    } catch {
      return c.json({});
    }
  });

  const terminalLayoutBodyLimit = bodyLimit({ maxSize: 100_000 });
  app.put("/api/terminal/layout", terminalLayoutBodyLimit, async (c) => {
    const layoutPath = join(homePath, "system", "terminal-layout.json");
    const raw = await c.req.text();
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return c.json({ error: "Invalid JSON" }, 400); }
    if (typeof body !== "object" || body === null || !Array.isArray((body as Record<string, unknown>).tabs)) {
      return c.json({ error: "Invalid layout schema" }, 400);
    }
    try {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(dirname(layoutPath), { recursive: true });
      await writeFile(layoutPath, JSON.stringify(body, null, 2));
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Failed to save layout" }, 500);
    }
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

  app.delete("/api/terminal/sessions/:id", (c) => {
    const id = c.req.param("id");
    if (!UUID_REGEX.test(id)) return c.json({ error: "Invalid session ID" }, 400);
    const session = sessionRegistry.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    sessionRegistry.destroy(id);
    return c.json({ ok: true });
  });

  app.post("/api/message", async (c) => {
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

  app.on("HEAD", "/files/*", (c) => {
    const filePath = c.req.path.replace("/files/", "");
    const fullPath = resolveWithinHome(homePath, filePath);
    if (!fullPath) return c.text("Forbidden", 403);
    if (!existsSync(fullPath)) return c.text("Not found", 404);
    if (statSync(fullPath).isDirectory()) return c.text("Is a directory", 400);
    return c.body(null, 200);
  });

  app.get("/files/*", (c) => {
    const filePath = c.req.path.replace("/files/", "");
    const fullPath = resolveWithinHome(homePath, filePath);

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
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
    return c.json({ ok: true });
  });

  // Structured query API (Postgres-backed)
  app.post("/api/bridge/query", async (c) => {
    if (!queryEngine || !appRegistry) {
      return c.json({ error: "Database not configured (no DATABASE_URL)" }, 503);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
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
            filter: body.filter as Record<string, unknown> | undefined,
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
          return c.json({ count: await queryEngine.count(appSlug, safeTable, body.filter as Record<string, unknown> | undefined) });
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
    } catch { /* raw content */ }
    return c.json({ value });
  });

  app.post("/api/bridge/data", async (c) => {
    let body: { action: "read" | "write"; app: string; key: string; value?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
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
      } catch {
        // Not JSON, return raw content as-is
      }
      return c.json({ value });
    }

    mkdirSync(dataDir, { recursive: true });
    const raw = body.value ?? "";
    writeFileSync(filePath, typeof raw === "string" ? raw : String(raw), "utf-8");
    broadcast({ type: "data:change", app: safeApp, key: safeKey });
    return c.json({ ok: true });
  });

  app.get("/api/conversations", (c) => {
    return c.json(conversations.list());
  });

  app.post("/api/conversations", async (c) => {
    const body = await c.req.json<{ channel?: string }>().catch((): { channel?: string } => ({}));
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
    } catch {
      return c.json({});
    }
  });

  app.put("/api/layout", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    if (!body || typeof body !== "object" || !Array.isArray(body.windows)) {
      return c.json({ error: "Invalid layout: requires windows array" }, 400);
    }
    const layoutPath = join(homePath, "system/layout.json");
    writeFileSync(layoutPath, JSON.stringify(body, null, 2));
    return c.json({ ok: true });
  });

  app.get("/api/canvas", (c) => {
    const canvasPath = join(homePath, "system/canvas.json");
    if (!existsSync(canvasPath)) {
      return c.json({});
    }
    try {
      const data = JSON.parse(readFileSync(canvasPath, "utf-8"));
      return c.json(data);
    } catch {
      return c.json({});
    }
  });

  app.put("/api/canvas", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    if (!body || typeof body !== "object" || !body.transform) {
      return c.json({ error: "Invalid canvas data: requires transform object" }, 400);
    }
    const canvasPath = join(homePath, "system/canvas.json");
    writeFileSync(canvasPath, JSON.stringify(body, null, 2));
    return c.json({ ok: true });
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

  app.post("/api/tasks", async (c) => {
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

  app.get("/api/apps", (c) => {
    return c.json(listApps(homePath));
  });

  app.put("/api/apps/:slug/rename", async (c) => {
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

  // --- Gallery Install/Uninstall/Publish Routes ---

  app.post("/api/apps/install", async (c) => {
    const userId = c.req.header("x-platform-user-id");
    if (!userId) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const raw = await c.req.json().catch(() => null);
    const parsed = InstallBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    const body = parsed.data;

    try {
      const galleryDb = getGalleryDb();
      const deps: GalleryInstallDeps = {
        galleryDb,
        getListingById: async (id) => {
          return galleryDb.selectFrom('app_listings').selectAll().where('id', '=', id).executeTakeFirst() ?? null;
        },
        getVersionById: async (id) => {
          return galleryDb.selectFrom('app_versions').selectAll().where('id', '=', id).executeTakeFirst() ?? null;
        },
        getExistingInstall: (uid, lid) => getByUserAndListing(galleryDb, uid, lid),
        createInstallation: (input) => createInstallation(galleryDb, input),
        incrementInstallCount: (lid) => incrementInstallCount(galleryDb, lid).then(() => {}),
        deleteInstallation: (id) => deleteGalleryInstallation(galleryDb, id).then(() => {}),
        decrementInstallCount: (lid) => decrementInstallCount(galleryDb, lid).then(() => {}),
        copyAppFiles: (opts) => installApp({ ...opts }),
        removeAppFiles: (dir) => { try { rmSync(dir, { recursive: true }); return true; } catch { return false; } },
      };

      const result = await handleInstall(deps, {
        listingId: body.listingId,
        userId,
        homePath,
        target: body.target ?? 'personal',
        orgId: body.orgId,
        approvedPermissions: body.approvedPermissions ?? [],
      });

      return c.json(result.body, result.status as any);
    } catch (err) {
      console.error('[gallery] Install error:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Installation failed' }, 500);
    }
  });

  app.delete("/api/apps/:slug/uninstall", async (c) => {
    const slug = c.req.param("slug");
    const userId = c.req.header("x-platform-user-id");
    if (!userId) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const body = await c.req.json<{ installationId: string; preserveData?: boolean }>().catch(() => ({ installationId: '', preserveData: false }));
    if (!body.installationId) {
      return c.json({ error: "installationId is required" }, 400);
    }

    try {
      const galleryDb = getGalleryDb();
      const deps: GalleryInstallDeps = {
        galleryDb,
        getListingById: async () => null,
        getVersionById: async () => null,
        getExistingInstall: async () => {
          const install = await galleryDb.selectFrom('app_installations').selectAll().where('id', '=', body.installationId).executeTakeFirst();
          return install ?? null;
        },
        createInstallation: async () => null,
        incrementInstallCount: async () => {},
        deleteInstallation: (id) => deleteGalleryInstallation(galleryDb, id).then(() => {}),
        decrementInstallCount: (lid) => decrementInstallCount(galleryDb, lid).then(() => {}),
        copyAppFiles: () => ({ success: true }),
        removeAppFiles: (dir) => { try { rmSync(dir, { recursive: true }); return true; } catch { return false; } },
      };

      const result = await handleUninstall(deps, {
        slug,
        userId,
        homePath,
        installationId: body.installationId,
        preserveData: body.preserveData ?? false,
      });

      return c.json(result.body, result.status as any);
    } catch (err) {
      console.error('[gallery] Uninstall error:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Uninstall failed' }, 500);
    }
  });

  app.post("/api/apps/:slug/publish", async (c) => {
    const slug = c.req.param("slug");
    const userId = c.req.header("x-platform-user-id");
    if (!userId) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const raw = await c.req.json().catch(() => null);
    const parsed = PublishBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    const body = parsed.data;

    const appDir = join(homePath, "apps", slug);
    if (!existsSync(appDir)) {
      return c.json({ error: `App "${slug}" not found` }, 404);
    }

    try {
      const galleryDb = getGalleryDb();
      const deps: GalleryPublishDeps = {
        galleryDb,
        validateForPublish: (dir) => validateForPublish(dir),
        createOrUpdateFromPublish: (input) => createOrUpdateFromPublish(galleryDb, input),
        createVersion: (input) => createVersion(galleryDb, input),
        runFullAudit: (db, vid, input) => runFullAudit(db, vid, input),
        setCurrent: (db, lid, vid) => setCurrent(db, lid, vid),
        readAppFiles: (dir) => readAppFiles(dir),
      };

      const result = await handlePublish(deps, {
        appDir,
        authorId: userId,
        description: body.description,
        longDescription: body.longDescription,
        category: body.category,
        tags: body.tags,
        screenshots: body.screenshots,
        version: body.version,
        changelog: body.changelog,
        visibility: body.visibility ?? 'public',
        orgId: body.orgId,
      });

      return c.json(result.body, result.status as any);
    } catch (err) {
      console.error('[gallery] Publish error:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Publication failed' }, 500);
    }
  });

  app.post("/api/apps/:slug/publish/resubmit", async (c) => {
    const slug = c.req.param("slug");
    const userId = c.req.header("x-platform-user-id");
    if (!userId) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const raw = await c.req.json().catch(() => null);
    const parsed = ResubmitBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    const body = parsed.data;

    const appDir = join(homePath, "apps", slug);
    if (!existsSync(appDir)) {
      return c.json({ error: `App "${slug}" not found` }, 404);
    }

    try {
      const galleryDb = getGalleryDb();
      const version = await galleryDb.selectFrom('app_versions').selectAll().where('id', '=', body.versionId).executeTakeFirst();
      if (!version) {
        return c.json({ error: "Version not found" }, 404);
      }

      const deps: GalleryPublishDeps = {
        galleryDb,
        validateForPublish: (dir) => validateForPublish(dir),
        createOrUpdateFromPublish: async () => null,
        createVersion: async () => null,
        runFullAudit: (db, vid, input) => runFullAudit(db, vid, input),
        setCurrent: (db, lid, vid) => setCurrent(db, lid, vid),
        readAppFiles: (dir) => readAppFiles(dir),
      };

      const result = await handleResubmit(deps, {
        versionId: body.versionId,
        appDir,
        listingId: version.listing_id,
      });

      return c.json(result.body, result.status as any);
    } catch (err) {
      console.error('[gallery] Resubmit error:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Resubmission failed' }, 500);
    }
  });

  // POST /api/apps/:slug/update -- update installed app to latest version
  app.post("/api/apps/:slug/update", async (c) => {
    const slug = c.req.param("slug");
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
      return c.json({ error: "Invalid slug" }, 400);
    }

    const userId = c.req.header("x-platform-user-id");
    if (!userId) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const raw = await c.req.json().catch(() => null);
    const parsed = UpdateBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    const body = parsed.data;

    try {
      const galleryDb = getGalleryDb();
      const deps: GalleryUpdateDeps = {
        galleryDb,
        getInstallation: (uid, lid) => getByUserAndListing(galleryDb, uid, lid),
        getListingById: async (id) => {
          return galleryDb.selectFrom('app_listings').selectAll().where('id', '=', id).executeTakeFirst() ?? null;
        },
        getVersionById: async (id) => {
          return galleryDb.selectFrom('app_versions').selectAll().where('id', '=', id).executeTakeFirst() ?? null;
        },
        markInstallationUpdated: (iid, vid) => markInstallationUpdated(galleryDb, iid, vid),
        getPreviousVersion: (lid, vid) => getPreviousVersion(galleryDb, lid, vid),
        applyUpdate,
        rollbackUpdate,
        snapshotAppData,
      };

      const result = await handleUpdate(deps, {
        slug,
        userId,
        homePath,
        listingId: body.listingId,
      });

      return c.json(result.body, result.status as any);
    } catch (err) {
      console.error('[gallery] Update error:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Update failed' }, 500);
    }
  });

  // POST /api/apps/:slug/rollback -- roll back to previous version
  app.post("/api/apps/:slug/rollback", async (c) => {
    const slug = c.req.param("slug");
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
      return c.json({ error: "Invalid slug" }, 400);
    }

    const userId = c.req.header("x-platform-user-id");
    if (!userId) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const raw = await c.req.json().catch(() => null);
    const parsedRb = UpdateBodySchema.safeParse(raw);
    if (!parsedRb.success) {
      return c.json({ error: "Invalid request", details: parsedRb.error.issues }, 400);
    }
    const body = parsedRb.data;

    try {
      const galleryDb = getGalleryDb();
      const deps: GalleryUpdateDeps = {
        galleryDb,
        getInstallation: (uid, lid) => getByUserAndListing(galleryDb, uid, lid),
        getListingById: async (id) => {
          return galleryDb.selectFrom('app_listings').selectAll().where('id', '=', id).executeTakeFirst() ?? null;
        },
        getVersionById: async (id) => {
          return galleryDb.selectFrom('app_versions').selectAll().where('id', '=', id).executeTakeFirst() ?? null;
        },
        markInstallationUpdated: (iid, vid) => markInstallationUpdated(galleryDb, iid, vid),
        getPreviousVersion: (lid, vid) => getPreviousVersion(galleryDb, lid, vid),
        applyUpdate,
        rollbackUpdate,
        snapshotAppData,
      };

      const result = await handleRollback(deps, {
        slug,
        userId,
        homePath,
        listingId: body.listingId,
      });

      return c.json(result.body, result.status as any);
    } catch (err) {
      console.error('[gallery] Rollback error:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Rollback failed' }, 500);
    }
  });

  app.post("/api/apps/:slug/icon", async (c) => {
    const slug = c.req.param("slug");
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
      return c.json({ error: "Invalid slug" }, 400);
    }
    const geminiKey = process.env.GEMINI_API_KEY ?? "";
    if (!geminiKey) {
      return c.json({ error: "GEMINI_API_KEY not configured" }, 503);
    }
    try {
      let body: { style?: string } = {};
      try { body = await c.req.json(); } catch { /* no body is fine */ }

      let iconStyle = body.style ?? "";
      if (!iconStyle) {
        try {
          const desktop = JSON.parse(readFileSync(join(homePath, "system/desktop.json"), "utf-8"));
          iconStyle = desktop.iconStyle ?? "";
        } catch { /* ignore */ }
      }
      if (!iconStyle) {
        iconStyle = "Digital neo-classic app icon filling the entire frame edge to edge, dark matte background with subtle luminous grid lines, clean geometric 3D forms, soft phosphor glow accents, rounded square shape, premium minimalist design, no margins or padding";
      }

      const client = createImageClient(geminiKey);
      const name = slug.replace(/-/g, " ").replace(/_/g, " ");
      const prompt = `App icon for '${name}': ${iconStyle}, no text, 1:1 square`;
      const iconsDir = join(homePath, "system/icons");
      const result = await client.generateImage(prompt, {
        aspectRatio: "1:1",
        imageDir: iconsDir,
        saveAs: `${slug}.png`,
      });
      return c.json({ iconUrl: `/files/system/icons/${slug}.png`, cost: result.cost });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`Icon generation failed for "${slug}":`, message);
      return c.json({ error: message }, 500);
    }
  });

  app.post("/api/icons/regenerate-all", async (c) => {
    const geminiKey = process.env.GEMINI_API_KEY ?? "";
    if (!geminiKey) {
      return c.json({ error: "GEMINI_API_KEY not configured" }, 503);
    }

    let iconStyle = "";
    try {
      const desktop = JSON.parse(readFileSync(join(homePath, "system/desktop.json"), "utf-8"));
      iconStyle = desktop.iconStyle ?? "";
    } catch { /* ignore */ }
    if (!iconStyle) {
      iconStyle = "Digital neo-classic icon, dark matte background with subtle luminous grid lines, clean geometric forms, soft phosphor glow accents, rounded square shape, premium minimalist design";
    }

    const iconsDir = join(homePath, "system/icons");
    if (!existsSync(iconsDir)) {
      return c.json({ regenerated: 0, failed: [] });
    }

    const pngFiles = readdirSync(iconsDir).filter((f: string) => f.endsWith(".png"));
    const client = createImageClient(geminiKey);
    let regenerated = 0;
    const failed: string[] = [];

    for (const file of pngFiles) {
      const slug = file.replace(/\.png$/, "");
      const name = slug.replace(/-/g, " ").replace(/_/g, " ");
      const prompt = `App icon for '${name}': ${iconStyle}, no text, 1:1 square`;
      try {
        await client.generateImage(prompt, {
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

    return c.json({ regenerated, failed });
  });

  app.get("/api/cron", (c) => {
    return c.json(cronService.listJobs());
  });

  app.post("/api/cron", async (c) => {
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

  app.post("/api/system/upgrade", async (c) => {
    const handle = process.env.MATRIX_HANDLE;
    const token = process.env.UPGRADE_TOKEN;
    const platformUrl = process.env.PLATFORM_INTERNAL_URL;

    if (!handle || !token || !platformUrl) {
      return c.json({ error: "Upgrade not configured" }, 503);
    }

    try {
      const res = await fetch(`${platformUrl}/containers/${handle}/self-upgrade`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return c.json({ error: (data as Record<string, string>).error ?? "Upgrade failed" }, res.status as 400);
      }

      return c.json({ ok: true });
    } catch {
      // Connection drop likely means the container is being replaced
      return c.json({ ok: true });
    }
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
    } catch {
      return c.json({ total: 0, byAction: {} });
    }
  });

  app.post("/api/push/register", async (c) => {
    const body = await c.req.json<{ token: string; platform: string }>();
    if (!body.token || !body.platform) {
      return c.json({ error: "token and platform are required" }, 400);
    }
    pushAdapter.registerToken(body.token, body.platform);
    return c.json({ ok: true });
  });

  app.delete("/api/push/register", async (c) => {
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

  // T2030-T2037: Social API routes
  const getCurrentUser = () => {
    const identity = loadHandle(homePath);
    return identity.handle || "@me";
  };
  if (appDb && queryEngine) {
    await bootstrapSocialSchema(appDb);
    const socialRoutes = createSocialRoutes(appDb, queryEngine, getCurrentUser);
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
  }));

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
      await hookRunner.fireVoidHook("gateway_stop", {}).catch(() => {});

      // T945: Stop services in reverse order
      const services = pluginRegistry.getServices();
      for (let i = services.length - 1; i >= 0; i--) {
        try { await services[i].stop(); } catch { /* ignore */ }
      }

      heartbeat.stop();
      watchdog.stop();
      proactiveHeartbeat.stop();
      cronService.stop();
      await channelManager.stop();
      await sessionRegistry.shutdown();
      await watcher.close();
      await appDb?.destroy();
      server.close();
    },
  };
}
