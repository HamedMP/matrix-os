import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startChatTitleGateway, LONG_CHAT_TITLE } from "./fixtures/chat-title-gateway";
import { closeElectronApp } from "./fixtures/close-electron";
const root = resolve(__dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const evidence = join(root, "output/mat524");
const requireDesktop = createRequire(join(root, "desktop/package.json"));
const suite = existsSync(main) ? describe : describe.skip;
suite("long Chat titles in the built Electron header", () => {
  let app: ElectronApplication;
  let page: Page;
  let gateway: Awaited<ReturnType<typeof startChatTitleGateway>>;
  let profile: string;
  beforeAll(async () => {
    gateway = await startChatTitleGateway();
    profile = mkdtempSync(join(tmpdir(), "mat524-"));
    app = await _electron.launch({ executablePath: requireDesktop("electron") as string, args: [main],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile } });
    page = await app.firstWindow(); page.setDefaultTimeout(8000);
    await page.getByRole("button", { name: /continue in browser/i }).click();
    await page.getByRole("button", { name: "Chat", exact: true }).dblclick();
    await page.getByRole("button", { name: LONG_CHAT_TITLE, exact: true }).click();
    await page.getByRole("button", { name: `Rename ${LONG_CHAT_TITLE}`, exact: true }).waitFor();
    if (await page.getByRole("dialog", { name: "Getting started", exact: true }).isVisible()) {
      await page.getByRole("button", { name: /Getting started/ }).click();
      await page.getByRole("dialog", { name: "Getting started", exact: true }).waitFor({ state: "hidden" });
    }
    await page.getByRole("button", { name: "Maximize", exact: true }).click();
    mkdirSync(evidence, { recursive: true });
  }, 60000);
  afterAll(async () => {
    try { if (app) await closeElectronApp(app); } finally { await gateway?.close(); if (profile) rmSync(profile, { recursive: true, force: true }); }
  });
  it("contains the full stored title and keeps header actions reachable at both sizes", async () => {
    for (const width of [1280, 900]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 850), width);
      const button = page.getByRole("button", { name: `Rename ${LONG_CHAT_TITLE}`, exact: true });
      await page.screenshot({ path: join(evidence, `header-${width}.png`) });
      const bounds = await button.evaluate((element) => {
        const grid = element.closest('[data-testid="os-window-chrome-grid"]')!;
        const actions = grid.querySelector('[data-os-window-actions]');
        const rect = element.getBoundingClientRect();
        return { right: rect.right, gridRight: grid.getBoundingClientRect().right,
          actionLeft: actions?.getBoundingClientRect().left, viewportWidth: window.innerWidth,
          clipped: element.scrollWidth > element.clientWidth };
      });
      expect(bounds.right).toBeLessThanOrEqual(bounds.gridRight);
      expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
      expect(bounds.clipped).toBe(true);
      expect(bounds.actionLeft).toBeDefined();
      expect(bounds.right).toBeLessThanOrEqual(bounds.actionLeft!);
      await page.getByRole("button", { name: "Share", exact: true }).click({ trial: true });
      expect(await button.getAttribute("title")).toBe(LONG_CHAT_TITLE);
    }
    expect(gateway.getTitle()).toBe(LONG_CHAT_TITLE);
  });
  it("preserves rename commit, cancel and persisted projection", async () => {
    const button = page.getByRole("button", { name: `Rename ${LONG_CHAT_TITLE}`, exact: true });
    await button.click();
    const editor = page.getByRole("textbox", { name: `Rename ${LONG_CHAT_TITLE}`, exact: true });
    await editor.fill("Cancelled rename"); await editor.press("Escape");
    expect(gateway.getTitle()).toBe(LONG_CHAT_TITLE);
    await button.click(); await editor.fill("Renamed title"); await editor.press("Enter");
    await page.getByRole("button", { name: "Rename Renamed title", exact: true }).waitFor();
    expect(gateway.getTitle()).toBe("Renamed title");
    await page.reload();
    await page.getByRole("button", { name: "Chat", exact: true }).dblclick();
    await page.getByRole("button", { name: "Renamed title", exact: true }).click();
    await page.getByRole("button", { name: "Rename Renamed title", exact: true }).waitFor();
    await page.screenshot({ path: join(evidence, "renamed-reloaded.png") });
  });
  it("contains unbroken English and emoji titles without changing their stored values", async () => {
    let current = "Renamed title";
    for (const title of ["x".repeat(160), "👩🏽‍💻".repeat(20)]) {
      await page.getByRole("button", { name: `Rename ${current}`, exact: true }).click();
      const editor = page.getByRole("textbox", { name: `Rename ${current}`, exact: true });
      const inputBounds = await editor.evaluate((element) => ({ right: element.getBoundingClientRect().right,
        parentRight: element.closest('[data-testid="os-window-chrome-grid"]')!.getBoundingClientRect().right }));
      expect(inputBounds.right).toBeLessThanOrEqual(inputBounds.parentRight);
      await editor.fill(title); await editor.press("Enter");
      const button = page.getByRole("button", { name: `Rename ${title}`, exact: true });
      await button.waitFor();
      const fits = await button.evaluate((element) => element.getBoundingClientRect().right <=
        element.closest('[data-testid="os-window-chrome-grid"]')!.getBoundingClientRect().right);
      expect(fits).toBe(true);
      expect(gateway.getTitle()).toBe(title);
      current = title;
    }
  });

});
