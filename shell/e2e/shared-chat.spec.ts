import { expect, test, type Page, type Route } from "@playwright/test";

const scopeId = "10000000-0000-4000-8000-000000000001";
const now = "2026-09-17T12:00:00.000Z";

function fulfill(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function mockShell(page: Page) {
  await page.setExtraHTTPHeaders({ "x-matrix-platform-session": "platform" });
  await page.route("**/api/settings/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    return fulfill(route, pathname.endsWith("/onboarding-status")
      ? { complete: true }
      : pathname.endsWith("/agent")
        ? {
            identity: {},
            kernel: { model: "claude-opus-4-6", effort: "high" },
            availableModels: [{ id: "claude-opus-4-6", label: "Claude Opus 4.6", tier: "Most capable" }],
            availableEfforts: ["high"],
            defaults: { model: "claude-opus-4-6", effort: "high" },
            contractVersion: 2,
            revision: 1,
            chat: { provider: "anthropic", model: "claude-opus-4-6", effort: "high", source: "saved", authKind: "platform" },
            runtime: { selected: null, options: [], transition: null },
            providers: [],
            currentSelection: { chat: { provider: "anthropic", model: "claude-opus-4-6", effort: "high", source: "saved", authKind: "platform" } },
          }
        : {
            background: { type: "pattern" },
            dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
            pinnedApps: [],
            hasKey: true,
          });
  });
  await page.route("**/api/identity", (route) => fulfill(route, { handle: "test", displayName: "Test User" }));
  await page.route("**/api/apps**", (route) => fulfill(route, []));
  await page.route("**/api/shell/bootstrap", (route) => fulfill(route, { layout: { windows: [] }, apps: [], modules: [], icons: {} }));
  await page.route("**/api/layout", (route) => fulfill(route, { ok: true }));
  await page.route("**/billing/status**", (route) => fulfill(route, { access: { runtimeProxyAllowed: true }, trialOffer: null }));
  await page.route("**/api/chat-providers**", (route) => fulfill(route, { revision: 1, instances: [] }));
  await page.route("**/api/chats?**", (route) => fulfill(route, { items: [] }));
  await page.route("**/api/chats/events**", (route) => route.abort());
  await page.route(`**/api/collaboration/scopes/${scopeId}`, (route) => fulfill(route, {
    id: scopeId,
    ownerId: "user_e2e",
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
  await page.route(`**/api/collaboration/scopes/${scopeId}/chat`, (route) => fulfill(route, {
    id: "chat_launch_plan",
    scopeId,
    title: "Launch plan",
    lifecycle: "active",
    revision: "4",
    messageCount: "3",
    lastMessagePreview: "The launch checklist is ready.",
  }));
  await page.route(`**/api/collaboration/scopes/${scopeId}/chat/messages**`, (route) => fulfill(route, {
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
        actor: { actorId: "user_nima", displayName: "Nima" },
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
  await page.route(`**/api/collaboration/scopes/${scopeId}/chat/requests`, (route) => fulfill(route, {
    requests: [{
      id: "request_launch_1",
      chatId: "chat_launch_plan",
      acceptedSequence: "1",
      actor: { actorId: "user_nima", displayName: "Nima" },
      state: "completed",
      text: "Turn our decisions into a final checklist.",
      selection: { instanceId: "claude_shared", model: "claude-opus-4-6" },
      acceptedAt: now,
      updatedAt: now,
    }],
    approvals: [],
    defaultSelection: { instanceId: "claude_shared", model: "claude-opus-4-6" },
    resourceRevision: "4",
  }));
  await page.route(`**/api/collaboration/scopes/${scopeId}/connection-tickets`, (route) => fulfill(route, {
    ticket: "a".repeat(43),
    actorId: "user_e2e",
    expiresAt: "2026-09-17T13:00:00.000Z",
  }));
  await page.route("**/ws/**", (route) => route.abort());
}

test("shared Chat stays inside Web Desktop and Web Canvas", async ({ page }) => {
  await mockShell(page);
  await page.goto(`/shared/chat/${scopeId}`);
  await expect(page.getByRole("heading", { name: "Launch plan" })).toBeVisible();
  await expect(page.getByText("Live shared collaboration")).toBeVisible();
  await expect(page.getByRole("button", { name: "Discussion" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask AI" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage access" })).toBeVisible();
  await page.screenshot({ path: "../output/playwright/shared-chat/web-desktop-discussion.png", fullPage: true });

  await page.getByRole("button", { name: "Ask AI" }).click();
  await expect(page.getByRole("region", { name: "Shared AI queue" })).toBeVisible();
  await expect(page.getByTitle("Turn our decisions into a final checklist.")).toBeVisible();
  await page.screenshot({ path: "../output/playwright/shared-chat/web-desktop-ai.png", fullPage: true });

  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Mode: Canvas");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Launch plan" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Shared AI queue" })).toBeVisible();
  await page.screenshot({ path: "../output/playwright/shared-chat/web-canvas-ai.png", fullPage: true });
});
