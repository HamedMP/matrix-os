import { expect, test, type Page, type Route } from "@playwright/test";

// Runs in the `platform-frame` project: the shell is started with
// MATRIX_SHELL_SURFACE=platform, as the platform auth shell is in production.
const scopeId = "10000000-0000-4000-8000-000000000001";
const terminalScopeId = "10000000-0000-4000-8000-000000000002";
const invitationId = "30000000-0000-4000-8000-000000000001";
const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const capabilities = {
  read: true, discuss: true, manageMembers: false, requestAi: false,
  observeTerminal: false, controlTerminal: false, stopTerminal: false,
};

// Personal-runtime, billing and gateway paths the account-only frame must never request.
const FORBIDDEN_PATHS = [
  /^\/api\/system\/info/, /^\/api\/journey/, /^\/api\/settings/, /^\/api\/layout/, /^\/api\/shell\//,
  /^\/api\/terminal/, /^\/api\/auth\/ws-token/, /^\/api\/auth\/provision-runtime/, /^\/billing\//,
  /^\/files\//, /^\/apps/, /^\/ws/, /^\/gateway\//, /^\/api\/apps/, /^\/api\/chats/,
];

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockCollaboration(page: Page, discovery: "items" | "empty" | "unavailable") {
  await page.route("**/api/collaboration/inbox**", (route) => discovery === "unavailable"
    ? fulfill(route, { error: "Collaboration unavailable" }, 503)
    : fulfill(route, { items: discovery === "empty" ? [] : [{
      scopeId: terminalScopeId,
      runtimeId,
      ownerId: "user_owner",
      kind: "terminal",
      authorityGeneration: 1,
      status: "invited",
      invitationId,
      resource: {
        id: invitationId,
        scopeId: terminalScopeId,
        owner: { actorId: "user_owner", displayName: "Nima" },
        target: { actorId: "user_e2e", displayName: "Ada" },
        scopeKind: "terminal",
        role: "viewer",
        status: "pending",
        expiresAt: "2026-10-19T12:00:00.000Z",
        revision: "2",
      },
    }] }));
  await page.route("**/api/collaboration/shared**", (route) => discovery === "unavailable"
    ? fulfill(route, { error: "Collaboration unavailable" }, 503)
    : fulfill(route, { items: discovery === "empty" ? [] : [{
      scopeId,
      runtimeId,
      ownerId: "user_owner",
      kind: "chat",
      authorityGeneration: 1,
      status: "accepted",
      resource: {
        scope: {
          id: scopeId, ownerId: "user_owner", kind: "chat", resourceId: "chat_launch_plan",
          membershipMode: "direct", lifecycle: "shared", revision: "4", authEpoch: "1",
          authorityGeneration: "1", role: "editor", capabilities,
        },
        chat: { id: "chat_launch_plan", scopeId, title: "Launch plan", lifecycle: "active", revision: "4", messageCount: "3" },
      },
    }] }));
  // The owner's computer is offline: ticket issuance answers 503.
  await page.route("**/api/collaboration/connections", (route) => fulfill(route, { error: "Collaboration unavailable" }, 503));
}

function recordForbiddenRequests(page: Page, baseURL: string | undefined): string[] {
  const origin = new URL(baseURL ?? "http://localhost").origin;
  const forbidden: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && FORBIDDEN_PATHS.some((pattern) => pattern.test(url.pathname))) forbidden.push(url.pathname);
  });
  return forbidden;
}

for (const viewport of [{ name: "phone", width: 390, height: 844 }, { name: "desktop", width: 1440, height: 900 }]) {
  test.describe(`account-only collaboration frame (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("opens Shared with me without the OS shell or billing", async ({ page, baseURL }, testInfo) => {
      const forbidden = recordForbiddenRequests(page, baseURL);
      await mockCollaboration(page, "items");

      await page.goto("/shared");

      await expect(page.getByRole("heading", { name: "Shared with me" })).toBeVisible();
      await expect(page.getByText("Launch plan")).toBeVisible();
      await expect(page.getByText("Nima invited you")).toBeVisible();
      await expect(page.getByText("Choose your plan")).toHaveCount(0);
      await expect(page.locator("[data-matrix-boot-sequence]")).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "Collaboration" }).filter({ visible: true })).toHaveCount(1);
      await page.screenshot({ path: testInfo.outputPath(`collaboration-frame-${viewport.name}.png`), fullPage: false });
      expect(forbidden).toEqual([]);
    });

    test("shows the empty state for an account with nothing shared", async ({ page, baseURL }, testInfo) => {
      const forbidden = recordForbiddenRequests(page, baseURL);
      await mockCollaboration(page, "empty");

      await page.goto("/shared");

      await expect(page.getByText("Nothing shared yet")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`collaboration-frame-empty-${viewport.name}.png`) });
      expect(forbidden).toEqual([]);
    });

    test("shows unavailable states without leaving the frame", async ({ page, baseURL }) => {
      const forbidden = recordForbiddenRequests(page, baseURL);
      await mockCollaboration(page, "unavailable");

      await page.goto("/shared");
      await expect(page.getByText("Shared items are unavailable")).toBeVisible();

      await mockCollaboration(page, "items");
      await page.goto(`/shared/chat/${scopeId}`);
      await expect(page.getByText("Shared Chat unavailable")).toBeVisible();
      await expect(page.locator("[data-matrix-collaboration-frame]")).toBeVisible();
      expect(forbidden).toEqual([]);
    });
  });
}
