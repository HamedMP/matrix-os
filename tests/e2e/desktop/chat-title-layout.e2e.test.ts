import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startChatTitleGateway, LONG_CHAT_TITLE, SHORT_CHAT_TITLE, FAILED_CHAT_TITLE } from "./fixtures/chat-title-gateway";
import { closeElectronApp } from "./fixtures/close-electron";
const root = resolve(__dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const evidence = join(root, "output/mat524");
const requireDesktop = createRequire(join(root, "desktop/package.json"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !existsSync(main)) {
  throw new Error("Required Desktop build is missing");
}
const suite = existsSync(main) ? describe : describe.skip;
suite("long Chat titles in the built Electron header", () => {
  let app: ElectronApplication;
  let page: Page;
  let gateway: Awaited<ReturnType<typeof startChatTitleGateway>>;
  let profile: string;
  beforeAll(async () => {
    gateway = await startChatTitleGateway();
    profile = mkdtempSync(join(tmpdir(), "mat524-"));
    app = await _electron.launch({ executablePath: requireDesktop("electron") as string, args: [resolve(__dirname, "fixtures/canonical-input-electron.mjs")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile } });
    // Seed a synthetic local credential; never open browser authentication.
    const encrypted = await app.evaluate(async ({ app, safeStorage }) => {
      await app.whenReady();
      return Array.from(safeStorage.encryptString(JSON.stringify({ accessToken: "stub-token-1", expiresAt: Date.now() + 3_600_000, userId: "user-1", handle: "neo" })));
    });
    writeFileSync(join(profile, "credential.bin"), Buffer.from(encrypted));
    await closeElectronApp(app);
    app = await _electron.launch({ executablePath: requireDesktop("electron") as string,
      args: [resolve(__dirname, "fixtures/canonical-input-electron.mjs")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile } });
    page = await app.firstWindow(); page.setDefaultTimeout(8000);
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
  it("clips history titles and scrolls them on hover/focus, respecting reduced motion", async () => {
    const row = page.getByRole("button", { name: LONG_CHAT_TITLE, exact: true });
    await row.hover();
    const clipped = await row.evaluate((element) => {
      const title = element.querySelector("span[title]")!;
      let node: Element | null = title;
      while (node && node !== element) {
        const style = getComputedStyle(node);
        if (style.display !== "inline" && style.overflowX === "hidden" &&
          node.getBoundingClientRect().right <= element.getBoundingClientRect().right) return true;
        node = node.parentElement;
      }
      return false;
    });
    expect(clipped).toBe(true);
    const title = row.locator("span[title]");
    await expect.poll(() => title.evaluate(el => el.getAnimations().length)).toBeGreaterThan(0);
    const start = await title.evaluate(el => el.getBoundingClientRect().x);
    await expect.poll(() => title.evaluate(el => el.getBoundingClientRect().x)).toBeLessThan(start - 2);
    await page.mouse.move(0, 0);
    await row.focus();
    await expect.poll(() => title.evaluate(el => el.getAnimations().length)).toBeGreaterThan(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => title.evaluate(el => el.getAnimations().length)).toBe(0);
    expect(await title.getAttribute("title")).toBe(LONG_CHAT_TITLE);
    await page.screenshot({ path: join(evidence, "history-reduced-motion.png") });
    await page.emulateMedia({ reducedMotion: "no-preference" });
  });
  it("keeps short titles still and separates pinned unread/error indicators from long titles", async () => {
    const short = page.getByRole("button", { name: SHORT_CHAT_TITLE, exact: true });
    await short.hover();
    expect(await short.locator("span[title]").evaluate(el => el.getAnimations().length)).toBe(0);
    const row = page.getByRole("button", { name: FAILED_CHAT_TITLE, exact: true });
    for (const width of [1280, 900]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 850), width);
      await row.hover();
      const title = row.locator("span[title]");
      await expect.poll(() => title.evaluate(el => el.getAnimations().length)).toBeGreaterThan(0);
      const bounds = await row.evaluate(element => {
        const text = element.querySelector("span[title]")!;
        const viewport = text.parentElement!;
        const unread = element.querySelector('[aria-label^="Unread "]')!;
        const error = element.querySelector('[aria-label^="Agent failed"]')!;
        const animation = text.getAnimations()[0];
        animation.pause();
        animation.currentTime = Number(animation.effect!.getTiming().duration);
        const actions = element.parentElement!.querySelector('button[title^="Unpin "]')!;
        return { viewportRight: viewport.getBoundingClientRect().right,
          unreadLeft: unread.getBoundingClientRect().left, errorLeft: error.getBoundingClientRect().left,
          textRight: text.getBoundingClientRect().right, actionLeft: actions.getBoundingClientRect().left };
      });
      expect(bounds.viewportRight).toBeLessThanOrEqual(bounds.unreadLeft);
      expect(bounds.viewportRight).toBeLessThanOrEqual(bounds.errorLeft);
      expect(bounds.textRight).toBeLessThanOrEqual(Math.min(bounds.actionLeft, bounds.viewportRight) + 1);
      await page.getByRole("button", { name: `Unpin ${FAILED_CHAT_TITLE}`, exact: true }).click({ trial: true });
      await page.getByRole("button", { name: `Delete ${FAILED_CHAT_TITLE}`, exact: true }).click({ trial: true });
      await page.screenshot({ path: join(evidence, `history-${width}.png`) });
    }
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
