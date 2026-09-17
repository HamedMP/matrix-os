import { createServer, request, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";
import { createCanonicalChatFixture } from "../../contracts/fixtures/canonical-chat";
import { closeElectronApp } from "./fixtures/close-electron";

const root = resolve(import.meta.dirname, "../../..");
const hasDesktopBuild = existsSync(join(root, "desktop/out/main/index.js"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !hasDesktopBuild) {
  throw new Error("Required Desktop E2E build is missing");
}
const suite = hasDesktopBuild ? describe : describe.skip;
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
const output = join(root, "output/chat-dock-badge");
const fixture = createCanonicalChatFixture("completed");
const chatId = fixture.snapshot.chat.id;
const manualReview = process.env.CHAT_BADGE_HUMAN_REVIEW === "1";
let unread = true;
let version = 1;
let cursor = 0;
let app: ElectronApplication, page: Page, base: StubGateway, profile: string;
// Test fixture only: capped at four streams, all explicitly drained below.
const streams = new Set<ServerResponse>();
const record = () => ({ chat: {
  id: chatId, title: "Dock badge review", ownerScope: { type: "personal", ownerId: "user-1" },
  lifecycle: "active", attention: "none", revision: 1, messageCount: 1,
  createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z",
}, readState: { unread, markedUnread: false, version, latestIncomingSeq: 1, readThroughSeq: unread ? 0 : 1 } });
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://localhost");
  const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/api/chats/events") {
    if (streams.size >= 4) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"chat.stream.attached"}\n\ndata: {"type":"chat.replay.end"}\n\n');
    streams.add(res); res.on("close", () => streams.delete(res)); return;
  }
  if (url.pathname === "/api/chats") return json({ items: url.searchParams.get("unread") === "true" && !unread ? [] : [record()] });
  if (url.pathname === `/api/chats/${chatId}/read-state` && req.method === "PATCH") {
    req.resume(); unread = false; version += 1;
    json(record());
    for (const stream of streams) stream.write(`data: ${JSON.stringify({ type: "chat.event", event: {
      cursor: ++cursor, revision: 1, chatId, eventType: "chat.user_state_updated", createdAt: new Date().toISOString(),
    } })}\n\n`);
    return;
  }
  if (url.pathname === `/api/chats/${chatId}`) return json({ record: record(), messages: [{
    id: "msg_badge", chatId, turnId: fixture.snapshot.turns[0]!.id, runId: fixture.snapshot.runs[0]!.id, seq: 1, role: "assistant", state: "committed",
    parts: [{ type: "text", text: "Opening this chat clears its unread Dock badge." }], createdAt: "2026-09-16T00:00:00.000Z",
  }], runs: fixture.snapshot.runs, turns: fixture.snapshot.turns, activities: [], queuedTurns: [] });
  const upstream = request(new URL(req.url!, base.url), { method: req.method, headers: req.headers, timeout: 10_000 }, response => {
    res.writeHead(response.statusCode!, response.headers); response.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("Fixture timeout")));
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
suite("Desktop canonical Chat Dock badge", () => {
beforeAll(async () => {
  base = await startStubGateway();
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  profile = mkdtempSync(join(tmpdir(), "chat-badge-")); mkdirSync(output, { recursive: true });
  const launch = () => _electron.launch({ executablePath,
    args: [resolve(import.meta.dirname, "fixtures/canonical-input-electron.mjs")],
    env: { ...process.env, OPERATOR_GATEWAY_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, OPERATOR_USER_DATA_DIR: profile },
  });
  app = await launch();
  const encrypted = await app.evaluate(async ({ app, safeStorage }) => {
    await app.whenReady();
    return safeStorage.encryptString(JSON.stringify({ accessToken: "stub-token-1", expiresAt: Date.now() + 3_600_000, userId: "user-1", handle: "neo" })).toString("base64");
  });
  writeFileSync(join(profile, "credential.bin"), Buffer.from(encrypted, "base64"));
  await closeElectronApp(app); app = await launch(); page = await app.firstWindow();
}, 60_000);
afterAll(async () => {
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, "last-state.png") });
  if (app) await closeElectronApp(app);
  for (const stream of streams) stream.end(); streams.clear();
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  await base?.close(); if (profile) rmSync(profile, { recursive: true, force: true });
});
it("clears the actual native badge when the Chat history is read", async () => {
  await expect.poll(() => app.evaluate(({ app }) => app.getBadgeCount()), { timeout: 20_000 }).toBe(1);
  if (manualReview) {
    console.log("Human Review ready: open Chat, then Dock badge review; the native badge should clear from 1 to 0. Close the Electron app when finished.");
    await new Promise<void>(done => app.on("close", done));
    return;
  }
  await page.getByRole("button", { name: "Chat", exact: true }).first().dblclick({ timeout: 20_000 });
  await page.getByRole("button", { name: "Dock badge review", exact: true }).click({ timeout: 20_000 });
  await page.getByText("Opening this chat clears its unread Dock badge.", { exact: true }).waitFor({ timeout: 5000 });
  await expect.poll(() => app.evaluate(({ app }) => app.getBadgeCount()), { timeout: 10_000 }).toBe(0);
  expect(unread).toBe(false);
  await page.screenshot({ path: join(output, "chat-read-badge-cleared.png") });
}, manualReview ? 3_600_000 : 30_000);
});
