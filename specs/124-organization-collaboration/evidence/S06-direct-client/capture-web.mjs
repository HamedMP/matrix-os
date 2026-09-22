// S06 (#1806) web evidence: "Shared with me" cards for metadata-only discovery items.
// Runs against the bypass shell dev server; every gateway/platform call is mocked by Playwright.
import { createRequire } from "node:module";
import fs from "node:fs";
// Run from a checkout of this branch with the bypass shell dev server up (see README):
//   S06_BASE=http://127.0.0.1:3006 S06_OUT=/tmp/s06-web node specs/124-organization-collaboration/evidence/S06-direct-client/capture-web.mjs
const require = createRequire(new URL("../../../../shell/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const OUT = process.env.S06_OUT ?? "output/s06-web";
const BASE = process.env.S06_BASE ?? "http://127.0.0.1:3006";
const ONLY_SURFACE = process.env.S06_SURFACE ?? null;
const ONLY_SCENARIO = process.env.S06_SCENARIO ?? null;
fs.mkdirSync(OUT, { recursive: true });

const ORG_ID = "org_2evidenceDemo";
const MACHINE_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_RUNTIME = "vps:22222222-2222-4222-8222-222222222222";
const OFFLINE_SCOPE = "40000000-0000-4000-8000-000000000001";
const DENIED_SCOPE = "40000000-0000-4000-8000-000000000002";
const ORG_SCOPE = "40000000-0000-4000-8000-000000000003";
const ORG_TERMINAL_SCOPE = "40000000-0000-4000-8000-000000000004";
const OFFLINE_INVITE_SCOPE = "40000000-0000-4000-8000-000000000005";
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

// Metadata-only discovery items exactly as the platform now serves them (no `resource`).
const base = (scopeId, kind) => ({ scopeId, runtimeId: OWNER_RUNTIME, ownerId: "user_trinity", kind, authorityGeneration: 1 });
const ITEMS = {
  // Accepted share whose home answers 503 on ticket issuance -> client marks home: "offline".
  offline: [
    { ...base(OFFLINE_SCOPE, "chat"), status: "accepted", organizationId: ORG_ID },
    { ...base(OFFLINE_INVITE_SCOPE, "project"), status: "invited", invitationId: "50000000-0000-4000-8000-000000000001", organizationId: ORG_ID },
  ],
  // Accepted share whose home answers 403 on ticket issuance -> client marks home: "denied".
  denied: [
    { ...base(DENIED_SCOPE, "terminal"), status: "accepted", organizationId: ORG_ID },
  ],
  // Organization-wide share this member has not opened yet -> rendered without hydration.
  "org-pending": [
    { ...base(ORG_SCOPE, "project"), status: "organization_pending", organizationId: ORG_ID },
    { ...base(ORG_TERMINAL_SCOPE, "chat"), status: "organization_pending", organizationId: ORG_ID },
  ],
};
ITEMS.all = [...ITEMS["org-pending"], ...ITEMS.offline, ...ITEMS.denied];
const CONNECTION_STATUS = { [OFFLINE_SCOPE]: 503, [OFFLINE_INVITE_SCOPE]: 503, [DENIED_SCOPE]: 403 };

const unmocked = new Set();
const connectionCalls = [];
async function mockGateway(context, scenario) {
  await context.route("**/api/**", (route) => { unmocked.add(`${route.request().method()} ${new URL(route.request().url()).pathname}`); return json(route, { error: "mock_missing" }, 404); });
  await context.route("**/api/settings/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    return json(route, pathname.endsWith("/onboarding-status") ? { complete: true }
      : pathname.endsWith("/agent") ? { identity: {}, kernel: { model: "claude-opus-4-6", effort: "high" }, availableModels: [{ id: "claude-opus-4-6", label: "Claude Opus 4.6", tier: "Most capable" }], availableEfforts: ["high"], defaults: { model: "claude-opus-4-6", effort: "high" }, contractVersion: 2, revision: 1, chat: { provider: "anthropic", model: "claude-opus-4-6", effort: "high", source: "saved", authKind: "platform" }, runtime: { selected: null, options: [], transition: null }, providers: [], currentSelection: { chat: { provider: "anthropic", model: "claude-opus-4-6", effort: "high", source: "saved", authKind: "platform" } } }
      : { background: { type: "pattern" }, dock: { position: "left", size: 56, iconSize: 40, autoHide: false }, pinnedApps: [], hasKey: true });
  });
  await context.route("**/api/identity", (route) => json(route, { handle: "test", displayName: "Test User" }));
  await context.route("**/api/apps**", (route) => json(route, []));
  await context.route("**/api/shell/bootstrap", (route) => json(route, { layout: { windows: [] }, apps: [], modules: [], icons: {} }));
  await context.route("**/api/layout", (route) => json(route, { ok: true }));
  await context.route("**/billing/status**", (route) => json(route, { access: { runtimeProxyAllowed: true }, trialOffer: null }));
  await context.route("**/api/chat-providers**", (route) => json(route, { revision: 1, instances: [] }));
  await context.route("**/api/chats?**", (route) => json(route, { items: [] }));
  await context.route("**/api/chats", (route) => json(route, { items: [] }));
  await context.route("**/api/chats/events**", (route) => route.abort());
  await context.route("**/api/terminal/preferences", (route) => json(route, { preferences: { shellThemeId: "light" } }));
  await context.route("**/api/auth/ws-token", (route) => json(route, { token: "terminal-e2e-token", expiresAt: Date.now() + 300_000 }));
  await context.route("**/api/terminal/workspaces**", (route) => json(route, { workspaces: [] }));
  await context.route("**/api/agents**", (route) => json(route, { agents: [] }));
  await context.route("**/api/chat-agents**", (route) => json(route, { agents: [] }));
  await context.route("**/api/workspace/projects**", (route) => json(route, { projects: [] }));
  await context.route("**/api/tasks**", (route) => json(route, { tasks: [] }));
  await context.route("**/api/github/status", (route) => json(route, { connected: false }));
  await context.route("**/api/integrations**", (route) => json(route, { integrations: [] }));
  await context.route("**/api/agents/credentials/status", (route) => json(route, { agents: [] }));
  await context.route("**/api/health", (route) => json(route, { ok: true, status: "ok" }));
  await context.route("**/api/system/info", (route) => json(route, { version: "0.0.0-evidence", runtime: { handle: "test", runtimeSlot: "primary", machineId: MACHINE_ID }, capabilities: { collaboration: true } }));
  // Platform discovery: metadata only. The direct client then asks the platform for a ticket per scope;
  // the mocked platform answers 503 (home unreachable) or 403 (denied) so hydration marks the item.
  await context.route("**/api/collaboration/inbox**", (route) => json(route, { items: [] }));
  await context.route("**/api/collaboration/shared**", (route) => json(route, { items: ITEMS[scenario] }));
  await context.route("**/api/collaboration/connections", (route) => {
    const body = route.request().postDataJSON();
    connectionCalls.push(`${body.scopeId}:${body.purpose}`);
    const status = CONNECTION_STATUS[body.scopeId] ?? 503;
    return json(route, { error: status === 403 ? "forbidden" : "host_offline" }, status);
  });
  await context.route("**/ws/**", (route) => route.abort());
  await context.route("**/relay/**", (route) => route.abort());
}

async function prepare(context, presentation) {
  await context.addInitScript((presentation) => {
    window.localStorage.setItem("matrix:getting-started:auto-opened:web:%2F", "1");
    window.localStorage.setItem("matrix:getting-started:auto-opened:web:%2Fshared", "1");
    if (presentation) window.localStorage.setItem("matrix-os-desktop-mode", JSON.stringify({ state: { mode: presentation, previousMode: "desktop" }, version: 0 }));
  }, presentation);
}

async function hideDevOverlay(page) {
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  // Clerk keyless-mode "Configure your application" prompt (dev-only tooling, not shell UI).
  await page.evaluate(() => {
    for (const node of document.querySelectorAll("body *")) {
      if (node.childElementCount === 0 && node.textContent?.trim() === "Configure your application") {
        let target = node;
        while (target.parentElement && target.parentElement !== document.body && getComputedStyle(target).position !== "fixed") target = target.parentElement;
        target.style.display = "none";
      }
    }
  });
}
async function shot(page, name) { await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/${name}.png` }); console.log("saved", name); }
async function dismissGettingStarted(page) {
  const panel = page.getByRole("dialog", { name: "Getting started" });
  if (await panel.count()) { await page.keyboard.press("Escape"); await page.waitForTimeout(300); }
}

const EXPECTED_TEXT = {
  offline: "The owner's computer is offline. Try again later.",
  denied: "Access is no longer available.",
  "org-pending": "Shared with your organization",
  all: "Shared with your organization",
};

async function capture(browser, surface, scenario) {
  const context = await browser.newContext({ viewport: surface.viewport, extraHTTPHeaders: { "x-matrix-platform-session": "platform" } });
  await prepare(context, surface.presentation);
  await mockGateway(context, scenario);
  const page = await context.newPage();
  page.on("pageerror", (error) => { if (!/Clerk/.test(error.message)) console.log("pageerror", error.message.slice(0, 200)); });
  try {
    await page.goto(`${BASE}/shared`, { waitUntil: "domcontentloaded", timeout: 240_000 });
    await page.getByRole("heading", { name: "Shared with me" }).first().waitFor({ timeout: 120_000 });
    await page.getByText(EXPECTED_TEXT[scenario]).first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1200);
    await dismissGettingStarted(page);
    await hideDevOverlay(page);
    const text = (await page.locator("main").filter({ hasText: "Shared with me" }).first().innerText().catch(() => "")).replace(/\s+/g, " ");
    console.log(surface.name, scenario, "cards:", text.slice(0, 400));
    await shot(page, `${surface.name}-${scenario}`);
    return true;
  } catch (error) {
    console.log("FAILED", surface.name, scenario, error.message.split("\n")[0]);
    await page.screenshot({ path: `${OUT}/failure-${surface.name}-${scenario}.png` })
      .catch((captureError) => console.warn("Failure screenshot unavailable", captureError instanceof Error ? captureError.name : "UnknownError"));
    console.log("body:", (await page.locator("body").innerText().catch(() => "")).slice(0, 400).replace(/\n+/g, " | "));
    return false;
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch();
const surfaces = [
  { name: "web-desktop", viewport: { width: 1440, height: 900 }, presentation: "desktop" },
  { name: "web-canvas", viewport: { width: 1440, height: 900 }, presentation: "canvas" },
  { name: "web-mobile", viewport: { width: 390, height: 844 }, presentation: null },
].filter((surface) => !ONLY_SURFACE || surface.name === ONLY_SURFACE);
const scenarios = ["org-pending", "offline", "denied", "all"].filter((scenario) => !ONLY_SCENARIO || scenario === ONLY_SCENARIO);
let failures = 0;
for (const surface of surfaces) for (const scenario of scenarios) {
  if (!await capture(browser, surface, scenario)) failures += 1;
}
console.log("connection calls:", connectionCalls.join(", ") || "none");
console.log("unmocked:", [...unmocked].join(", ") || "none");
await browser.close();
if (failures > 0) process.exitCode = 1;
