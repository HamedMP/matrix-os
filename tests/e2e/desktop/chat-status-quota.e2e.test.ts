import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { closeElectronApp } from "./fixtures/close-electron";
import { startChatStatusQuotaGateway, STATUS_CHAT_TITLE, STATUS_MODEL, LONG_STATUS_MODEL } from "./fixtures/chat-status-quota-gateway";

const root = resolve(__dirname, "../../..");
const built = existsSync(join(root, "desktop/out/main/index.js"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !built) throw new Error("Required Electron Desktop build missing");
const suite = built ? describe : describe.skip;
const evidence = process.env.MATRIX_STATUS_QUOTA_EVIDENCE_DIR ?? join(root, "output/eng203");

suite("Chat quota and status in actual Electron Desktop (synthetic gateway)", () => {
  let app: ElectronApplication, page: Page, profile: string;
  let gateway: Awaited<ReturnType<typeof startChatStatusQuotaGateway>>;
  const launch = () => _electron.launch({ executablePath: createRequire(join(root, "desktop/package.json"))("electron") as string,
    args: [resolve(__dirname, "fixtures/canonical-input-electron.mjs")],
    env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile } });
  beforeAll(async () => {
    await mkdir(evidence, { recursive: true });
    gateway = await startChatStatusQuotaGateway();
    profile = await mkdtemp(join(tmpdir(), "eng203-ui-"));
    app = await launch();
    const encrypted = await app.evaluate(async ({ app, safeStorage }) => {
      await app.whenReady();
      return safeStorage.encryptString(JSON.stringify({ accessToken: "stub-token-1", expiresAt: Date.now() + 3_600_000, userId: "user-1", handle: "neo" })).toString("base64");
    });
    await writeFile(join(profile, "credential.bin"), Buffer.from(encrypted, "base64"));
    await closeElectronApp(app); app = await launch(); page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
    const version = await page.evaluate(() => window.operator.invoke("app:get-version", {}));
    const electron = await app.evaluate(() => process.versions.electron);
    await writeFile(join(evidence, "client-provenance.json"), JSON.stringify({ version, electron, backend: "loopback synthetic UI fixture" }, null, 2));
  }, 60_000);
  afterAll(async () => {
    try { if (page && !page.isClosed()) await page.screenshot({ path: join(evidence, "last-state.png") }); }
    finally { try { if (app) await closeElectronApp(app); }
      finally { try { await gateway?.close(); } finally { if (profile) await rm(profile, { recursive: true, force: true }); } } }
  });
  async function openChat() {
    await page.getByRole("button", { name: "Chat", exact: true }).first().dblclick();
    try { await page.getByRole("button", { name: STATUS_CHAT_TITLE, exact: true }).click(); }
    catch (error) { console.warn("[status-ui] Chat state:", await page.locator("body").innerText()); throw error; }
    const checklist = page.getByRole("button", { name: /^Getting started —/ });
    if (await checklist.getAttribute("aria-expanded") === "true") await checklist.click();
  }
  async function openSettings() {
    await page.getByRole("button", { name: "Open account menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Agents & providers", exact: true }).click();
    const row = page.locator(".matrix-ap-rail-item").filter({ hasText: "Codex" }).first();
    if (await row.getAttribute("aria-expanded") !== "true") await row.click();
    await page.getByText("Synthetic ChatGPT account", { exact: true }).first().waitFor();
  }
  it("keeps the model row below its divider and readable at narrow widths", async () => {
    await openChat();
    const modelRow = page.getByRole("button", { name: `Working: Current model: ${STATUS_MODEL}`, exact: true });
    await modelRow.waitFor();
    const geometry = await modelRow.evaluate(row => {
      const body = row.closest("[data-agent-message-body]")!;
      const receipt = body.querySelector('[data-slot="marker"][data-variant="border"]')!;
      return { gap: row.getBoundingClientRect().top - receipt.getBoundingClientRect().bottom,
        overflow: row.scrollWidth > row.clientWidth + 1, spinner: Boolean(row.querySelector(".animate-spin")) };
    });
    expect(geometry.gap).toBeGreaterThanOrEqual(8);
    expect(geometry.overflow).toBe(false);
    expect(geometry.spinner).toBe(true);
    await page.screenshot({ path: join(evidence, "working-model.png") });
    await modelRow.locator("xpath=ancestor::*[@data-agent-message-body]").screenshot({ path: join(evidence, "working-model-detail.png") });
    gateway.setModel(LONG_STATUS_MODEL); await page.reload(); await openChat();
    await page.getByRole("button", { name: "Maximize", exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setMinimumSize(480, 400); window.setSize(600, 700); });
    const longRow = page.getByRole("button", { name: `Working: Current model: ${LONG_STATUS_MODEL}`, exact: true });
    await longRow.waitFor();
    const layout = await longRow.evaluate(row => ({ width: row.getBoundingClientRect().width,
      overflow: row.scrollWidth > row.clientWidth + 1,
      bodyOverflow: row.closest("[data-agent-message-body]")!.scrollWidth > row.closest("[data-agent-message-body]")!.clientWidth + 1,
      gap: row.getBoundingClientRect().top - row.closest("[data-agent-message-body]")!.querySelector('[data-slot="marker"][data-variant="border"]')!.getBoundingClientRect().bottom,
      title: row.querySelector("[title]")?.getAttribute("title") }));
    expect(layout.width).toBeGreaterThan(100);
    expect(layout.overflow).toBe(false);
    expect(layout.bodyOverflow).toBe(false);
    expect(layout.gap).toBeGreaterThanOrEqual(8);
    expect(layout.title).toBe(`Current model: ${LONG_STATUS_MODEL}`);
    await page.screenshot({ path: join(evidence, "working-model-narrow.png") });
    await writeFile(join(evidence, "status-geometry.json"), JSON.stringify({ geometry, layout }, null, 2));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 900));
    gateway.setCompleted(); await page.reload(); await openChat();
    const worked = page.getByRole("button", { name: /Worked for/ });
    await worked.waitFor();
    if (await worked.getAttribute("aria-expanded") === "false") await worked.click();
    await page.getByRole("button", { name: "Checked files", exact: true }).waitFor();
    await worked.click();
    expect(await page.getByRole("button", { name: "Checked files", exact: true }).count()).toBe(0);
    await worked.click();
    await page.getByRole("button", { name: "Checked files", exact: true }).waitFor();
  });
  it("shows remaining subscription capacity and matching meter values", async () => {
    await page.reload(); await openSettings();
    const card = page.locator(".matrix-ap-connected");
    await card.getByText("29% left", { exact: true }).waitFor();
    const meter = card.getByRole("progressbar");
    expect(await meter.getAttribute("value")).toBe("2900");
    expect(await meter.getAttribute("aria-valuetext")).toBe("29% remaining");
    expect(await card.getByText("Resets Oct 14, 2026", { exact: true }).count()).toBe(1);
    await page.screenshot({ path: join(evidence, "remaining-allowance.png") });
    await card.screenshot({ path: join(evidence, "remaining-allowance-detail.png") });
    for (const [used, remaining] of [[0, 100], [10000, 0], [7050, 30]]) {
      gateway.setUsedBasisPoints(used); await page.reload(); await openSettings();
      await card.getByText(`${remaining}% left`, { exact: true }).waitFor();
      expect(await card.getByRole("progressbar").getAttribute("value")).toBe(String(10000 - used));
      expect(await card.getByRole("progressbar").getAttribute("aria-valuetext")).toBe(`${remaining}% remaining`);
    }
  });
  it.skipIf(process.env.MATRIX_STATUS_QUOTA_REVIEW !== "1")("opens a Human Review window", async () => {
    await openSettings();
    console.log("ENG-203 Human Review window is open. Quit this Electron app when finished to clean up the synthetic environment.");
    await new Promise<void>(resolve => app.once("close", resolve));
  }, 43_200_000);
});
