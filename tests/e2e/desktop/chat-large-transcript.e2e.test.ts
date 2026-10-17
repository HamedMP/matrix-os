import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, request, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { CanonicalChatDetailResponseSchema, CanonicalChatListResponseSchema } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../../contracts/fixtures/canonical-chat";
import { closeElectronApp } from "./fixtures/close-electron";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const root = resolve(import.meta.dirname, "../../..");
const built = existsSync(join(root, "desktop/out/main/index.js"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !built) {
  throw new Error("Required Desktop build missing");
}
const suite = built ? describe : describe.skip;
const fixture = createCanonicalChatFixture("running").snapshot;
const chatId = fixture.chat.id;
const run = fixture.runs[0]!;
const turn = fixture.turns[0]!;
const { project: _project, providerBinding, activeRun, ...baseChat } = fixture.chat;
const occurredAt = "2026-10-01T19:00:00.000Z";
const activities = Array.from({ length: 500 }, (_, index) => ({
  id: `activity_large_${index + 1}`,
  chatId,
  runId: run.id,
  sequence: index + 1,
  occurredAt,
  type: "agent.activity" as const,
  activityId: `work_large_${index + 1}`,
  kind: "command" as const,
  label: `Step ${index + 1}`,
  status: "completed" as const,
}));
const finalText = "The large Chat remains visible with stable viewport geometry.";
let completed = false;
let detailRequests = 0;
let cursor = 0;
let app: ElectronApplication;
let page: Page;
let base: StubGateway;
let profile: string;
const streams = new Set<ServerResponse>();

function record() {
  return {
    chat: {
      ...baseChat,
      title: "Large transcript recovery",
      revision: completed ? 2 : 1,
      messageCount: completed ? 2 : 1,
      lastMessagePreview: completed ? finalText : "Build the canonical Chat contract.",
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
    ...(providerBinding ? { providerBinding } : {}),
    ...(completed || !activeRun ? {} : { activeRun }),
  };
}

function detail() {
  const terminalRun = completed
    ? { ...run, status: "completed" as const, outcome: "completed" as const, completedAt: occurredAt }
    : run;
  const terminalTurn = completed ? { ...turn, status: "completed" as const, updatedAt: occurredAt } : turn;
  return CanonicalChatDetailResponseSchema.parse({
    record: record(),
    turns: [terminalTurn],
    runs: [terminalRun],
    queuedTurns: [],
    messages: [
      fixture.messages[0]!,
      ...(completed ? [{
        id: "msg_large_final",
        chatId,
        runId: run.id,
        turnId: turn.id,
        seq: 2,
        role: "assistant" as const,
        state: "committed" as const,
        parts: [{ type: "text" as const, text: finalText }],
        createdAt: occurredAt,
      }] : []),
    ],
    activities,
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url!, "http://localhost");
  const json = (value: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === "/api/chats/events") {
    if (streams.size >= 4) {
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"chat.stream.attached"}\n\ndata: {"type":"chat.replay.end"}\n\n');
    streams.add(res);
    res.on("close", () => streams.delete(res));
    return;
  }
  if (url.pathname === "/api/chats") {
    return json(CanonicalChatListResponseSchema.parse({ items: [record()] }));
  }
  if (url.pathname === `/api/chats/${chatId}`) {
    detailRequests += 1;
    return json(detail());
  }
  if (url.pathname === `/api/chats/${chatId}/read-state`) {
    req.resume();
    return json(record());
  }
  const upstream = request(new URL(req.url!, base.url), {
    method: req.method,
    headers: req.headers,
    timeout: 10_000,
  }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("Fixture timeout")));
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

function publishCompletion(): void {
  completed = true;
  for (const stream of streams) {
    stream.write(`data: ${JSON.stringify({
      type: "chat.event",
      event: {
        cursor: ++cursor,
        revision: 2,
        chatId,
        eventType: "run.completed",
        createdAt: occurredAt,
      },
    })}\n\n`);
  }
}

async function expectValidGeometry(): Promise<void> {
  await page.waitForFunction(() => {
    const viewport = document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
    const content = viewport?.firstElementChild as HTMLElement | null;
    if (!viewport || !content) return false;
    const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    return Math.abs(maximum - viewport.scrollTop) <= 1
      && content.getBoundingClientRect().bottom >= viewport.getBoundingClientRect().bottom - 1;
  });
  const metrics = await page.locator('[data-slot="message-scroller-viewport"]').evaluate((element) => {
    const viewport = element as HTMLElement;
    const content = viewport.firstElementChild as HTMLElement | null;
    return {
      scrollTop: viewport.scrollTop,
      maximum: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
      viewportBottom: viewport.getBoundingClientRect().bottom,
      contentBottom: content?.getBoundingClientRect().bottom ?? 0,
    };
  });
  expect(metrics.scrollTop).toBeGreaterThanOrEqual(0);
  expect(metrics.scrollTop).toBeLessThanOrEqual(metrics.maximum + 1);
  expect(Math.abs(metrics.maximum - metrics.scrollTop)).toBeLessThanOrEqual(1);
  expect(metrics.contentBottom).toBeGreaterThanOrEqual(metrics.viewportBottom - 1);
}

suite("large canonical Chat viewport recovery", () => {
  beforeAll(async () => {
    base = await startStubGateway();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    profile = await mkdtemp(join(tmpdir(), "chat-large-transcript-"));
    const launch = () => _electron.launch({
      executablePath: createRequire(join(root, "desktop/package.json"))("electron") as string,
      args: [resolve(import.meta.dirname, "fixtures/canonical-input-electron.mjs")],
      env: {
        ...process.env,
        OPERATOR_GATEWAY_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        OPERATOR_USER_DATA_DIR: profile,
      },
    });
    app = await launch();
    const encrypted = await app.evaluate(async ({ app: electronApp, safeStorage }) => {
      await electronApp.whenReady();
      return safeStorage.encryptString(JSON.stringify({
        accessToken: "stub-token-1",
        expiresAt: Date.now() + 3_600_000,
        userId: "user-1",
        handle: "neo",
      })).toString("base64");
    });
    await writeFile(join(profile, "credential.bin"), Buffer.from(encrypted, "base64"));
    await closeElectronApp(app);
    app = await launch();
    page = await app.firstWindow();
    page.setDefaultTimeout(20_000);
  }, 60_000);

  afterAll(async () => {
    if (page && !page.isClosed()) {
      const output = join(root, "output/chat-large-transcript");
      await mkdir(output, { recursive: true });
      await page.screenshot({ path: join(output, "last-state.png") });
    }
    if (app) await closeElectronApp(app);
    for (const stream of streams) stream.end();
    streams.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await base?.close();
    if (profile) await rm(profile, { recursive: true, force: true });
  });

  it("keeps a maximum-sized Chat visible through terminal collapse and renderer reload", async () => {
    await page.getByRole("button", { name: "Chat", exact: true }).first().dblclick();
    await page.getByRole("button", { name: "Large transcript recovery", exact: true }).click();
    const worked = page.getByRole("button", { name: /Worked for/ });
    await worked.waitFor();
    if (await worked.getAttribute("aria-expanded") !== "true") await worked.click();
    await page.getByText("Step 500", { exact: true }).waitFor();

    publishCompletion();
    await page.getByText(finalText, { exact: true }).waitFor();
    await worked.click();
    await expect.poll(() => worked.getAttribute("aria-expanded")).toBe("false");
    await expectValidGeometry();

    const requestsBeforeReload = detailRequests;
    await Promise.all([
      page.waitForEvent("load"),
      page.keyboard.press(process.platform === "darwin" ? "Meta+R" : "Control+R"),
    ]);
    await page.getByRole("button", { name: "Chat", exact: true }).first().dblclick();
    await page.getByRole("button", { name: "Large transcript recovery", exact: true }).click();
    await page.getByText(finalText, { exact: true }).waitFor();
    expect(detailRequests).toBeGreaterThan(requestsBeforeReload);
    await expectValidGeometry();
  }, 45_000);
});
