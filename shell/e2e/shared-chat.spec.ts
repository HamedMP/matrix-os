import { expect, test, type Page, type Route } from "@playwright/test";

const scopeId = "10000000-0000-4000-8000-000000000001";
const invitationId = "30000000-0000-4000-8000-000000000001";
const now = "2026-09-17T12:00:00.000Z";

function fulfill(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function mockShell(
  page: Page,
  capability: {
    status: "available" | "unavailable" | "owner_binding_required" | "owner_reconnect_required";
    effectiveSelection?: { instanceId: string; model: string };
  } = {
    status: "available",
    effectiveSelection: { instanceId: "claude_shared", model: "claude-opus-4-6" },
  },
) {
  await page.setExtraHTTPHeaders({ "x-matrix-platform-session": "platform" });
  // The getting-started checklist auto-opens once per route when its gateway status
  // probes report incomplete steps. Those probes are not part of this spec, so mark the
  // route as already auto-opened to keep the shared Chat header and copy assertions hermetic.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem(
        `matrix:getting-started:auto-opened:web:${encodeURIComponent(window.location.pathname)}`,
        "1",
      );
    } catch (error: unknown) {
      console.warn("[e2e] unable to seed getting-started state:", error instanceof Error ? error.name : typeof error);
    }
  });
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
  // The chat sidebar's "Shared with me" entry probes the routed VPS capability before rendering.
  await page.route("**/api/system/info", (route) => fulfill(route, {
    runtime: { handle: "test", runtimeSlot: "primary", machineId: "11111111-1111-4111-8111-111111111111" },
    capabilities: { collaboration: true },
  }));
  await page.route("**/api/apps**", (route) => fulfill(route, []));
  await page.route("**/api/shell/bootstrap", (route) => fulfill(route, { layout: { windows: [] }, apps: [], modules: [], icons: {} }));
  await page.route("**/api/layout", (route) => fulfill(route, { ok: true }));
  await page.route("**/billing/status**", (route) => fulfill(route, { access: { runtimeProxyAllowed: true }, trialOffer: null }));
  await page.route("**/api/chat-providers**", (route) => fulfill(route, { revision: 1, instances: [] }));
  await page.route("**/api/chats?**", (route) => fulfill(route, { items: [] }));
  await page.route("**/api/chats/events**", (route) => route.abort());
  await page.route("**/api/collaboration/inbox**", (route) => fulfill(route, { items: [{
    scopeId,
    runtimeId: "vps:11111111-1111-4111-8111-111111111111",
    ownerId: "user_e2e",
    kind: "chat",
    authorityGeneration: 1,
    status: "invited",
    invitationId,
    resource: {
      id: invitationId,
      scopeId,
      owner: { actorId: "user_e2e", displayName: "Nima" },
      target: { actorId: "user_ada", displayName: "Ada" },
      scopeKind: "chat",
      role: "editor",
      status: "pending",
      expiresAt: "2026-09-19T12:00:00.000Z",
      revision: "2",
    },
  }] }));
  await page.route("**/api/collaboration/shared**", (route) => fulfill(route, { items: [{
    scopeId,
    runtimeId: "vps:11111111-1111-4111-8111-111111111111",
    ownerId: "user_e2e",
    kind: "chat",
    authorityGeneration: 1,
    status: "accepted",
    resource: {
      scope: {
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
          read: true, discuss: true, manageMembers: true, requestAi: true,
          observeTerminal: false, controlTerminal: false, stopTerminal: false,
        },
      },
      chat: {
        id: "chat_launch_plan", scopeId, title: "Launch plan", lifecycle: "active",
        revision: "4", messageCount: "3", lastMessagePreview: "The launch checklist is ready.",
      },
    },
  }] }));
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
    capability,
    resourceRevision: "4",
  }));
  await page.route(`**/api/collaboration/scopes/${scopeId}/discussion/messages**`, (route) => fulfill(route, {
    messages: [{
      id: "msg_discussion_1",
      scopeId,
      sequence: "1",
      actor: { actorId: "user_ada", displayName: "Ada" },
      text: "I moved the launch review to Thursday at 10:00.",
      createdAt: now,
    }],
    latestSequence: "1",
  }));
  await page.route(`**/api/collaboration/scopes/${scopeId}/discussion/user-state`, (route) => fulfill(route, {
    readThroughSeq: "1",
    lastOpenedAt: now,
  }));
  await page.route(`**/api/collaboration/scopes/${scopeId}/members`, (route) => fulfill(route, {
    members: [
      {
        actor: { actorId: "user_e2e", displayName: "Test User" },
        role: "owner", status: "accepted", revision: "1", joinedAt: now, updatedAt: now,
      },
      {
        actor: { actorId: "user_ada", displayName: "Ada" },
        role: "editor", status: "accepted", revision: "1", joinedAt: now, updatedAt: now,
      },
    ],
  }));
  await page.route(`**/api/collaboration/scopes/${scopeId}/connection-tickets`, (route) => fulfill(route, {
    ticket: "a".repeat(43),
    actorId: "user_e2e",
    expiresAt: "2026-09-17T13:00:00.000Z",
  }));
  await page.route("**/ws/**", (route) => route.abort());
}

test("shared Chat stays an ordinary Chat inside Web Desktop and Web Canvas", async ({ page }) => {
  await mockShell(page);
  await page.goto(`/shared/chat/${scopeId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Launch plan")).toBeVisible();
  await expect(page.getByRole("region", { name: "Chat history" })).toContainText("Turn our decisions into a final checklist.");
  await expect(page.getByRole("region", { name: "Chat history" })).toContainText("Launch checklist");
  await expect(page.getByRole("region", { name: "Chat history" })).not.toContainText("moved the launch review");
  await expect(page.getByLabel("Message Chat")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask AI" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open discussion" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Collaboration access" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Shared with me" })).toBeVisible();
  await expect(page.getByLabel("1 pending invitation")).toBeVisible();
  await page.screenshot({ path: "../output/playwright/collaboration-ux/web-desktop-chat.png", fullPage: true });

  await page.getByRole("button", { name: "Shared with me" }).click();
  await expect(page.getByRole("heading", { name: "Shared with me" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Decline" })).toBeVisible();
  await page.screenshot({ path: "../output/playwright/collaboration-ux/web-desktop-shared-with-me.png", fullPage: true });
  await page.getByRole("button", { name: "Open Chat" }).click();
  await expect(page.getByText("Launch plan")).toBeVisible();

  await page.getByRole("button", { name: "Open discussion" }).click();
  await expect(page.getByRole("dialog", { name: "Discussion" })).toContainText("I moved the launch review to Thursday at 10:00.");
  await page.screenshot({ path: "../output/playwright/collaboration-ux/web-desktop-discussion.png", fullPage: true });
  await page.getByRole("button", { name: "Close discussion panel" }).click();

  await page.getByRole("button", { name: "Collaboration access" }).click();
  await expect(page.getByRole("dialog", { name: "Collaboration access summary" })).toContainText("Ada");
  await expect(page.getByRole("button", { name: "Manage access" })).toBeVisible();
  await page.screenshot({ path: "../output/playwright/collaboration-ux/web-desktop-access.png", fullPage: true });
  await page.getByRole("button", { name: "Close access summary" }).click();

  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Mode: Canvas");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Launch plan")).toBeVisible();
  await expect(page.getByLabel("Message Chat")).toBeVisible();
  await page.screenshot({ path: "../output/playwright/collaboration-ux/web-canvas-chat.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/shared/chat/${scopeId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Launch plan")).toBeVisible();
  await expect(page.getByLabel("Message Chat")).toBeVisible();
  await page.screenshot({ path: "../output/playwright/collaboration-ux/responsive-chat.png", fullPage: true });
  await page.getByRole("button", { name: "Open discussion" }).click();
  const mobileDiscussion = page.getByRole("dialog", { name: "Discussion" });
  await expect(mobileDiscussion).toBeVisible();
  const viewport = page.viewportSize();
  const discussionBox = await mobileDiscussion.boundingBox();
  expect(discussionBox?.width).toBeGreaterThanOrEqual((viewport?.width ?? 390) - 2);
  await page.screenshot({ path: "../output/playwright/collaboration-ux/responsive-discussion.png", fullPage: true });
});

test("Codex-bound shared Chat keeps discussion available without advertising Claude", async ({ page }) => {
  await mockShell(page, {
    status: "unavailable",
    effectiveSelection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
  });
  await page.goto(`/shared/chat/${scopeId}`, { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("button", { name: "Ask AI" })).toHaveCount(0);
  await expect(page.getByLabel("Message Chat")).toBeDisabled();
  await expect(page.getByLabel("Message Chat")).toHaveAttribute("placeholder", "AI is unavailable");
  await page.getByRole("button", { name: "Open discussion" }).click();
  const discussionLayer = page.getByRole("dialog", { name: "Discussion" });
  const discussion = discussionLayer.getByRole("textbox", { name: "Add a discussion note" });
  await expect(discussion).toBeEnabled();
  await discussion.fill("Human discussion remains available.");
  await expect(discussionLayer.getByRole("button", { name: "Post note" })).toBeEnabled();
  await expect(page.getByText(/Claude/i)).toHaveCount(0);
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.screenshot({
    path: "../output/playwright/collaboration-ux/immutable-codex-shared-ai-unavailable.png",
    fullPage: true,
  });
});

test("owner sees actionable Claude reconnect guidance while discussion stays available", async ({ page }) => {
  await mockShell(page, {
    status: "owner_reconnect_required",
    effectiveSelection: { instanceId: "claude_code_default", model: "opus" },
  });
  await page.goto(`/shared/chat/${scopeId}`, { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("button", { name: "Ask AI" })).toHaveCount(0);
  await expect(page.getByLabel("Message Chat")).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "Agents & providers" })).toHaveText(
    "Reconnect your Claude account or API key in Settings → Agents & providers to resume AI requests.",
  );
  await page.getByRole("button", { name: "Open discussion" }).click();
  const discussionLayer = page.getByRole("dialog", { name: "Discussion" });
  await expect(discussionLayer.getByRole("textbox", { name: "Add a discussion note" })).toBeEnabled();
  await page.getByRole("button", { name: "Close discussion panel" }).click();
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; } }" });
  await page.screenshot({
    path: "../specs/121-collaboration-session-sharing/evidence/owner-claude-reconnect-required.png",
    fullPage: true,
  });
});
