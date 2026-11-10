import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication } from "playwright";
import { expect, it } from "vitest";
import { closeElectronApp } from "./fixtures/close-electron";
import { startStubGateway } from "./fixtures/stub-gateway";

const root = resolve(import.meta.dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !existsSync(main)) {
  throw new Error("Required desktop build is missing");
}

it.skipIf(!existsSync(main))("opens Bots beside Chat in the built Matrix Electron window", async () => {
  const gateway = await startStubGateway();
  const profile = mkdtempSync(join(tmpdir(), "matrix-hosted-bots-e2e-"));
  const runtimeSlot = "pv-1907-3fa91c2e";
  let rosterRequests = 0;
  let app: ElectronApplication | undefined;
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url!, gateway.url);
    function json(body: unknown) {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(body));
    }
    if (incoming.method === "GET" && url.pathname === "/api/auth/computers") {
      json({
        items: [{ handle: runtimeSlot, runtimeSlot, label: "Preview Computer",
          availability: "available", kind: "preview", gatewayPath: "/vm/" + runtimeSlot, capabilities: [] }],
        selectedSlot: runtimeSlot, hasMore: false, limit: 20,
      });
      return;
    }
    if (incoming.method === "GET" && url.searchParams.get("runtime") === runtimeSlot) {
      if (url.pathname === "/api/hosted-bots") {
        rosterRequests++;
        json({ bots: [] });
        return;
      }
      if (url.pathname === "/api/hosted-bots/model") {
        json({ connected: false });
        return;
      }
    }
    const upstream = request(url, {
      method: incoming.method, headers: incoming.headers, timeout: 10_000,
    }, response => {
      outgoing.writeHead(response.statusCode!, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("Fixture gateway timed out")));
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  try {
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
    const launch = () => _electron.launch({
      executablePath: createRequire(join(root, "desktop/package.json"))("electron") as string,
      args: [join(import.meta.dirname, "fixtures/canonical-input-electron.mjs")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: url, OPERATOR_USER_DATA_DIR: profile, MATRIX_DESKTOP_QA_IDENTITY: "isolated" },
    });
    app = await launch();
    const encrypted = await app.evaluate(async ({ app: electron, safeStorage }) => {
      await electron.whenReady();
      return Array.from(safeStorage.encryptString(JSON.stringify({
        accessToken: "stub-token-1", expiresAt: Date.now() + 3_600_000, userId: "user-1", handle: "neo",
      })));
    });
    writeFileSync(join(profile, "credential.bin"), Buffer.from(encrypted));
    writeFileSync(join(profile, "state.json"), JSON.stringify({
      profile: { handle: "neo", userId: "user-1", platformHost: url, runtimeSlot },
    }));
    await closeElectronApp(app);
    app = await launch();

    const page = await app.firstWindow();
    page.setDefaultTimeout(8_000);
    await page.getByRole("button", { name: "Open App Launcher", exact: true }).click();
    const bots = page.getByRole("button", { name: "Bots", exact: true });
    await bots.waitFor();
    expect(await page.getByRole("button", { name: "Chat", exact: true }).count()).toBeGreaterThan(0);
    expect(rosterRequests).toBeGreaterThan(0);
    await bots.click();
    await page.getByRole("button", { name: "New Bot", exact: true }).waitFor();
    expect(app.windows()).toHaveLength(1);
  } finally {
    if (app) await closeElectronApp(app);
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await gateway.close();
    rmSync(profile, { recursive: true, force: true });
  }
}, 60_000);
