import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { createDispatcher, type Dispatcher, type BatchEntry, type DispatchContext } from "./dispatcher.js";
import { createWatcher, type Watcher } from "./watcher.js";
import { createPtyHandler, type PtyMessage } from "./pty.js";
import { createConversationStore, type ConversationStore } from "./conversations.js";
import { resolveWithinHome } from "./path-security.js";
import { createChannelManager, type ChannelManager } from "./channels/manager.js";
import { createOutboundQueue } from "./security/outbound-queue.js";
import { createTelegramAdapter } from "./channels/telegram.js";
import { createPushAdapter } from "./channels/push.js";
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
} from "@matrix-os/kernel";
import { createProvisioner } from "./provisioner.js";
import { authMiddleware } from "./auth.js";
import { securityHeadersMiddleware } from "./security/headers.js";
import { getSystemInfo } from "./system-info.js";
import { createInteractionLogger, type InteractionLogger } from "./logger.js";
import { createApprovalBridge, type ApprovalBridge } from "./approval.js";
import { DEFAULT_APPROVAL_POLICY, type ApprovalPolicy } from "@matrix-os/kernel";
import { listApps } from "./apps.js";
import {
  createPluginRegistry,
  loadAllPlugins,
  createHookRunner,
  type PluginRegistry,
  type HookRunner,
  type LoadedPlugin,
} from "./plugins/index.js";
import { createSettingsRoutes } from "./routes/settings.js";
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
}

type ClientMessage =
  | { type: "message"; text: string; sessionId?: string }
  | { type: "switch_session"; sessionId: string }
  | { type: "approval_response"; id: string; approved: boolean };

export type ServerMessage =
  | { type: "kernel:init"; sessionId: string }
  | { type: "kernel:text"; text: string }
  | { type: "kernel:tool_start"; tool: string }
  | { type: "kernel:tool_end" }
  | { type: "kernel:result"; data: unknown }
  | { type: "kernel:error"; message: string }
  | { type: "file:change"; path: string; event: string }
  | { type: "task:created"; task: { id: string; type: string; status: string; input: string } }
  | { type: "task:updated"; taskId: string; status: string }
  | { type: "provision:start"; appCount: number }
  | { type: "provision:complete"; total: number; succeeded: number; failed: number }
  | { type: "session:switched"; sessionId: string }
  | { type: "approval:request"; id: string; toolName: string; args: unknown; timeout: number };

function kernelEventToServerMessage(event: KernelEvent): ServerMessage {
  switch (event.type) {
    case "init":
      return { type: "kernel:init", sessionId: event.sessionId };
    case "text":
      return { type: "kernel:text", text: event.text };
    case "tool_start":
      return { type: "kernel:tool_start", tool: event.tool };
    case "tool_end":
      return { type: "kernel:tool_end" };
    case "result":
      return { type: "kernel:result", data: event.data };
  }
}

function send(ws: WSContext, msg: ServerMessage) {
  ws.send(JSON.stringify(msg));
}

export async function createGateway(config: GatewayConfig) {
  const { homePath: rawHomePath, port = 4000 } = config;
  const homePath = resolve(rawHomePath);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const dispatcher: Dispatcher = createDispatcher({
    homePath,
    model: config.model,
    maxTurns: config.maxTurns,
  });

  const watcher: Watcher = createWatcher(homePath);
  const conversations: ConversationStore = createConversationStore(homePath);
  const clients = new Set<WSContext>();

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

  const channelSessions = new Map<string, string>();

  const channelManager: ChannelManager = createChannelManager({
    config: channelsConfig,
    adapters: {
      telegram: createTelegramAdapter(),
      push: pushAdapter,
    },
    outboundQueue,
    onMessage: (msg) => {
      const sessionKey = `${msg.source}:${msg.senderId}`;
      const existingSessionId = channelSessions.get(sessionKey);
      let responseText = "";

      dispatcher
        .dispatch(msg.text, existingSessionId, (event) => {
          if (event.type === "init") {
            channelSessions.set(sessionKey, event.sessionId);
            conversations.begin(event.sessionId);
            conversations.addUserMessage(event.sessionId, msg.text);
          } else if (event.type === "text") {
            responseText += event.text;
            const sid = channelSessions.get(sessionKey);
            if (sid) conversations.appendAssistantText(sid, event.text);
          } else if (event.type === "result") {
            const sid = channelSessions.get(sessionKey);
            if (sid) conversations.finalize(sid);
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

  app.use("*", cors());
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

            dispatcher
              .dispatch(parsed.text, parsed.sessionId, (event) => {
                const msg = kernelEventToServerMessage(event);
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
                  conversations.finalize(activeSessionId);
                }
              })
              .catch((err: Error) => {
                if (activeSessionId) {
                  conversations.finalize(activeSessionId);
                }
                send(ws, {
                  type: "kernel:error",
                  message: err.message ?? "Kernel error",
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
    upgradeWebSocket(() => {
      const pty = createPtyHandler(homePath);

      return {
        onOpen(_evt, ws) {
          pty.onSend((msg) => {
            ws.send(JSON.stringify(msg));
          });
          pty.open();
        },

        onMessage(evt, _ws) {
          try {
            const msg = JSON.parse(
              typeof evt.data === "string" ? evt.data : "",
            ) as PtyMessage;
            pty.onMessage(msg);
          } catch {
            // ignore malformed
          }
        },

        onClose() {
          pty.close();
        },
      };
    }),
  );

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
      const buffer = readFileSync(fullPath);
      return c.body(buffer, 200, {
        "Content-Type": imageMimeTypes[ext],
      });
    }

    const content = readFileSync(fullPath, "utf-8");
    return c.body(content, 200, {
      "Content-Type": textMimeTypes[ext] ?? "text/plain",
    });
  });

  app.put("/files/*", async (c) => {
    const filePath = c.req.path.replace("/files/", "");
    const fullPath = resolveWithinHome(homePath, filePath);
    if (!fullPath) return c.text("Invalid path", 403);
    const content = await c.req.text();
    const dir = dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
    return c.json({ ok: true });
  });

  app.post("/api/bridge/data", async (c) => {
    const body = await c.req.json<{
      action: "read" | "write";
      app: string;
      key: string;
      value?: string;
    }>();

    const safeApp = body.app.replace(/[^a-zA-Z0-9_-]/g, "");
    const safeKey = body.key.replace(/[^a-zA-Z0-9_-]/g, "");
    const dataDir = join(homePath, "data", safeApp);
    const filePath = normalize(join(dataDir, `${safeKey}.json`));

    if (!filePath.startsWith(normalize(dataDir))) {
      return c.json({ error: "Path traversal denied" }, 403);
    }

    if (body.action === "read") {
      if (!existsSync(filePath)) return c.json(null);
      const content = readFileSync(filePath, "utf-8");
      return c.json(JSON.parse(content));
    }

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(body.value));
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

  app.post("/api/apps/:slug/icon", async (c) => {
    const slug = c.req.param("slug");
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
      return c.json({ error: "Invalid slug" }, 400);
    }
    const falKey = process.env.FAL_API_KEY ?? "";
    if (!falKey) {
      return c.json({ error: "FAL_API_KEY not configured" }, 503);
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
        iconStyle = "3D rendered glossy icon, dark background, vibrant glowing neon accents, soft lighting, rounded square shape";
      }

      const client = createImageClient(falKey);
      const name = slug.replace(/-/g, " ").replace(/_/g, " ");
      const prompt = `App icon for '${name}': ${iconStyle}, no text, 1:1 square`;
      const iconsDir = join(homePath, "system/icons");
      const result = await client.generateImage(prompt, {
        model: "fal-ai/z-image/turbo",
        size: "square",
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

  app.get("/api/usage", (c) => {
    try {
      const { createUsageTracker } = require("@matrix-os/kernel");
      const tracker = createUsageTracker(homePath);
      const period = (c.req.query("period") ?? "daily") as string;
      const date = c.req.query("date") as string | undefined;
      const month = c.req.query("month") as string | undefined;

      if (period === "monthly") {
        return c.json(tracker.getMonthly(month));
      }
      return c.json(tracker.getDaily(date));
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
      await watcher.close();
      server.close();
    },
  };
}
