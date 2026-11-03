import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createCanonicalProviderCatalogFixture } from "../../../tests/contracts/fixtures/canonical-chat.js";

const evidence = resolve(__dirname, "../../../docs/pr-evidence/536/l10");
const at = "2026-09-28T12:00:00.000Z";
const chatId = "chat_research";
const agentId = "bot_research1";
const record = { chat: { id: chatId, ownerScope: { type: "personal", ownerId: "owner_fixture" },
  title: "Research Rabbit", titleVersion: 1, lifecycle: "active", attention: "none", revision: 1, messageCount: 0,
  createdAt: at, updatedAt: at } };
const agent = { id: agentId, name: "Research Rabbit", description: "Watch competitors", instructions: "Research carefully.",
  selection: { instanceId: "matrix_bot", model: "default" }, recipeRef: { recipeId: "competitor-watching", version: "2026-09-27.1" },
  revision: 1, archived: false, createdAt: at, updatedAt: at };
const recipe = { recipeId: "competitor-watching", version: "2026-09-27.1", name: "Competitor Watch",
  description: "Watches competitors and writes a sourced brief.", output: "A competitor brief" };
const authority = { agentId, revision: 2,
  grants: [{ grantId: "gr_abcdefgh", service: "gmail", accountLabel: "Work", effects: ["read"], audience: "direct", expiresAt: null }],
  connections: [{ service: "gmail", state: "granted" }], routines: [], pendingInteractions: [],
  memory: { items: [{ itemId: "mem_abcdefgh", kind: "preference", scope: "bot", content: "Keep briefs concise",
    source: { messageId: "msg_abcdefgh", at }, confirmed: true, revision: 1 }] } };

function fulfill(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

function agentProviderCatalog() {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  catalog.drivers.push({
    kind: "matrix_pi",
    displayName: "Matrix AI",
    adapterVersion: "1.0.0",
    capabilityClass: "system_agent",
  });
  catalog.instances.push({
    ...base,
    id: "matrix_pi_default",
    driverKind: "matrix_pi",
    displayName: "Matrix AI",
    connectionLabel: "Matrix AI",
    models: [{ ...base.models[0]!, id: "claude-sonnet-5", displayName: "Claude Sonnet 5" }],
    defaultSelection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" },
    supports: { ...base.supports, interactionModes: ["default"], permissionModes: ["full_access"] },
  });
  return catalog;
}

async function mockBotShell(page: Page, current: { kind: "question" | "connect_request" }) {
  const catalogReads = { count: 0 };
  let failCatalogRefresh = false;
  await page.setExtraHTTPHeaders({ "x-matrix-platform-session": "platform" });
  await page.addInitScript(() => {
    window.localStorage.setItem(`matrix:getting-started:auto-opened:web:${encodeURIComponent(window.location.pathname)}`, "1");
  });
  await page.route("**/api/settings/**", (route) => fulfill(route, new URL(route.request().url()).pathname.endsWith("/onboarding-status")
    ? { complete: true } : { background: { type: "pattern" }, dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
      pinnedApps: [], hasKey: true }));
  await page.route("**/api/identity", (route) => fulfill(route, { handle: "test", displayName: "Test User" }));
  await page.route("**/api/apps**", (route) => fulfill(route, []));
  await page.route("**/api/shell/bootstrap", (route) => fulfill(route, { layout: { windows: [] }, apps: [], modules: [], icons: {} }));
  await page.route("**/api/layout", (route) => fulfill(route, { ok: true }));
  await page.route("**/billing/status**", (route) => fulfill(route, { access: { runtimeProxyAllowed: false }, trialOffer: null }));
  await page.route("**/api/chat-providers**", (route) => {
    catalogReads.count += 1;
    if (failCatalogRefresh) return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    return fulfill(route, agentProviderCatalog());
  });
  await page.route("**/api/chats?**", (route) => fulfill(route, { items: [record] }));
  await page.route(`**/api/chats/${chatId}?**`, (route) => fulfill(route, { record, messages: [], turns: [], runs: [], activities: [] }));
  await page.route("**/api/chats/events**", (route) => route.abort());
  await page.route(`**/api/chats/${chatId}/bot?**`, (route) => fulfill(route, { agentId }));
  await page.route(`**/api/chats/${chatId}/bot-tasks?**`, (route) => fulfill(route, { tasks: [{ taskId: "task_abcdefgh", chatId, agentId,
    status: "waiting_person", revision: 1, updatedAt: at }] }));
  await page.route(`**/api/chats/${chatId}/interactions?**`, (route) => fulfill(route, { interactions: [{ interactionId: "in_abcdefgh",
    chatId, agentId, taskId: "task_abcdefgh", kind: current.kind, blocking: true, status: "pending",
    expiresAt: "2099-01-01T00:00:00.000Z", revision: 1, payload: current.kind === "question"
      ? { kind: "question", questions: [{ questionId: "target", header: "Target", question: "Which company should I watch?" }] }
      : { kind: "connect_request", service: "gmail", access: ["read"], benefit: "I can read the latest competitor updates in your inbox.", connectRequestId: "cr_abcdefgh" } }] }));
  await page.route(`**/api/chat-agents/${agentId}/authority`, (route) => fulfill(route, authority));
  await page.route("**/api/chat-agents/bot-recipes", (route) => fulfill(route, { recipes: [recipe] }));
  await page.route("**/api/chat-agents/recipe-catalog", (route) => fulfill(route, { enabled: false, skills: [], services: [] }));
  await page.route("**/api/chat-agents?**", (route) => fulfill(route, { enabled: true, agents: [agent] }));
  await page.route("**/api/integrations", (route) => fulfill(route, []));
  await page.route("**/ws/**", (route) => route.abort());
  return { catalogReads, failNextCatalogRefresh: () => { failCatalogRefresh = true; } };
}

async function openChatShell(page: Page) {
  await page.keyboard.press("Meta+k");
  await page.locator('[data-slot="command-input"]').fill("Chat");
  await page.getByRole("group", { name: "Apps" }).getByRole("option", { name: /Chat/ }).click();
  await expect(page.getByRole("button", { name: "Choose model and connection" })).toBeVisible();
}

async function openChat(page: Page) {
  await openChatShell(page);
  await expect(page.getByRole("button", { name: "Show bot authority" })).toBeVisible();
}

for (const surface of ["web-desktop", "web-canvas"] as const) {
  test(`L10 bot controls on ${surface}`, async ({ page }) => {
    test.setTimeout(240_000);
    mkdirSync(evidence, { recursive: true });
    const current: { kind: "question" | "connect_request" } = { kind: "question" };
    await mockBotShell(page, current);
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible({ timeout: 45_000 });
    // The fixture deliberately has no gateway socket; keep its unrelated status toast out of bot evidence.
    await page.addStyleTag({ content: '[aria-label="Matrix connection status"] { display: none !important; }' });
    if (surface === "web-canvas") {
      await page.keyboard.press("Meta+k");
      await page.locator('[data-slot="command-input"]').fill("Mode: Canvas");
      await page.getByRole("option", { name: /Mode: Canvas/ }).click();
    }
    await openChat(page);
    await expect(page.getByText("Which company should I watch?")).toBeVisible();
    await page.screenshot({ path: resolve(evidence, `${surface}-question.png`) });
    await page.getByRole("button", { name: "Show bot authority" }).click();
    await page.getByText("Keep briefs concise").scrollIntoViewIfNeeded();
    await expect(page.getByText("Keep briefs concise")).toBeVisible();
    await page.screenshot({ path: resolve(evidence, `${surface}-authority-memory.png`) });
    await page.getByRole("button", { name: "Show bot authority" }).click();
    current.kind = "connect_request";
    await page.getByText("I can read the latest competitor updates in your inbox.").scrollIntoViewIfNeeded({ timeout: 30_000 });
    await expect(page.getByText("I can read the latest competitor updates in your inbox.")).toBeVisible();
    await page.screenshot({ path: resolve(evidence, `${surface}-connect.png`) });
    await page.getByRole("button", { name: "Browse agent recipes" }).click();
    await expect(page.getByRole("button", { name: "Use Competitor Watch" })).toBeVisible();
    await page.screenshot({ path: resolve(evidence, `${surface}-creation.png`) });
  });
}

for (const surface of ["web-desktop", "web-canvas"] as const) {
  test(`ENG-407 reuses warm model discovery on ${surface}`, async ({ page }) => {
    test.setTimeout(240_000);
    const output = resolve(tmpdir(), "matrix-os-pr-evidence/eng-407");
    mkdirSync(output, { recursive: true });
    const { catalogReads, failNextCatalogRefresh } = await mockBotShell(page, { kind: "question" });
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible({ timeout: 45_000 });
    await page.addStyleTag({ content: '[aria-label="Matrix connection status"] { display: none !important; }' });
    if (surface === "web-canvas") {
      await page.keyboard.press("Meta+k");
      await page.locator('[data-slot="command-input"]').fill("Mode: Canvas");
      await page.getByRole("option", { name: /Mode: Canvas/ }).click();
    }
    await openChatShell(page);
    failNextCatalogRefresh();
    const readsBeforeFailure = catalogReads.count;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => catalogReads.count).toBeGreaterThan(readsBeforeFailure);
    const readsBeforeAgents = catalogReads.count;
    await page.getByRole("button", { name: "Add new agent" }).click({ force: true });
    const startFromScratch = page.getByRole("button", { name: "Start from scratch" });
    await expect(startFromScratch).toBeEnabled();
    await expect.poll(() => catalogReads.count).toBe(readsBeforeAgents);
    await startFromScratch.click();
    const model = page.getByRole("combobox", { name: "Model" });
    await expect(model).toBeEnabled();
    await page.screenshot({ path: resolve(output, `${surface}-warm-agent-models.png`) });
    const readsBeforeSettingsChange = catalogReads.count;
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("matrix:provider-settings-changed")));
    await expect.poll(() => catalogReads.count).toBeGreaterThan(readsBeforeSettingsChange);
    await expect(model).toBeDisabled();
    await page.screenshot({ path: resolve(output, `${surface}-settings-suspended-agent-models.png`) });
  });
}
