import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { CanonicalChatDetailResponseSchema, type CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../../contracts/fixtures/canonical-chat";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const root = resolve(import.meta.dirname, "../../..");
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
const manualReview = process.env.OM239_HUMAN_REVIEW === "1";
const output = join(root, "output/playwright/om-239");
let app: ElectronApplication, page: Page, gateway: StubGateway, profile: string;
let detail: CanonicalChatDetailResponse;
const streams = new Set<ServerResponse>(); // Test-only, explicitly drained in afterAll.
const submissions: unknown[] = [];
const server = createServer((req, res) => {
  const path = new URL(req.url!, "http://localhost").pathname;
  const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (path === "/api/chats/events") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"chat.stream.attached"}\n\ndata: {"type":"chat.replay.end"}\n\n');
    streams.add(res); res.on("close", () => streams.delete(res)); return;
  }
  if (path === "/api/chats") { json({ items: [detail.record] }); return; }
  if (path === `/api/chats/${detail.record.chat.id}`) { json(detail); return; }
  if (path === "/api/chat-providers") { json(createCanonicalChatFixture("input_required").providerCatalog); return; }
  if (path.includes("/inputs/")) {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      submissions.push(JSON.parse(body));
      detail.activities.push({ chatId: detail.record.chat.id, runId: detail.runs[0]!.id, occurredAt: new Date().toISOString(), id: "evt_answered", type: "input.resolved", requestId: "input_destination", reason: "answered" });
      detail.runs[0]!.status = "running";
      detail.record.activeRun!.status = "running";
      json({ requestId: "input_destination", submission: "accepted" });
    }); return;
  }
  const upstream = httpRequest(new URL(req.url!, gateway.url), { method: req.method, headers: req.headers, timeout: 10_000 }, response => {
    res.writeHead(response.statusCode!, response.headers); response.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("Fixture timeout")));
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
beforeAll(async () => {
  const { snapshot } = createCanonicalChatFixture("input_required");
  snapshot.chat.title = "Plan the report";
  for (const run of snapshot.runs) { run.startedAt = new Date().toISOString(); run.updatedAt = run.startedAt; }
  const { project, providerBinding, activeRun, ...chat } = snapshot.chat;
  detail = CanonicalChatDetailResponseSchema.parse({ record: { chat, activeRun: snapshot.chat.activeRun, providerBinding: snapshot.chat.providerBinding }, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: [{
    id: "evt_question", chatId: snapshot.chat.id, runId: snapshot.runs[0]!.id, occurredAt: new Date().toISOString(), type: "input.requested", requestId: "input_destination", title: "A few details before I continue", questions: [
      { questionId: "destination", header: "Destination", question: "Where should I save the report?", allowOther: true, secret: false, options: [{ label: "Project folder", description: "Keep it with this project" }, { label: "Documents", description: "Save it in your files" }] },
      { questionId: "note", header: "Note", question: "What should the report include?", allowOther: false, secret: false },
    ],
  }] });
  gateway = await startStubGateway();
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  profile = mkdtempSync(join(tmpdir(), "om239-electron-")); mkdirSync(output, { recursive: true });
  const launch = () => _electron.launch({ executablePath, args: [join(root, "desktop/out/main/index.js")], env: { ...process.env, OPERATOR_GATEWAY_URL: url, OPERATOR_USER_DATA_DIR: profile } });
  app = await launch();
  // Seed only the local fixture credential; never invoke external browser authentication.
  const encrypted = await app.evaluate(({ safeStorage }) => safeStorage.encryptString(JSON.stringify({ accessToken: "stub-token-1", expiresAt: Date.now() + 3_600_000, userId: "user-1", handle: "neo" })).toString("base64"));
  writeFileSync(join(profile, "credential.bin"), Buffer.from(encrypted, "base64"));
  await app.close(); app = await launch(); page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
}, 60_000);
afterAll(async () => {
  if (page && !page.isClosed()) { await page.screenshot({ path: join(output, "last-state.png") });  }
  await app?.close();
  for (const stream of streams) stream.end(); streams.clear();
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  await gateway?.close(); if (profile) rmSync(profile, { recursive: true, force: true });
});
it("answers in the existing run and receives intermediate output without reloading", async () => {
  await page.getByRole("button", { name: "Chat", exact: true }).first().dblclick({ timeout: 20_000 });
  await page.getByRole("button", { name: "Plan the report", exact: true }).click({ timeout: 20_000 });
  await page.getByRole("radio", { name: /Project folder/ }).waitFor();
  await page.getByRole("button", { name: /Getting started —/ }).click();
  await page.getByRole("button", { name: "Maximize", exact: true }).click();
  await page.locator('[contenteditable="true"]').fill("Keep this unsent draft");
  await page.screenshot({ path: join(output, "01-question-wide.png") });
  await page.setViewportSize({ width: 600, height: 850 });
  await page.getByRole("button", { name: "Toggle Chat sidebar" }).click();
  await page.screenshot({ path: join(output, "02-question-narrow.png") });
  if (manualReview) {
    await expect.poll(() => submissions.length, { timeout: 15 * 60_000 }).toBe(1);
  } else {
    await page.getByRole("radio", { name: /Project folder/ }).check();
    await page.getByRole("textbox", { name: "What should the report include?" }).fill("Progress and next steps");
    await page.getByRole("button", { name: "Submit answer", exact: true }).click();
  }
  await page.getByText("Answer submitted", { exact: true }).waitFor();
  expect(submissions).toHaveLength(1);
  if (!manualReview) expect(submissions[0]).toMatchObject({ structuredAnswers: { destination: ["Project folder"], note: ["Progress and next steps"] } });
  detail.messages.push({ id: "msg_progress", chatId: detail.record.chat.id, runId: detail.runs[0]!.id, turnId: detail.turns[0]!.id, seq: 2, role: "assistant", state: "pending", parts: [{ type: "text", text: "I have your answers and am drafting the report now." }], createdAt: new Date().toISOString() });
  CanonicalChatDetailResponseSchema.parse(detail);
  expect(streams.size).toBeGreaterThan(0);
  const frame = { type: "chat.event", event: { cursor: 1, revision: 2, chatId: detail.record.chat.id, eventType: "run.message", createdAt: new Date().toISOString() } };
  for (const stream of streams) stream.write(`data: ${JSON.stringify(frame)}\n\n`);
  await page.getByText("I have your answers and am drafting the report now.", { exact: true }).waitFor({ timeout: 10_000 });
  expect(detail.runs[0]!.status).toBe("running");
  expect(detail.turns).toHaveLength(1);
  expect(await page.locator('[contenteditable="true"]').innerText()).toBe("Keep this unsent draft");
  expect(gateway.state.deviceCodeRequests).toBe(0);
  await page.screenshot({ path: join(output, "03-same-run-continuation.png") });
  if (manualReview) await page.waitForTimeout(60_000);
}, manualReview ? 17 * 60_000 : 40_000);
