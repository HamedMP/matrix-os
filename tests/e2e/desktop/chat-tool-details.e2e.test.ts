import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { createCanonicalChatFixture } from "../../contracts/fixtures/canonical-chat";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";
import { closeElectronApp } from "./fixtures/close-electron";

const root = resolve(__dirname, "../../..");
const built = existsSync(join(root, "desktop/out/main/index.js"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !built) throw new Error("Required Desktop build missing");
const suite = built ? describe : describe.skip;
const fixture = createCanonicalChatFixture("completed").snapshot;
const run = fixture.runs[0]!;
const record = { chat: { id: fixture.chat.id, title: "Tool details review", ownerScope: { type: "personal", ownerId: "user-1" },
  lifecycle: "active", attention: "none", revision: 1, messageCount: 2, createdAt: run.createdAt, updatedAt: run.createdAt } };
const command = `bun run test ${"tests/regression.test.ts ".repeat(8)}`.trim();
const detail = { record, turns: fixture.turns, runs: fixture.runs, queuedTurns: [], messages: [
  ...fixture.messages,
  { id: "msg_tool_final", chatId: fixture.chat.id, runId: run.id, turnId: run.turnId, seq: 2, role: "assistant", state: "committed", parts: [{ type: "text", text: "The command finished successfully." }], createdAt: run.createdAt },
], activities: [
  { id: "activity_tool", chatId: fixture.chat.id, runId: run.id, occurredAt: run.createdAt, type: "agent.activity", activityId: "tool_command", kind: "command", label: "Run command", status: "completed", preview: command, previewKind: "command", detail: "Working directory: projects/demo" },
  { id: "activity_result", chatId: fixture.chat.id, runId: run.id, occurredAt: run.createdAt, type: "tool.output", toolCallId: "tool_command", text: "12 tests passed", truncated: false },
] };
let app: ElectronApplication, page: Page, base: StubGateway, profile: string;
const server = createServer((req, res) => {
  const path = new URL(req.url!, "http://localhost").pathname;
  const json = (value: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (path === "/api/chats") return json({ items: [record] });
  if (path === `/api/chats/${fixture.chat.id}`) return json(detail);
  if (path === `/api/chats/${fixture.chat.id}/read-state`) { req.resume(); return json(record); }
  const upstream = request(new URL(req.url!, base.url), { method: req.method, headers: req.headers, timeout: 10_000 }, response => {
    res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("Fixture timeout")));
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
});

suite("tool details in built Electron Desktop", () => {
  beforeAll(async () => {
    base = await startStubGateway();
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    profile = await mkdtemp(join(tmpdir(), "chat-tool-review-"));
    const launch = () => _electron.launch({ executablePath: createRequire(join(root, "desktop/package.json"))("electron") as string,
      args: [resolve(__dirname, "fixtures/canonical-input-electron.mjs")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, OPERATOR_USER_DATA_DIR: profile } });
    app = await launch();
    const encrypted = await app.evaluate(async ({ app, safeStorage }) => {
      await app.whenReady();
      return safeStorage.encryptString(JSON.stringify({ accessToken: "stub-token-1", expiresAt: Date.now() + 3_600_000, userId: "user-1", handle: "neo" })).toString("base64");
    });
    await writeFile(join(profile, "credential.bin"), Buffer.from(encrypted, "base64"));
    await closeElectronApp(app); app = await launch(); page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
  }, 60_000);
  afterAll(async () => {
    if (page && !page.isClosed()) { await mkdir(join(root, "output/chat-tool-details"), { recursive: true }); await page.screenshot({ path: join(root, "output/chat-tool-details/last-state.png") }); }
    if (app) await closeElectronApp(app);
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    await base?.close(); if (profile) await rm(profile, { recursive: true, force: true });
  });
  it("expands command and result after loading and reloading the canonical Chat", async () => {
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      await page.getByRole("button", { name: "Chat", exact: true }).first().dblclick();
      await page.getByRole("button", { name: "Tool details review", exact: true }).click();
      const worked = page.getByRole("button", { name: /Worked for/ });
      await worked.waitFor();
      if (await worked.getAttribute("aria-expanded") !== "true") await worked.click();
      await page.getByRole("button", { name: `Run command: ${command}`, exact: true }).click();
      await page.getByText("12 tests passed", { exact: false }).waitFor();
      expect(await page.getByText("Working directory: projects/demo", { exact: false }).count()).toBeGreaterThan(0);
    }
    if (await page.getByRole("dialog", { name: "Getting started", exact: true }).isVisible()) await page.getByRole("button", { name: /Getting started/ }).click();
    const output = join(root, "output/chat-tool-details"); await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, "electron-tool-details.png") });
  });
});
