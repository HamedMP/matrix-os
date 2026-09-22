// S06 (#1806) evidence capture for Electron Desktop (spec 124). Not a regression test:
// it drives the BUILT desktop app (desktop/out) against the desktop e2e stub gateway and
// saves PNGs of the "Shared with me" page with metadata-only discovery items.
// Run it from tests/e2e/desktop/ (copy it there) under Xvfb:
//   NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter desktop build
//   cp specs/124-organization-collaboration/evidence/S06-direct-client/electron-capture.e2e.test.ts tests/e2e/desktop/
//   S06_SCENARIO=org-pending S06_SHOT_OUT=/tmp/s06 xvfb-run --auto-servernum --server-args="-screen 0 1440x900x24" \
//     pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/desktop/electron-capture.e2e.test.ts
// S06_SCENARIO is one of org-pending | offline | denied | all.
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";
import { closeElectronApp } from "./fixtures/close-electron";

const root = resolve(__dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const requireDesktop = createRequire(join(root, "desktop/package.json"));
const SCENARIOS = ["org-pending", "offline", "denied", "all"] as const;
type Scenario = (typeof SCENARIOS)[number];
const SCENARIO: Scenario = (SCENARIOS as readonly string[]).includes(process.env.S06_SCENARIO ?? "") ? process.env.S06_SCENARIO as Scenario : "all";
const OUT = process.env.S06_SHOT_OUT ?? join(root, "output/s06-electron");
const ORG_ID = "org_2evidenceDemo";
const MACHINE_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_RUNTIME = "vps:22222222-2222-4222-8222-222222222222";
const OFFLINE_SCOPE = "40000000-0000-4000-8000-000000000001";
const DENIED_SCOPE = "40000000-0000-4000-8000-000000000002";
const ORG_SCOPE = "40000000-0000-4000-8000-000000000003";
const ORG_CHAT_SCOPE = "40000000-0000-4000-8000-000000000004";
const OFFLINE_INVITE_SCOPE = "40000000-0000-4000-8000-000000000005";

// Metadata-only discovery items exactly as the platform now serves them (no `resource`).
const base = (scopeId: string, kind: string) => ({ scopeId, runtimeId: OWNER_RUNTIME, ownerId: "user_trinity", kind, authorityGeneration: 1 });
const ITEMS: Record<Scenario, Array<Record<string, unknown>>> = {
  // Accepted share and invitation whose home answers 503 on ticket issuance -> client marks home: "offline".
  offline: [
    { ...base(OFFLINE_SCOPE, "chat"), status: "accepted", organizationId: ORG_ID },
    { ...base(OFFLINE_INVITE_SCOPE, "project"), status: "invited", invitationId: "50000000-0000-4000-8000-000000000001", organizationId: ORG_ID },
  ],
  // Accepted share whose home answers 403 on ticket issuance -> client marks home: "denied".
  denied: [{ ...base(DENIED_SCOPE, "terminal"), status: "accepted", organizationId: ORG_ID }],
  // Organization-wide shares this member has not opened yet -> rendered without hydration.
  "org-pending": [
    { ...base(ORG_SCOPE, "project"), status: "organization_pending", organizationId: ORG_ID },
    { ...base(ORG_CHAT_SCOPE, "chat"), status: "organization_pending", organizationId: ORG_ID },
  ],
  all: [],
};
ITEMS.all = [...ITEMS["org-pending"], ...ITEMS.offline, ...ITEMS.denied];
const CONNECTION_STATUS: Record<string, number> = { [OFFLINE_SCOPE]: 503, [OFFLINE_INVITE_SCOPE]: 503, [DENIED_SCOPE]: 403 };
const EXPECTED_TEXT: Record<Scenario, string> = {
  offline: "The owner's computer is offline. Try again later.",
  denied: "Access is no longer available.",
  "org-pending": "Shared with your organization",
  all: "Shared with your organization",
};

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch (error: unknown) {
    console.warn("[s06] request body is not JSON", error instanceof Error ? error.name : String(error));
    return {};
  }
}
function fetchUpstream(base: string, req: IncomingMessage): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const upstream = httpRequest(new URL(req.url!, base), { method: "GET", headers: req.headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => done({ status: response.statusCode ?? 502, body: Buffer.concat(chunks).toString() }));
    });
    upstream.on("error", fail);
    upstream.end();
  });
}

const suite = existsSync(main) ? describe : describe.skip;
suite(`S06 Electron Desktop evidence (${SCENARIO})`, () => {
  let app: ElectronApplication;
  let page: Page;
  let base: StubGateway;
  let front: ReturnType<typeof createServer>;
  let profile: string;
  const unhandled = new Set<string>();
  const connectionCalls: string[] = [];

  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    base = await startStubGateway();
    const basePort = base.port;
    front = createServer(async (req, res) => {
      const path = new URL(req.url!, base.url).pathname;
      if (path === "/api/system/info") {
        const upstream = await fetchUpstream(base.url, req);
        if (upstream.status !== 200) return json(res, { error: "unauthorized" }, upstream.status);
        const info = JSON.parse(upstream.body) as Record<string, unknown>;
        const runtime = (info.runtime ?? {}) as Record<string, unknown>;
        return json(res, { ...info, runtime: { ...runtime, machineId: MACHINE_ID }, capabilities: { collaboration: true } });
      }
      if (path.startsWith("/api/collaboration/")) {
        // Platform discovery: metadata only. The direct client then asks the platform for a ticket per
        // scope; 503 means the home is unreachable (offline card), 403 means denied (access card).
        if (path === "/api/collaboration/inbox") return json(res, { items: [] });
        if (path === "/api/collaboration/shared") return json(res, { items: ITEMS[SCENARIO] });
        if (path === "/api/collaboration/connections" && req.method === "POST") {
          const body = await readBody(req);
          const scopeId = typeof body.scopeId === "string" ? body.scopeId : "";
          connectionCalls.push(`${scopeId}:${String(body.purpose)}`);
          const status = CONNECTION_STATUS[scopeId] ?? 503;
          return json(res, { error: status === 403 ? "forbidden" : "host_offline" }, status);
        }
        unhandled.add(`${req.method} ${path}`);
        return json(res, { error: "not_found" }, 404);
      }
      const upstream = httpRequest(new URL(req.url!, base.url), { method: req.method, headers: req.headers }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      upstream.setTimeout(10_000, () => upstream.destroy(new Error("fixture timeout")));
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    front.on("upgrade", (req, socket, head) => {
      const upstream = connect(basePort, "127.0.0.1", () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    await new Promise<void>((done) => front.listen(0, "127.0.0.1", done));
    const platformUrl = `http://127.0.0.1:${(front.address() as { port: number }).port}`;
    profile = mkdtempSync(join(tmpdir(), "s06-electron-"));
    const launch = () => _electron.launch({
      executablePath: requireDesktop("electron") as string,
      args: [resolve(__dirname, "fixtures/canonical-input-electron.mjs")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: platformUrl, OPERATOR_USER_DATA_DIR: profile },
    });
    app = await launch();
    const encrypted = await app.evaluate(async ({ app: electronApp, safeStorage }) => {
      await electronApp.whenReady();
      return Array.from(safeStorage.encryptString(JSON.stringify({ accessToken: "stub-token-1", expiresAt: Date.now() + 3_600_000, userId: "user-1", handle: "neo" })));
    });
    writeFileSync(join(profile, "credential.bin"), Buffer.from(encrypted));
    await closeElectronApp(app);
    app = await launch();
    page = await app.firstWindow();
    page.setDefaultTimeout(20_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    page.on("console", (message) => { if (message.type() === "warning" || message.type() === "error") console.log("[renderer]", message.text().slice(0, 200)); });
  }, 120_000);

  afterAll(async () => {
    if (app) await closeElectronApp(app).catch((error: unknown) => console.log("close failed", error instanceof Error ? error.message : String(error)));
    front?.closeAllConnections();
    if (front) await new Promise<void>((done) => front.close(() => done()));
    await base?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
    console.log("[s06] connection calls:", connectionCalls.join(", ") || "none");
    console.log("[s06] unhandled collaboration calls:", [...unhandled].join(", ") || "none");
  });

  async function shot(name: string): Promise<void> {
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log("[s06] saved", name);
  }
  async function dismissGettingStarted(): Promise<void> {
    const dialog = page.getByRole("dialog", { name: "Getting started", exact: true });
    if (await dialog.isVisible().catch(() => false)) {
      await page.getByRole("button", { name: /Getting started/ }).first().click();
      await dialog.waitFor({ state: "hidden" }).catch((error: unknown) => console.warn("[s06] best-effort step failed", error instanceof Error ? error.name : String(error)));
    }
  }

  it("captures the Shared with me page", async () => {
    await page.getByRole("button", { name: "Chat", exact: true }).first().waitFor({ timeout: 30_000 });
    await dismissGettingStarted();
    try {
      await page.getByRole("button", { name: "Chat", exact: true }).first().dblclick();
      const shared = page.getByRole("button", { name: "Shared with me" }).first();
      await shared.waitFor({ timeout: 20_000 });
      await dismissGettingStarted();
      await shared.click();
      await page.getByRole("heading", { name: "Shared with me" }).first().waitFor({ timeout: 20_000 });
      await page.getByText(EXPECTED_TEXT[SCENARIO]).first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1000);
      await dismissGettingStarted();
      const text = (await page.locator("main").filter({ hasText: "Shared with me" }).first().innerText().catch(() => "")).replace(/\s+/g, " ");
      console.log("[s06] cards:", text.slice(0, 400));
      await shot(`electron-desktop-${SCENARIO}`);
    } catch (error: unknown) {
      console.log("[s06] FAILED:", error instanceof Error ? error.message.split("\n")[0] : String(error));
      await page.screenshot({ path: join(OUT, `failure-${SCENARIO}.png`) }).catch((failure: unknown) => console.warn("[s06] screenshot failed", failure instanceof Error ? failure.name : String(failure)));
      console.log("[s06] body:", (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400));
      throw error;
    }
  }, 180_000);
});
