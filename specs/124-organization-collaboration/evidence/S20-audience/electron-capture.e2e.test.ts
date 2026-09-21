// S20 T101 evidence capture for Electron Desktop (spec 124). Not a regression test:
// it drives the BUILT desktop app (desktop/out) against the desktop e2e stub gateway
// and saves PNGs. Run it from tests/e2e/desktop/ (copy it there) under Xvfb:
//   bun run build:desktop
//   cp specs/124-organization-collaboration/evidence/S20-audience/{electron-capture.e2e.test.ts,renderer-asset.ts,capture-safety.ts} tests/e2e/desktop/
//   S20_SHOT_MODE=no-org S20_SHOT_OUT=/tmp/s20 xvfb-run --auto-servernum --server-args="-screen 0 1440x900x24" \
//     pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/desktop/electron-capture.e2e.test.ts
//   S20_SHOT_MODE=org ... (same command; patches and restores the built renderer chunk)
// S20_ONLY=terminal|project|chat limits the run to one flow.
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";
import { closeElectronApp } from "./fixtures/close-electron";
import { patchRendererAsset, restoreRendererAsset, type RendererAssetPatch } from "./renderer-asset.js";
import { captureStep, cleanupWithRestore, recordBoundedDiagnostic } from "./capture-safety.js";

const root = resolve(__dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const assets = join(root, "desktop/out/renderer/assets");
const requireDesktop = createRequire(join(root, "desktop/package.json"));
const MODE = process.env.S20_SHOT_MODE === "org" ? "org" : "no-org";
const OUT = process.env.S20_SHOT_OUT ?? join(root, "output/s20-electron");
const ORG_ID = "org_2evidenceDemo";
const MACHINE_ID = "11111111-1111-4111-8111-111111111111";
const RUNTIME_ID = `vps:${MACHINE_ID}`;
const CHAT_ID = "chat_launch_plan";
const CHAT_TITLE = "Launch plan";
const TERMINAL_SCOPE = "20000000-0000-4000-8000-000000000001";
const PROJECT_SCOPE = "20000000-0000-4000-8000-000000000002";
const CHAT_SCOPE = "20000000-0000-4000-8000-000000000003";
const NOW = "2026-09-21T12:00:00.000Z";
const TOKEN = "c".repeat(96);
const HEX = "a".repeat(64);

const scope = (kind: string, id: string, resourceId: string, lifecycle: string) => ({
  id, ownerId: "user-1", organizationId: ORG_ID, kind, resourceId, membershipMode: "direct", lifecycle,
  revision: "1", authEpoch: "1", authorityGeneration: "1", role: "owner",
  capabilities: { read: true, discuss: kind !== "terminal", manageMembers: true, requestAi: false,
    observeTerminal: kind === "terminal", controlTerminal: kind === "terminal", stopTerminal: kind === "terminal" },
});
const members = { members: [
  { actor: { actorId: "user-1", displayName: "Thomas Anderson" }, role: "owner", status: "accepted", revision: "1", joinedAt: NOW, updatedAt: NOW },
  { actor: { actorId: "user_ada", displayName: "Ada Lovelace" }, role: "editor", status: "pending", invitationId: "30000000-0000-4000-8000-000000000001", revision: "1", updatedAt: NOW },
] };
const inventory = {
  scopeId: PROJECT_SCOPE, projectId: "matrix-os", projectRevision: "3", scopeRevision: "1",
  ownedItems: [
    { kind: "file", id: "README.md", revision: "2", compatibility: "ready" },
    { kind: "file", id: "src/index.ts", revision: "5", compatibility: "ready" },
    { kind: "chat", id: CHAT_ID, revision: "4", compatibility: "ready" },
    { kind: "terminal", id: "matrix-task-1", revision: "1", compatibility: "ready" },
  ],
  externalReferences: [{ kind: "chat", id: "chat_design_review", revision: "2" }],
  blockers: [],
  membershipEffects: [{ actor: { actorId: "user_ada", displayName: "Ada Lovelace" }, role: "editor", effect: "join_project" }],
  inventoryHash: HEX, membershipHash: HEX, inventoryToken: TOKEN, expiresAt: "2026-09-21T13:00:00.000Z",
};
const chatRecord = () => ({ chat: {
  id: CHAT_ID, title: CHAT_TITLE, revision: 4, ownerScope: { type: "personal", ownerId: "user-1" },
  lifecycle: "active", attention: "none", messageCount: 0, createdAt: NOW, updatedAt: NOW,
} });

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch (error: unknown) {
    console.warn("[s20] request body is not JSON", error instanceof Error ? error.name : String(error));
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
suite(`S20 Electron Desktop evidence (${MODE})`, () => {
  let app: ElectronApplication;
  let page: Page;
  let base: StubGateway;
  let front: ReturnType<typeof createServer>;
  let profile: string;
  let patched: RendererAssetPatch | null = null;
  const unhandled = new Set<string>();
  let terminalResourceId = "matrix-task-1";

  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    if (MODE === "org") {
      // Simulate an active Clerk organization: the trusted core's auth:status contract is
      // strict and does not carry organizationId yet, so patch the BUILT renderer chunk's
      // readOrganizationId to return a fixed id. No source file is changed; restored after.
      const candidates = readdirSync(assets).filter((name) => name.endsWith(".js"));
      const pattern = /Reflect\.get\(\w+,\s*"organizationId"\)/;
      const hits = candidates.filter((name) => pattern.test(readFileSync(join(assets, name), "utf8")));
      if (hits.length !== 1) throw new Error(`expected one renderer chunk with readOrganizationId, found ${hits.length}: ${hits.join(", ")}`);
      const file = join(assets, hits[0]);
      const source = readFileSync(file, "utf8");
      const matches = source.match(/Reflect\.get\(\w+,\s*"organizationId"\)/g) ?? [];
      if (matches.length !== 1) throw new Error(`expected exactly one Reflect.get(..., "organizationId"), found ${matches.length}`);
      patched = patchRendererAsset(file, source.replace(/Reflect\.get\(\w+,\s*"organizationId"\)/, JSON.stringify(ORG_ID)));
      console.log("[s20] patched", hits[0]);
    }
    base = await startStubGateway();
    const basePort = base.port;
    front = createServer(async (req, res) => {
      const path = new URL(req.url!, base.url).pathname;
      if (req.method === "GET" && path === "/api/chats") return json(res, { items: [chatRecord(),
        { ...chatRecord(), projectId: "matrix-os", chat: { ...chatRecord().chat, id: "chat_matrix_plan", title: "Matrix plan" } }] });
      if (req.method === "GET" && path === "/api/chats/chat_matrix_plan") return json(res, { record: { ...chatRecord(), projectId: "matrix-os", chat: { ...chatRecord().chat, id: "chat_matrix_plan", title: "Matrix plan" } }, messages: [], runs: [], turns: [], activities: [], queuedTurns: [] });
      if (req.method === "GET" && path === `/api/chats/${CHAT_ID}`) return json(res, { record: chatRecord(), messages: [], runs: [], turns: [], activities: [], queuedTurns: [] });
      if (req.method === "GET" && path === "/api/terminal/preferences") return json(res, { preferences: { keyboard: {} } });
      if (path === "/api/system/info") {
        const upstream = await fetchUpstream(base.url, req);
        if (upstream.status !== 200) return json(res, { error: "unauthorized" }, upstream.status);
        const info = JSON.parse(upstream.body) as Record<string, unknown>;
        const runtime = (info.runtime ?? {}) as Record<string, unknown>;
        return json(res, { ...info, runtime: { ...runtime, machineId: MACHINE_ID }, capabilities: { collaboration: true } });
      }
      if (path.startsWith("/api/collaboration/")) {
        if (path === `/api/collaboration/runtimes/${RUNTIME_ID}/scopes/preflight`) return json(res, { eligible: true, resourceRevision: "3", confirmationToken: TOKEN });
        if (path === `/api/collaboration/runtimes/${RUNTIME_ID}/scopes`) {
          const body = await readBody(req);
          const resourceId = typeof body.resourceId === "string" ? body.resourceId : "";
          console.log("[s20] scope create", body.kind, resourceId);
          if (body.kind === "terminal") terminalResourceId = resourceId;
          return json(res, body.kind === "terminal" ? scope("terminal", TERMINAL_SCOPE, resourceId, "shared")
            : body.kind === "chat" ? scope("chat", CHAT_SCOPE, resourceId, "shared")
            : scope("project", PROJECT_SCOPE, resourceId, "private"));
        }
        if (path === `/api/collaboration/scopes/${TERMINAL_SCOPE}`) return json(res, scope("terminal", TERMINAL_SCOPE, terminalResourceId, "shared"));
        if (path === `/api/collaboration/scopes/${CHAT_SCOPE}`) return json(res, scope("chat", CHAT_SCOPE, CHAT_ID, "shared"));
        if (path === `/api/collaboration/scopes/${PROJECT_SCOPE}`) return json(res, scope("project", PROJECT_SCOPE, "matrix-os", "private"));
        if (path.endsWith("/members")) return json(res, members);
        if (path === `/api/collaboration/scopes/${PROJECT_SCOPE}/project/inventory`) return json(res, inventory);
        if (path === "/api/collaboration/inbox" || path === "/api/collaboration/shared") return json(res, { items: [] });
        recordBoundedDiagnostic(unhandled, `${req.method} ${path}`);
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
    profile = mkdtempSync(join(tmpdir(), "s20-electron-"));
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
    await cleanupWithRestore(async () => {
      if (app) await closeElectronApp(app).catch((error: unknown) => console.log("close failed", error instanceof Error ? error.message : String(error)));
      front?.closeAllConnections();
      if (front) await new Promise<void>((done) => front.close(() => done()));
      await base?.close();
      if (profile) rmSync(profile, { recursive: true, force: true });
      console.log("[s20] unhandled collaboration calls:", [...unhandled].join(", ") || "none");
    }, () => {
      if (patched) { restoreRendererAsset(patched); console.log("[s20] restored renderer chunk"); }
    });
  });

  async function shot(name: string): Promise<void> {
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log("[s20] saved", name);
  }
  async function dismissGettingStarted(): Promise<void> {
    const dialog = page.getByRole("dialog", { name: "Getting started", exact: true });
    if (await dialog.isVisible().catch(() => false)) {
      await page.getByRole("button", { name: /Getting started/ }).first().click();
      await dialog.waitFor({ state: "hidden" }).catch((error: unknown) => console.warn("[s20] best-effort step failed", error instanceof Error ? error.name : String(error)));
    }
  }
  async function step(name: string, run: () => Promise<void>): Promise<void> {
    if (process.env.S20_ONLY && process.env.S20_ONLY !== name) return;
    await captureStep(name, run, async (_name, error) => {
      console.log(`[s20] FAILED ${name}:`, error instanceof Error ? error.message.split("\n")[0] : String(error));
      await page.screenshot({ path: join(OUT, `failure-${MODE}-${name}.png`) }).catch((error: unknown) => console.warn("[s20] best-effort step failed", error instanceof Error ? error.name : String(error)));
      await page.keyboard.press("Escape").catch((error: unknown) => console.warn("[s20] best-effort step failed", error instanceof Error ? error.name : String(error)));
    }, name === "project");
  }

  it("captures terminal, project, and Chat share controls", async () => {
    await page.getByRole("button", { name: "Terminal", exact: true }).first().waitFor({ timeout: 30_000 });
    await dismissGettingStarted();

    await step("terminal", async () => {
      await page.getByRole("button", { name: "Terminal", exact: true }).first().click();
      const share = page.getByRole("button", { name: "Share terminal" }).first();
      try { await share.waitFor({ timeout: 8_000 }); } catch (error: unknown) {
        console.log("[s20] terminal share button not visible after click; opening the Terminal window", error instanceof Error ? error.name : String(error));
        await page.getByRole("button", { name: "Terminal", exact: true }).first().dblclick();
        await share.waitFor({ timeout: 20_000 });
      }
      await dismissGettingStarted();
      console.log("[s20] terminal button:", JSON.stringify(await share.textContent()), "disabled:", await share.isDisabled());
      await page.getByText("could not be loaded").first().waitFor({ state: "hidden", timeout: 15_000 }).catch((error: unknown) => console.warn("[s20] best-effort step failed", error instanceof Error ? error.name : String(error)));
      await shot(`electron-desktop-${MODE}-terminal-share-button`);
      await share.click();
      if (MODE === "no-org") {
        await page.getByRole("alert").filter({ hasText: "Terminal sharing is unavailable" }).first().waitFor();
        await shot("electron-desktop-no-org-terminal-share-unavailable");
        return;
      }
      const confirm = page.getByRole("dialog", { name: "Confirm terminal sharing" });
      await confirm.waitFor();
      await shot("electron-desktop-org-terminal-confirm-dialog");
      await confirm.getByRole("button", { name: "Confirm and invite members" }).click();
      const collaborators = page.getByRole("dialog", { name: "Invite collaborators" });
      await collaborators.waitFor();
      await shot("electron-desktop-org-terminal-collaborators-dialog");
      await collaborators.getByRole("button", { name: "Close" }).click();
    });

    await step("project", async () => {
      const share = page.getByRole("button", { name: "Share project" }).first();
      const debug = async (label: string) => console.log("[s20]", label, "share:", await share.count(), "conversations:", await page.locator('[aria-label="Project conversations"]').count(),
        "labels:", JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).filter((l) => l && /project|conversation|share|chats|board|overview/i.test(l)))),
        "slots:", JSON.stringify(await page.evaluate(() => [...new Set([...document.querySelectorAll("[data-slot]")].map((e) => e.getAttribute("data-slot")))])),
        "text:", (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300));
      await page.getByRole("button", { name: "Search", exact: true }).first().click();
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.waitFor();
      await palette.getByPlaceholder("Type a command or search…").fill("Matrix OS");
      await page.waitForTimeout(500);
      console.log("[s20] palette options:", JSON.stringify(await palette.getByRole("option").allInnerTexts()));
      await palette.getByRole("option", { name: "Matrix OS", exact: true }).first().click();
      try { await share.waitFor({ timeout: 10_000 }); } catch (error: unknown) {
        console.log("[s20] project share button not visible after the palette", error instanceof Error ? error.name : String(error));
        await debug("after palette");
        await page.screenshot({ path: join(OUT, `debug-${MODE}-after-palette.png`) });
        await page.getByRole("button", { name: "Chat", exact: true }).first().dblclick();
        const group = page.getByRole("button", { name: "Matrix OS", exact: true }).first();
        await group.waitFor();
        if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
        await page.getByRole("button", { name: "Matrix plan", exact: true }).first().click();
        try { await share.waitFor({ timeout: 15_000 }); } catch (error) { await debug("after rail"); throw error; }
      }
      await dismissGettingStarted();
      console.log("[s20] project button:", JSON.stringify(await share.textContent()), "disabled:", await share.isDisabled());
      if (MODE === "no-org") { await shot("electron-desktop-no-org-project-share-disabled"); return; }
      await shot("electron-desktop-org-project-share-button");
      await share.click();
      const project = page.getByRole("dialog", { name: "Share whole project" });
      await project.waitFor();
      await shot("electron-desktop-org-project-share-dialog");
      await project.getByRole("button", { name: "Manage collaborators" }).click();
      const collaborators = page.getByRole("dialog", { name: "Invite collaborators" });
      await collaborators.waitFor();
      await shot("electron-desktop-org-project-collaborators-dialog");
      await collaborators.getByRole("button", { name: "Close" }).click();
      await project.waitFor();
      await project.getByRole("button", { name: "Cancel" }).click();
    });

    await step("chat", async () => {
      await page.getByRole("button", { name: "Chat", exact: true }).first().dblclick();
      await page.getByRole("button", { name: CHAT_TITLE, exact: true }).first().click();
      await page.getByRole("button", { name: `Rename ${CHAT_TITLE}`, exact: true }).waitFor();
      await dismissGettingStarted();
      const share = page.getByRole("button", { name: "Share", exact: true }).first();
      await share.waitFor();
      await shot(`electron-desktop-${MODE}-chat-share-button`);
      await share.click();
      const choice = page.getByRole("dialog", { name: "Share Chat" });
      await choice.waitFor();
      console.log("[s20] chat choice invite buttons:", await choice.getByRole("button", { name: "Invite collaborators" }).count());
      await shot(`electron-desktop-${MODE}-chat-share-choice-dialog`);
      if (MODE === "no-org") { await choice.getByRole("button", { name: "Close" }).click(); return; }
      await choice.getByRole("button", { name: "Invite collaborators" }).click();
      const collaborators = page.getByRole("dialog", { name: "Invite collaborators" });
      await collaborators.waitFor();
      await shot("electron-desktop-org-chat-collaborators-dialog");
      await collaborators.getByRole("button", { name: "Close" }).click();
    });
  }, 300_000);
});
