import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import {
  CollaborationChatMessagesResponseSchema,
  CollaborationChatSchema,
  CollaborationDirectSessionSchema,
  CollaborationScopeSchema,
  CollaborationSignedConnectionTicketSchema,
  RUNNING_RUNTIME_COMPATIBILITY,
} from "@matrix-os/contracts";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const root = resolve(import.meta.dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const hasDesktopBuild = existsSync(main) && existsSync(join(root, "desktop/out/renderer/index.html"));
const suite = hasDesktopBuild ? describe : describe.skip;
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
const output = join(root, "output/playwright/shared-chat");
const scopeId = "10000000-0000-4000-8000-000000000001";
const runtimeId = "vps-11111111-1111-4111-8111-111111111111";
const now = "2026-09-17T12:00:00.000Z";
const organizationId = "org_matrix_team";
const configuredExecutionPolicy = {
  scope: { kind: "standalone_chat", scopeId, chatId: "chat_launch_plan" },
  ownerId: "user-1",
  source: {
    accessSourceId: "owner_anthropic",
    providerInstanceId: "claude_owner",
    harness: "claude_code",
  },
  submitMode: "follow_organization",
  organizationAiSubmission: "members",
  effectiveSubmitMode: "members",
  providerTermsAcknowledgedAt: now,
  allowedModelIds: ["claude-sonnet-5"],
  revision: "3",
  updatedAt: now,
};

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function proofKeyThumbprint(proofPublicKey: string): string {
  return createHash("sha256").update(Buffer.from(proofPublicKey, "base64url")).digest("base64url");
}

suite("Electron shared Chat presentation", () => {
  let app: ElectronApplication;
  let page: Page;
  let gateway: StubGateway;
  let profile: string;
  const streams = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (req.method === "POST" && path === "/api/collaboration/connections") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const request = JSON.parse(body) as { proofPublicKey: string };
        const issuedAt = new Date();
        const signedTicket = CollaborationSignedConnectionTicketSchema.parse({
          ticket: {
            protocolVersion: 2,
            ticketId: "10000000-0000-4000-8000-000000000010",
            nonce: "a".repeat(64),
            actorId: "user-1",
            organizationId,
            resource: { scopeId, kind: "chat" },
            purpose: "direct_session",
            runtime: { runtimeId, authorityGeneration: 1 },
            proofKeyThumbprint: proofKeyThumbprint(request.proofPublicKey),
            maxActions: 32,
            issuedAt: issuedAt.toISOString(),
            expiresAt: new Date(issuedAt.getTime() + 30_000).toISOString(),
          },
          keyId: "platform",
          signature: "a".repeat(86),
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
        json(
          res,
          {
            signedTicket,
            endpoint: { origin: `http://127.0.0.1:${address.port}`, protocolVersion: 2 },
          },
          201,
        );
      });
      return;
    }
    if (req.method === "POST" && path === "/api/collaboration/direct-sessions") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const request = JSON.parse(body) as { proofPublicKey: string };
        const issuedAt = new Date();
        json(
          res,
          CollaborationDirectSessionSchema.parse({
            protocolVersion: 2,
            id: "20000000-0000-4000-8000-000000000010",
            actorId: "user-1",
            organizationId,
            scopeId,
            runtimeId,
            authorityGeneration: 1,
            purpose: "direct_session",
            proofKeyThumbprint: proofKeyThumbprint(request.proofPublicKey),
            issuedAt: issuedAt.toISOString(),
            expiresAt: new Date(issuedAt.getTime() + 300_000).toISOString(),
            evidenceExpiresAt: new Date(issuedAt.getTime() + 20_000).toISOString(),
            renewAfter: new Date(issuedAt.getTime() + 240_000).toISOString(),
          }),
          201,
        );
      });
      return;
    }
    if (path === "/api/system/info") {
      json(res, {
        version: "stub",
        build: { sha: "test" },
        runtimeCompatibility: RUNNING_RUNTIME_COMPATIBILITY,
        uptime: 1,
        runtime: {
          handle: "neo",
          runtimeSlot: "primary",
          machineId: "11111111-1111-4111-8111-111111111111",
        },
        capabilities: { collaboration: true },
        resources: { cpuCount: 8, memoryTotal: 8e9, memoryFree: 4e9, diskTotal: 1e11, diskFree: 5e10 },
      });
      return;
    }
    if (path === "/api/chats/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"chat.stream.attached"}\n\ndata: {"type":"chat.replay.end"}\n\n');
      streams.add(res);
      res.on("close", () => streams.delete(res));
      return;
    }
    if (path === "/api/chats") {
      json(res, { items: [] });
      return;
    }
    if (path === "/api/collaboration/inbox") {
      json(res, { items: [] });
      return;
    }
    if (path === "/api/collaboration/shared") {
      json(res, {
        items: [{
          scopeId,
          runtimeId: "vps:11111111-1111-4111-8111-111111111111",
          ownerId: "user-1",
          organizationId,
          kind: "chat",
          authorityGeneration: 1,
          status: "accepted",
          resource: {
            scope: {
              id: scopeId,
              ownerId: "user-1",
              kind: "chat",
              resourceId: "chat_launch_plan",
              membershipMode: "direct",
              lifecycle: "shared",
              revision: "4",
              authEpoch: "1",
              authorityGeneration: "1",
              role: "owner",
              capabilities: {
                read: true,
                discuss: true,
                manageMembers: true,
                requestAi: true,
                observeTerminal: false,
                controlTerminal: false,
                stopTerminal: false,
              },
            },
            chat: {
              id: "chat_launch_plan",
              scopeId,
              title: "Launch plan",
              lifecycle: "active",
              revision: "4",
              messageCount: "3",
              lastMessagePreview: "The launch checklist is ready.",
            },
          },
        }],
      });
      return;
    }
    if (path === `/api/collaboration/scopes/${scopeId}`) {
      json(res, CollaborationScopeSchema.parse({
        id: scopeId,
        ownerId: "user-1",
        organizationId,
        kind: "chat",
        resourceId: "chat_launch_plan",
        membershipMode: "direct",
        lifecycle: "shared",
        revision: "4",
        authEpoch: "1",
        authorityGeneration: "1",
        role: "owner",
        capabilities: {
          read: true,
          discuss: true,
          manageMembers: true,
          requestAi: true,
          observeTerminal: false,
          controlTerminal: false,
          stopTerminal: false,
        },
      }));
      return;
    }
    if (path === `/api/collaboration/scopes/${scopeId}/chat`) {
      json(res, CollaborationChatSchema.parse({
        id: "chat_launch_plan",
        scopeId,
        title: "Launch plan",
        lifecycle: "active",
        revision: "4",
        messageCount: "3",
        lastMessagePreview: "The launch checklist is ready.",
      }));
      return;
    }
    if (path === `/api/collaboration/scopes/${scopeId}/chat/messages`) {
      json(res, CollaborationChatMessagesResponseSchema.parse({
        messages: [
          {
            id: "msg_discussion_1",
            chatId: "chat_launch_plan",
            sequence: "1",
            role: "user",
            state: "committed",
            purpose: "discussion",
            actor: { actorId: "user_ada", displayName: "Ada" },
            parts: [{ type: "text", text: "I moved the launch review to **Thursday at 10:00**." }],
            createdAt: now,
          },
          {
            id: "msg_request_1",
            chatId: "chat_launch_plan",
            sequence: "2",
            role: "user",
            state: "committed",
            purpose: "ai_request",
            actor: { actorId: "user-1", displayName: "Nima" },
            parts: [{ type: "text", text: "Turn our decisions into a final checklist." }],
            createdAt: now,
          },
          {
            id: "msg_answer_1",
            chatId: "chat_launch_plan",
            sequence: "3",
            role: "assistant",
            state: "committed",
            purpose: "assistant",
            actor: { actorId: "matrix_ai", displayName: "Matrix AI" },
            parts: [{ type: "text", text: "### Launch checklist\n\n- Confirm the Thursday review\n- Publish the release notes\n- Watch the rollout dashboard" }],
            createdAt: now,
          },
        ],
      }));
      return;
    }
    if (path === `/api/collaboration/scopes/${scopeId}/chat/requests`) {
      json(res, {
        requests: [{
          id: "request_launch_1",
          chatId: "chat_launch_plan",
          acceptedSequence: "1",
          actor: { actorId: "user-1", displayName: "Nima" },
          state: "completed",
          text: "Turn our decisions into a final checklist.",
          selection: { instanceId: "claude_shared", model: "claude-opus-4-6" },
          acceptedAt: now,
          updatedAt: now,
        }],
        approvals: [],
        capability: {
          status: "available",
          effectiveSelection: { instanceId: "claude_shared", model: "claude-opus-4-6" },
        },
        resourceRevision: "4",
      });
      return;
    }
    if (path === `/api/collaboration/scopes/${scopeId}/discussion/messages`) {
      json(res, {
        messages: [{
          id: "msg_discussion_1",
          scopeId,
          sequence: "1",
          actor: { actorId: "user_ada", displayName: "Ada" },
          text: "I moved the launch review to Thursday at 10:00.",
          createdAt: now,
        }],
        latestSequence: "1",
      });
      return;
    }
    if (path === `/api/collaboration/scopes/${scopeId}/discussion/user-state`) {
      json(res, { readThroughSeq: "1", lastOpenedAt: now });
      return;
    }
    if (path === `/api/collaboration/scopes/${scopeId}/members`) {
      json(res, {
        members: [
          {
            actor: { actorId: "user-1", displayName: "Nima" },
            role: "owner", status: "accepted", revision: "1", joinedAt: now, updatedAt: now,
          },
          {
            actor: { actorId: "user_ada", displayName: "Ada" },
            role: "editor", status: "accepted", revision: "1", joinedAt: now, updatedAt: now,
          },
        ],
      });
      return;
    }
    if (path === `/api/collaboration/scopes/${scopeId}/execution-policy/options`) {
      json(res, {
        organizationAiSubmission: "members",
        policy: configuredExecutionPolicy,
        options: [{
          source: configuredExecutionPolicy.source,
          sourceLabel: "Owner Claude account",
          sourceKind: "owner_account",
          available: true,
          modelIds: ["claude-opus-5", "claude-sonnet-5"],
          defaultModelId: "claude-opus-5",
        }],
      });
      return;
    }
    if (path === `/api/collaboration/scopes/${scopeId}/policy/preflight`) {
      json(res, {
        resourceKind: "chat",
        state: "ready",
        missingOwnerSetup: [],
        sourceKind: "owner_account",
        effectiveSubmitMode: "members",
        items: [
          { item: "ai_source", status: "ready" },
          { item: "submit_mode", status: "ready" },
        ],
      });
      return;
    }
    if (path === `/api/collaboration/scopes/${scopeId}/grants`) {
      json(res, []);
      return;
    }
    if (path === `/api/organizations/${organizationId}/members`) {
      json(res, { members: [] });
      return;
    }
    if (path === `/api/collaboration/scopes/${scopeId}/connection-tickets`) {
      json(res, { ticket: "a".repeat(43), actorId: "user-1", expiresAt: "2026-09-17T13:00:00.000Z" });
      return;
    }
    const upstream = httpRequest(new URL(req.url ?? "/", gateway.url), {
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

  beforeAll(async () => {
    mkdirSync(output, { recursive: true });
    gateway = await startStubGateway({
      identity: { userId: "user-1", handle: "neo", displayName: "Nima" },
      organizationManagement: {
        organizations: [{
          organizationId,
          name: "Matrix Team",
          slug: "matrix-team",
          role: "org:admin",
          memberCount: 2,
          aiSubmission: "members",
          membershipEpoch: 1,
        }],
        members: { [organizationId]: [] },
        invitations: { [organizationId]: [] },
      },
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const platformUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    profile = mkdtempSync(join(tmpdir(), "shared-chat-electron-"));
    const launch = () => _electron.launch({
      executablePath,
      args: [resolve(import.meta.dirname, "fixtures/canonical-input-electron.mjs")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: platformUrl, OPERATOR_USER_DATA_DIR: profile },
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
    writeFileSync(join(profile, "credential.bin"), Buffer.from(encrypted, "base64"));
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const stream of streams) stream.end();
    streams.clear();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await gateway?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  it("opens Shared with me inside the canonical Chat workspace", async () => {
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Chat", exact: true }).first().dblclick({ timeout: 20_000 });
    await page.getByRole("button", { name: "Shared with me" }).click();
    await page.getByRole("button", { name: "Open Chat" }).click();

    await page.getByText("Launch plan", { exact: true }).first().waitFor();
    await page.screenshot({ path: join(output, "electron-desktop.png") });
    expect(await page.getByRole("button", { name: "Rename Launch plan" }).count()).toBe(0);
    expect(await page.locator('[data-slot="canonical-chat-workspace"]').count()).toBe(1);
    expect(await page.locator('[data-slot="shared-chat-surface"]').count()).toBe(1);
    expect(await page.locator('[data-slot="collaboration-session-subheader"]').count()).toBe(0);
    expect(await page.getByLabel("Message Chat").isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Ask AI" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Open discussion" }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Collaboration access" }).isVisible()).toBe(true);
    expect(await page.getByRole("region", { name: "Chat history" }).innerText()).not.toContain("moved the launch review");
    const gettingStarted = page.getByRole("heading", { name: "Getting started" });
    if (await gettingStarted.isVisible()) {
      await page.getByRole("button", { name: /Getting started —/ }).click();
      await gettingStarted.waitFor({ state: "hidden" });
    }
    await page.getByRole("button", { name: "Collaboration access" }).click();
    await page.getByRole("button", { name: "Manage access" }).click();
    const manager = page.getByRole("dialog", { name: "Invite collaborators" });
    await manager.getByRole("region", { name: "Contributor AI" }).waitFor();
    expect(await manager.getByRole("region", { name: "Contributor AI" }).innerText())
      .toContain("Contributors can send prompts using this owner-selected source and model.");
    expect(await manager.getByLabel("Owner AI source").inputValue())
      .toBe(JSON.stringify(["owner_anthropic", "claude_owner"]));
    expect(await manager.getByLabel("Allowed model").inputValue()).toBe("claude-sonnet-5");
    await page.screenshot({ path: join(output, "contributor-ai-electron-desktop.png") });
    await manager.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Open discussion" }).click();
    await page.getByRole("dialog", { name: "Discussion" }).waitFor();
    expect(await page.getByRole("dialog", { name: "Discussion" }).innerText()).toContain("moved the launch review");
    await page.screenshot({ path: join(output, "electron-discussion.png") });
  }, 40_000);
});
