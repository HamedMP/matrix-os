import { app, BrowserWindow, ipcMain } from "electron";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CanonicalProviderCatalogSchema } from "../../../packages/contracts/src/index";
import { createLocalStore } from "../../../desktop/src/main/persistence/local-store";
import { INVOKE_CHANNELS } from "../../../desktop/src/shared/ipc-contract";

// Only the catalog boundary is synthetic. Production preload, validated disk
// preferences, selection hook and picker run unchanged in the real Electron app.
const profile = process.env.MATRIX_MODEL_READINESS_FIXTURE_DATA!;
app.setPath("userData", profile);
const ids = ["claude-sonnet-5", "cloudflare:@cf/zai-org/glm-5.3-flash"];
function catalog(readyModel: string | null) {
  return CanonicalProviderCatalogSchema.parse({
    revision: `readiness-${readyModel === ids[0] ? "sonnet" : readyModel ? "glm" : "outage"}`,
    drivers: [{ kind: "matrix_pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "system_agent" }],
    instances: [{
      id: "matrix_pi_default", driverKind: "matrix_pi", displayName: "Matrix AI", connectionLabel: "Matrix AI",
      availability: readyModel ? "available" : "unavailable", connectionState: readyModel ? "ready" : "unavailable",
      ...(!readyModel ? { unavailabilityReason: "runtime_unavailable" } : {}),
      workspaceRequirement: "project_optional", catalogRevision: `readiness-${readyModel === ids[0] ? "sonnet" : readyModel ? "glm" : "outage"}`,
      models: ids.map((id, index) => ({ id, displayName: index ? "GLM 5.3 Flash" : "Claude Sonnet 5",
        availability: id === readyModel ? "available" : "unavailable", capabilities: ["reasoning", "tools"], supportsVision: false, supportsToolUse: true })),
      options: [], skills: [], commands: [], setupActions: [{ id: "settings", kind: "open_settings", label: "Agents & providers" }],
      supports: { rootChat: true, resume: false, cancellation: true, steering: "same_run", attachments: ["file", "image"], tools: [], approvals: true,
        userInput: false, worktrees: "optional", resources: [], interactionModes: ["default"], permissionModes: ["supervised", "full_access"] },
      ...(readyModel ? { defaultSelection: { instanceId: "matrix_pi_default", model: readyModel } } : {}),
    }],
  });
}
app.whenReady().then(async () => {
  const store = createLocalStore({ dir: join(profile, "local-state") });
  for (const channel of ["state:get", "state:set"] as const) ipcMain.handle(channel, async (_event, payload: unknown) => {
    const input = INVOKE_CHANNELS[channel].request.parse(payload);
    if (input.key !== "providerPreferences") throw new Error("Fixture only exposes provider preferences");
    if (channel === "state:get") return { value: await store.get("providerPreferences") };
    await store.setUnknown("providerPreferences", (input as { value: unknown }).value);
    return { ok: true };
  });
  let readyModel: string | null = null;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/shell.js" || url.pathname === "/shell.css") {
        res.setHeader("content-type", url.pathname.endsWith(".css") ? "text/css" : "text/javascript");
        res.end(await readFile(join(__dirname, url.pathname.slice(1)))); return;
      }
      if (url.pathname === "/") {
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html><head><meta charset="utf-8"><title>Matrix AI model readiness · isolated Electron acceptance</title><link rel="stylesheet" href="/shell.css"></head><body><div id="root"></div><script src="/shell.js"></script></body></html>'); return;
      }
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/catalog" && req.method === "GET") { res.end(JSON.stringify(catalog(readyModel))); return; }
      if (url.pathname === "/fixture/readiness" && req.method === "POST") {
        const value = url.searchParams.get("model");
        if (value !== "outage" && !ids.includes(value ?? "")) { res.writeHead(400); res.end("{}"); return; }
        readyModel = value === "outage" ? null : value;
        res.end(JSON.stringify(catalog(readyModel))); return;
      }
      if (url.pathname === "/evidence") { res.end(JSON.stringify({ catalog: catalog(readyModel), preferences: await store.get("providerPreferences") })); return; }
      res.writeHead(404); res.end("{}");
    } catch (error) {
      console.error("Readiness fixture request failed", error instanceof Error ? error.name : typeof error);
      if (!res.headersSent) res.writeHead(500);
      res.end("{}");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const window = new BrowserWindow({ width: 1080, height: 780, show: true,
    webPreferences: { preload: join(__dirname, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  app.on("before-quit", () => { server.close(); server.closeAllConnections(); });
  await window.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
}).catch(error => { console.error("Readiness fixture startup failed", error); app.exit(1); });
app.on("window-all-closed", () => app.quit());
