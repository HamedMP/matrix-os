import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright";
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
  const resizeWindow = async (width: number) => {
    const contentWidth = await app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(width, 850);
      return window.getContentSize()[0];
    }, width);
    // Match the actual content area, excluding native window decorations.
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(contentWidth);
  };
  const hoverRow = async (row: Locator) => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    // Native resize/focus events can clear an injected hover after it returns.
    // Observe the actual pseudo-class before asserting the hover animation.
    await expect.poll(async () => {
      await row.hover();
      return row.evaluate(element => element.matches(":hover"));
    }).toBe(true);
  };
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
    const done = page.getByRole("button", { name: "Done", exact: true });
    if (await done.getAttribute("aria-expanded") === "false") await done.click();
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
  afterEach(async (context) => {
    if (context.task.result?.state !== "fail") return;
    try {
      await page.screenshot({ path: join(evidence, "failure.png"), timeout: 2_000 });
    } catch (error) {
      console.warn("Chat title failure evidence unavailable", error instanceof Error ? error.name : "UnknownError");
    }
  });
  it("scrolls overflowing history titles on hover/focus and keeps reduced motion quiet", async () => {
    const row = page.getByRole("button", { name: LONG_CHAT_TITLE, exact: true });
    await hoverRow(row);
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
    await expect.poll(() => title.evaluate(el => el.getAnimations().length)).toBe(1);
    const viewport = row.locator(".matrix-chat-title-viewport");
    const start = await viewport.boundingBox();
    await title.evaluate(el => { const animation = el.getAnimations()[0]; animation.pause(); animation.currentTime = 2000; });
    expect(await title.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m41)).toBeLessThan(0);
    expect(await viewport.boundingBox()).toEqual(start);
    await title.evaluate(el => el.getAnimations().forEach(animation => animation.cancel()));
    await page.mouse.move(0, 0);
    await row.focus();
    await expect.poll(() => title.evaluate(el => el.getAnimations().length)).toBe(1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => title.evaluate(el => el.getAnimations().length)).toBe(0);
    expect(await title.getAttribute("title")).toBe(LONG_CHAT_TITLE);
    await page.screenshot({ path: join(evidence, "history-reduced-motion.png") });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: no-preference)").matches)).toBe(true);
  });
  it("keeps short titles still and separates pinned unread/error indicators from long titles", async () => {
    const short = page.getByRole("button", { name: SHORT_CHAT_TITLE, exact: true });
    await hoverRow(short);
    expect(await short.locator("span[title]").evaluate(el => el.getAnimations().length)).toBe(0);
    const row = page.getByRole("button", { name: FAILED_CHAT_TITLE, exact: true });
    for (const width of [1280, 900]) {
      await resizeWindow(width);
      await hoverRow(row);
      const title = row.locator("span[title]");
      await expect.poll(() => title.evaluate(el => el.getAnimations().length)).toBe(1);
      const bounds = await row.evaluate(element => {
        const text = element.querySelector("span[title]")!;
        const viewport = element.querySelector(".matrix-chat-title-viewport")!;
        const unread = element.querySelector('[aria-label^="Unread "]')!;
        const error = element.querySelector('[aria-label^="Agent failed"]')!;
        const actions = element.parentElement!.querySelector('button[title^="Unpin "]')!;
        return { viewportRight: viewport.getBoundingClientRect().right,
          unreadLeft: unread.getBoundingClientRect().left, errorLeft: error.getBoundingClientRect().left,
          clipping: getComputedStyle(viewport).overflowX, actionLeft: actions.getBoundingClientRect().left };
      });
      expect(bounds.viewportRight).toBeLessThanOrEqual(bounds.unreadLeft);
      expect(bounds.viewportRight).toBeLessThanOrEqual(bounds.errorLeft);
      expect(bounds.viewportRight).toBeLessThanOrEqual(bounds.actionLeft);
      expect(bounds.clipping).toBe("hidden");
      await page.getByRole("button", { name: `Unpin ${FAILED_CHAT_TITLE}`, exact: true }).click({ trial: true });
      await page.getByRole("button", { name: `Actions for ${FAILED_CHAT_TITLE}`, exact: true }).click({ trial: true });
      await page.screenshot({ path: join(evidence, `history-${width}.png`) });
    }
  });
  it("contains the full stored title and keeps header actions reachable at both sizes", async () => {
    for (const width of [1280, 900]) {
      await resizeWindow(width);
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
