import { app, BrowserWindow, ipcMain } from "electron";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { NativeAppBridge, createNativeAppAiRequester } from "../../../desktop/src/main/embeds/native-app-bridge";

// Synthetic runtime, real sandboxed preload/main/shell IPC and kernel socket.
// No customer credentials or paid inference are used by this fixture.
app.setPath("userData", process.env.APP_AI_FIXTURE_DATA!);
app.whenReady().then(async () => {
  const frames: unknown[] = [];
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/shell.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(join(__dirname, "shell.js"))); }
    else if (req.url === "/shell") { res.setHeader("content-type", "text/html"); res.end('<script src="/shell.js"></script>'); }
    else if (req.url === "/evidence") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ frames, requests })); }
    else if (req.url === "/api/bridge/ai") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { requests.push(JSON.parse(body)); res.setHeader("content-type", "application/json"); res.end('{"text":"synthetic completion"}'); });
    } else { res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>App fixture</title>"); }
  });
  const ws = new WebSocketServer({ server });
  ws.on("connection", (socket) => socket.on("message", (data) => frames.push(JSON.parse(data.toString()))));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const preload = join(__dirname, "preload.cjs");
  const shell = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  ipcMain.handle("badge:set", () => ({ ok: true }));
  const bridge = new NativeAppBridge({ authGeneration: () => 0,
    gatewayOrigin: () => origin,
    generate: (app, context) => shell.webContents.send("app:generate", { app, context, runtimeSlot: "primary", authGeneration: 1 }),
    aiRequest: createNativeAppAiRequester({ getGatewayOrigin: () => origin, getToken: () => "synthetic" }),
    request: async () => { throw new Error("not used"); },
    gatewayRequest: async () => { throw new Error("not used"); },
  });
  bridge.registerIpc(ipcMain);
  await shell.loadURL(`${origin}/shell`);
  const view = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ["--matrix-app-bridge"] } });
  bridge.register(view.webContents.id, "owner/brain", "brain");
  await view.loadURL(`${origin}/apps/brain/`);
  app.on("before-quit", () => { bridge.clear(); ws.close(); server.close(); });
}).catch((error) => { console.error(error); app.exit(1); });
app.on("window-all-closed", () => app.quit());
