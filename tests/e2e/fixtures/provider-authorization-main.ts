import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Synthetic provider responses; real Electron sandbox/preload, shared UI and HTTP transport.
// No login, credential import, paid inference or customer account is used.
app.setPath("userData", process.env.PROVIDER_AUTH_FIXTURE_DATA!);
const subscription = { id: "anthropic_terminal", providerId: "anthropic", authKind: "subscription", method: "terminal", billingKind: "subscription", executionKind: "native", availability: "available" };
const key = { id: "anthropic_api_key", providerId: "anthropic", authKind: "api_key", billingKind: "api_key", executionKind: "native", availability: "available" };
const unavailable = { ...key, id: "openrouter_api_key", providerId: "openrouter", availability: "unavailable", unavailableReason: "unsupported_runtime" };
const capability = { harnessInstanceId: "claude", harness: "claude", displayName: "Claude Code", installState: "installed", loginMethods: ["terminal"], apiKeyProviders: ["anthropic"], install: false, uninstall: false, logs: false, connectionOptions: [subscription, key, unavailable] };

app.whenReady().then(async () => {
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      const path = req.url ?? "/";
      if (path === "/shell.js") { res.setHeader("content-type", "text/javascript"); res.end(await readFile(join(__dirname, "shell.js"))); return; }
      if (path === "/") { res.setHeader("content-type", "text/html"); res.end('<!doctype html><title>Provider authorization fixture</title><div id="root"></div><script src="/shell.js"></script>'); return; }
      if (path.startsWith("/agents/settings/")) { res.setHeader("content-type", "image/svg+xml"); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>'); return; }
      res.setHeader("content-type", "application/json");
      if (path === "/evidence") { res.end(JSON.stringify({ requests })); return; }
      if (requests.length >= 128) { res.writeHead(429); res.end("{}"); return; }
      let raw = "";
      for await (const chunk of req) { raw += chunk.toString(); if (Buffer.byteLength(raw) > 8192) { res.writeHead(413); res.end("{}"); return; } }
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ method: req.method, path, ...(typeof body.harnessInstanceId === "string" ? { harnessInstanceId: body.harnessInstanceId } : {}), ...(typeof body.optionId === "string" ? { optionId: body.optionId } : {}), ...(typeof body.apiKey === "string" ? { keyLength: body.apiKey.length } : {}) });
      if (path.endsWith("/v2/capabilities") && req.method === "GET") { res.end(JSON.stringify([capability])); return; }
      if (path.endsWith("/v2/keys") && req.method === "POST" && body.optionId === key.id && body.harnessInstanceId === "claude") { res.end('{"verified":true}'); return; }
      if (path.endsWith("/v2/start") && req.method === "POST" && body.optionId === subscription.id && body.harnessInstanceId === "claude") {
        res.end(JSON.stringify({ id: "fixture_login", harnessInstanceId: "claude", kind: "login", state: "running", expiresAt: new Date(Date.now() + 60_000).toISOString(), terminalSessionId: "tws_fixture:tt_fixture", deviceCode: null, authorizationUrl: null, safeFailure: null, connectionOption: subscription })); return;
      }
      res.writeHead(404); res.end("{}");
    } catch (error) {
      console.error("Provider fixture request failed", error instanceof Error ? error.name : typeof error);
      if (!res.headersSent) res.writeHead(500);
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const window = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  app.on("before-quit", () => { server.close(); server.closeAllConnections(); });
  await window.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
}).catch((error) => { console.error("Provider fixture startup failed", error); app.exit(1); });
app.on("window-all-closed", () => app.quit());
