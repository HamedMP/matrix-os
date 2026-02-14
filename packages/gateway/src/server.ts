import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { createDispatcher, type Dispatcher } from "./dispatcher.js";
import { createWatcher, type Watcher } from "./watcher.js";
import { createPtyHandler, type PtyMessage } from "./pty.js";
import { createConversationStore, type ConversationStore } from "./conversations.js";
import { resolveWithinHome } from "./path-security.js";
import { createChannelManager, type ChannelManager } from "./channels/manager.js";
import { createTelegramAdapter } from "./channels/telegram.js";
import { formatForChannel } from "./channels/format.js";
import type { ChannelConfig, ChannelId } from "./channels/types.js";
import {
  createHeartbeat,
  backupModule,
  restoreModule,
  checkModuleHealth,
  createWatchdog,
  type Heartbeat,
  type Watchdog,
  type KernelEvent,
} from "@matrix-os/kernel";
import type { WSContext } from "hono/ws";

export interface GatewayConfig {
  homePath: string;
  port?: number;
  model?: string;
  maxTurns?: number;
}

interface ClientMessage {
  type: "message";
  text: string;
  sessionId?: string;
}

type ServerMessage =
  | { type: "kernel:init"; sessionId: string }
  | { type: "kernel:text"; text: string }
  | { type: "kernel:tool_start"; tool: string }
  | { type: "kernel:tool_end" }
  | { type: "kernel:result"; data: unknown }
  | { type: "kernel:error"; message: string }
  | { type: "file:change"; path: string; event: string };

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

export function createGateway(config: GatewayConfig) {
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

  function broadcastError(message: string) {
    const json = JSON.stringify({ type: "kernel:error", message });
    for (const ws of clients) {
      ws.send(json);
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
  } catch { /* no channel config */ }

  const channelManager: ChannelManager = createChannelManager({
    config: channelsConfig,
    adapters: {
      telegram: createTelegramAdapter(),
    },
    onMessage: (msg) => {
      const sessionKey = `${msg.source}:${msg.senderId}`;
      let responseText = "";

      dispatcher
        .dispatch(msg.text, sessionKey, (event) => {
          if (event.type === "init") {
            conversations.begin(event.sessionId);
            conversations.addUserMessage(event.sessionId, msg.text);
          } else if (event.type === "text") {
            responseText += event.text;
            conversations.appendAssistantText(sessionKey, event.text);
          } else if (event.type === "result") {
            conversations.finalize(sessionKey);
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

  channelManager.start();

  watcher.on((change) => {
    const msg: ServerMessage = change;
    const json = JSON.stringify(msg);
    for (const ws of clients) {
      ws.send(json);
    }
  });

  app.use("*", cors());

  app.get(
    "/ws",
    upgradeWebSocket(() => {
      let pendingText: string | undefined;
      let activeSessionId: string | undefined;

      return {
        onOpen(_evt, ws) {
          clients.add(ws);
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
    const body = await c.req.json<{ text: string; sessionId?: string }>();
    const events: KernelEvent[] = [];

    await dispatcher.dispatch(body.text, body.sessionId, (event) => {
      events.push(event);
    });

    return c.json({ events });
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

    const content = readFileSync(fullPath, "utf-8");
    const ext = filePath.split(".").pop();

    const mimeTypes: Record<string, string> = {
      html: "text/html",
      json: "application/json",
      js: "application/javascript",
      css: "text/css",
      md: "text/markdown",
      txt: "text/plain",
    };

    return c.body(content, 200, {
      "Content-Type": mimeTypes[ext ?? ""] ?? "text/plain",
    });
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

  app.get("/api/channels/status", (c) => {
    return c.json(channelManager.status());
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

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
    async close() {
      heartbeat.stop();
      watchdog.stop();
      await channelManager.stop();
      await watcher.close();
      server.close();
    },
  };
}
