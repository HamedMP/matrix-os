import { createServer, request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { CanonicalChatDetailResponseSchema, CanonicalChatListResponseSchema } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../../contracts/fixtures/canonical-chat";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";
import { closeElectronApp } from "./fixtures/close-electron";

const root = resolve(import.meta.dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const evidence = join(root, "docs/pr-evidence/536/l11");
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
const suite = existsSync(main) ? describe : describe.skip;
const at = "2026-09-28T12:00:00.000Z";
const botId = "bot_research1";
const { snapshot, providerCatalog } = createCanonicalChatFixture("completed");
snapshot.chat.title = "Research Rabbit";
const { project: _project, activeRun: _activeRun, providerBinding, ...chat } = snapshot.chat;
const record = { chat, providerBinding };
const detail = { record, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities };
CanonicalChatListResponseSchema.parse({ items: [record] });
CanonicalChatDetailResponseSchema.parse(detail);
const interaction = { interactionId: "in_abcdefgh", chatId: chat.id, agentId: botId,
  taskId: "task_abcdefgh", kind: "question", blocking: true, status: "pending",
  expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
  payload: { kind: "question", questions: [{ questionId: "target", header: "Target",
    question: "Which company should I watch?", allowOther: true, secret: false }] } };
const authority = { agentId: botId, revision: 1,
  grants: [{ grantId: "gr_abcdefgh", service: "gmail", accountLabel: "Work",
    effects: ["read"], audience: "direct", expiresAt: null }],
  connections: [{ service: "gmail", state: "granted" }], routines: [], pendingInteractions: [],
  memory: { items: [{ itemId: "mem_abcdefgh", kind: "preference", scope: "bot",
    content: "Keep briefs concise", source: { at }, confirmed: true, revision: 1 }] } };

suite("Electron Desktop bot visual evidence", () => {
  let app: ElectronApplication;
  let page: Page;
  let gateway: StubGateway;
  let profile: string;
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (path === "/api/chats/events") { res.writeHead(503); res.end(); return; }
    if (path === "/api/chats") { json({ items: [record] }); return; }
    if (path === `/api/chats/${chat.id}`) { json(detail); return; }
    if (path === "/api/chat-providers") { json(providerCatalog); return; }
    if (path === `/api/chats/${chat.id}/bot`) { json({ agentId: botId }); return; }
    if (path === `/api/chats/${chat.id}/interactions`) { json({ interactions: [interaction] }); return; }
    if (path === `/api/chats/${chat.id}/bot-tasks`) { json({ tasks: [{ taskId: "task_abcdefgh",
      chatId: chat.id, agentId: botId, status: "waiting_person", revision: 1, updatedAt: at }] }); return; }
    if (path === `/api/chat-agents/${botId}/authority`) { json(authority); return; }
    if (path === "/api/chat-agents") { json({ enabled: true, agents: [{ id: botId,
      name: "Research Rabbit", description: "Watch competitors", instructions: "Research carefully.",
      selection: { instanceId: "matrix_bot", model: "default" }, revision: 1, archived: false,
      createdAt: at, updatedAt: at }] }); return; }
    const upstream = httpRequest(new URL(req.url!, gateway.url), { method: req.method, headers: req.headers,
      timeout: 10_000 }, response => { res.writeHead(response.statusCode!, response.headers); response.pipe(res); });
    upstream.on("timeout", () => upstream.destroy(new Error("Fixture timeout")));
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });

  beforeAll(async () => {
    gateway = await startStubGateway();
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    profile = mkdtempSync(join(tmpdir(), "matrix-bot-electron-"));
    const launch = () => _electron.launch({ executablePath,
      args: [resolve(import.meta.dirname, "fixtures/canonical-input-electron.mjs")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: url, OPERATOR_USER_DATA_DIR: profile } });
    app = await launch();
    const encrypted = await app.evaluate(async ({ app: electron, safeStorage }) => {
      await electron.whenReady();
      return Array.from(safeStorage.encryptString(JSON.stringify({ accessToken: "stub-token-1",
        expiresAt: Date.now() + 3_600_000, userId: "user-1", handle: "neo" })));
    });
    writeFileSync(join(profile, "credential.bin"), Buffer.from(encrypted));
    await closeElectronApp(app);
    app = await launch();
    page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    mkdirSync(evidence, { recursive: true });
  }, 60_000);
  afterAll(async () => {
    if (app) await closeElectronApp(app);
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await gateway?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  it("captures the bot question and authority in the built Electron app", async () => {
    await page.getByRole("button", { name: "Chat", exact: true }).dblclick();
    await page.getByRole("button", { name: "Research Rabbit", exact: true }).click();
    const gettingStarted = page.getByRole("dialog", { name: "Getting started", exact: true });
    if (await gettingStarted.isVisible()) {
      await page.getByRole("button", { name: /Getting started/ }).click();
      await gettingStarted.waitFor({ state: "hidden" });
    }
    await page.getByText("Which company should I watch?").waitFor();
    expect(await page.getByRole("button", { name: "Bot settings" }).isVisible()).toBe(true);
    await page.screenshot({ path: join(evidence, "electron-desktop-question.png") });
    await page.getByRole("button", { name: "Bot settings" }).click();
    await page.getByRole("button", { name: /Memory/ }).click();
    await page.getByText("Keep briefs concise").waitFor();
    await page.getByText("Keep briefs concise").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, "electron-desktop-authority-memory.png") });
  }, 60_000);
});
