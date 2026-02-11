import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { createDispatcher, type Dispatcher } from "./dispatcher.js";
import { createWatcher, type Watcher } from "./watcher.js";
import { createPtyHandler, type PtyMessage } from "./pty.js";
import type { KernelEvent } from "@matrix-os/kernel";
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
  const { homePath, port = 4000 } = config;

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const dispatcher: Dispatcher = createDispatcher({
    homePath,
    model: config.model,
    maxTurns: config.maxTurns,
  });

  const watcher: Watcher = createWatcher(homePath);

  const clients = new Set<WSContext>();

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
    upgradeWebSocket(() => ({
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
          dispatcher
            .dispatch(parsed.text, parsed.sessionId, (event) => {
              send(ws, kernelEventToServerMessage(event));
            })
            .catch((err: Error) => {
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
    })),
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
    const fullPath = join(homePath, filePath);

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

  app.get("/health", (c) => c.json({ status: "ok" }));

  const server = serve({ fetch: app.fetch, port });
  injectWebSocket(server);

  return {
    app,
    server,
    dispatcher,
    watcher,
    async close() {
      await watcher.close();
      server.close();
    },
  };
}
