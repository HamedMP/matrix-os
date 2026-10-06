import { createServer, request } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { CanonicalChatDetailResponseSchema, type CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { parseCodexAppServerRequestLine } from "../../../packages/gateway/src/coding-agents/codex-app-server-events";
import { createCanonicalChatFixture } from "../../contracts/fixtures/canonical-chat";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";
import { closeElectronApp } from "./fixtures/close-electron";

const root = resolve(import.meta.dirname, "../../..");
const built = existsSync(join(root, "desktop/out/main/index.js"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !built) throw new Error("Required Desktop build missing");
const suite = built ? describe : describe.skip;
const command = "bun run test tests/approval.test.ts";
let app: ElectronApplication, page: Page, base: StubGateway, profile: string;
let detail: CanonicalChatDetailResponse;
const submissions: Array<{ path: string; decision: string; clientRequestId: string }> = [];

function pendingDetail(proposedCommand = command): CanonicalChatDetailResponse {
  const { snapshot } = createCanonicalChatFixture("approval_required");
  snapshot.chat.title = "Approval contents review";
  const { project: _project, providerBinding, activeRun, ...chat } = snapshot.chat;
  const run = snapshot.runs[0]!;
  run.startedAt = new Date().toISOString(); run.updatedAt = run.startedAt;
  const normalized = parseCodexAppServerRequestLine(JSON.stringify({ id: 105,
    method: "item/commandExecution/requestApproval", params: { threadId: "native-thread", turnId: "native-turn",
      itemId: "native-command", command: proposedCommand, cwd: "projects/demo", reason: "Validate the project",
      availableDecisions: ["accept", "decline"] } }), {
    threadId: "thread_review", now: () => new Date(run.createdAt), nextEventId: () => "evt_review",
  }).events[0];
  if (normalized?.type !== "approval.requested") throw new Error("Native approval missing");
  const approval = normalized.approval;
  return CanonicalChatDetailResponseSchema.parse({ record: { chat, providerBinding, activeRun },
    messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: [{
      id: "evt_approval", chatId: chat.id, runId: run.id, occurredAt: run.createdAt, type: "approval.requested",
      approvalId: approval.approvalId, title: approval.title, safeDescription: approval.safeDescription,
      preview: approval.preview, risk: approval.risk, allowedDecisions: approval.allowedDecisions,
    }] });
}

const server = createServer((req, res) => {
  const path = new URL(req.url!, "http://localhost").pathname;
  const json = (value: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (path === "/api/chats") return json({ items: [detail.record] });
  if (path === "/api/chat-providers") return json(createCanonicalChatFixture("approval_required").providerCatalog);
  if (path === `/api/chats/${detail.record.chat.id}`) return json(detail);
  if (path.includes("/approvals/")) {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      const submitted = JSON.parse(body);
      submissions.push({ path, ...submitted });
      const approval = detail.activities.find(a => a.type === "approval.requested")!;
      if (approval.type !== "approval.requested") throw new Error("Approval missing");
      detail.activities.push({ id: "evt_decision", chatId: detail.record.chat.id, runId: approval.runId,
        occurredAt: new Date().toISOString(), type: "approval.resolved", approvalId: approval.approvalId, decision: submitted.decision });
      json({ approvalId: approval.approvalId, decision: submitted.decision, submission: "accepted" });
    });
    return;
  }
  const upstream = request(new URL(req.url!, base.url), { method: req.method, headers: req.headers, timeout: 10_000 }, response => {
    res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("Fixture timeout")));
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
});

suite("native approval contents in built Electron Desktop", () => {
  beforeAll(async () => {
    detail = pendingDetail();
    base = await startStubGateway();
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    profile = await mkdtemp(join(tmpdir(), "eng105-electron-"));
    const launch = () => _electron.launch({ executablePath: createRequire(join(root, "desktop/package.json"))("electron") as string,
      args: [resolve(import.meta.dirname, "fixtures/canonical-input-electron.mjs")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, OPERATOR_USER_DATA_DIR: profile } });
    app = await launch();
    const encrypted = await app.evaluate(async ({ app, safeStorage }) => {
      await app.whenReady();
      return safeStorage.encryptString(JSON.stringify({ accessToken: "stub-token-1", expiresAt: Date.now() + 3_600_000,
        userId: "user-1", handle: "neo" })).toString("base64");
    });
    await writeFile(join(profile, "credential.bin"), Buffer.from(encrypted, "base64"));
    await closeElectronApp(app); app = await launch(); page = await app.firstWindow(); page.setDefaultTimeout(15_000);
  }, 60_000);
  afterAll(async () => {
    if (page && !page.isClosed()) { await mkdir(join(root, "output/eng105"), { recursive: true }); await page.screenshot({ path: join(root, "output/eng105/last-state.png") }); }
    if (app) await closeElectronApp(app);
    server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done()));
    await base?.close(); if (profile) await rm(profile, { recursive: true, force: true });
  });
  it.each([["approve", "Approved"], ["decline", "Declined"]] as const)("reviews contents before %s and retains them after reload", async (decision, outcome) => {
    detail = pendingDetail(); await page.reload();
    const later = page.getByRole("button", { name: "Later", exact: true }); if (await later.isVisible()) await later.click();
    const chatIcon = page.getByRole("button", { name: "Chat", exact: true }).first();
    if (await chatIcon.isVisible()) await chatIcon.dblclick();
    await page.getByRole("button", { name: "Approval contents review", exact: true }).click();
    const card = page.getByRole("group", { name: "Approval required: Run command" });
    await card.getByText(command, { exact: false }).waitFor();
    expect(await card.innerText()).toContain("projects/demo");
    await mkdir(join(root, "output/eng105"), { recursive: true });
    await page.screenshot({ path: join(root, `output/eng105/before-${decision}.png`) });
    await card.getByRole("button", { name: `${decision === "approve" ? "Approve" : "Decline"} Run command`, exact: true }).click();
    await page.getByText(outcome, { exact: true }).waitFor();
    expect(submissions.at(-1)).toMatchObject({ decision, clientRequestId: expect.stringMatching(/^req_/) });
    expect(submissions.at(-1)!.path).toContain(`/runs/${detail.runs[0]!.id}/approvals/`);
    await page.reload(); await page.getByRole("button", { name: "Approval contents review", exact: true }).click();
    const recorded = page.getByRole("group", { name: "Approval resolved: Run command" });
    await recorded.getByText(outcome, { exact: true }).waitFor();
    expect(await recorded.innerText()).toContain(command);
  }, 60_000);
  it("keeps a long unbroken command argument inside the review card", async () => {
    const longCommand = `echo ${"x".repeat(900)}`;
    detail = pendingDetail(longCommand); await page.reload();
    await page.getByRole("button", { name: "Approval contents review", exact: true }).click();
    const card = page.getByRole("group", { name: "Approval required: Run command" });
    const description = card.getByText(longCommand, { exact: false });
    await description.waitFor();
    expect(await description.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }, 60_000);
});
