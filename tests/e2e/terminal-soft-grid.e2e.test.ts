import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import type { Browser, ElectronApplication, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
// Resolve the declared workspace dependency, matching the CI installer.
const { chromium, _electron } = createRequire(resolve(root, "packages/mcp-browser/package.json"))("playwright") as typeof import("playwright");
const evidence = resolve(root, "output/playwright/terminal-soft-resize");
const nativeElectron = process.env.MATRIX_GRID_ELECTRON === "1";

describe("real terminal renderer soft-grid resizing", () => {
  let server: Server;
  let browser: Browser;
  let electron: ElectronApplication | undefined;
  let userData: string | undefined;
  let origin: string;
  beforeAll(async () => {
    const compiled = await build({
      absWorkingDir: root, entryPoints: ["tests/e2e/fixtures/terminal-soft-resize.tsx"],
      bundle: true, write: false, outdir: "out", format: "iife", platform: "browser", jsx: "automatic",
      alias: { "@": resolve(root, "shell/src"),
        "@matrix-os/observability/client": resolve(root, "packages/observability/src/client.ts") },
      define: { "process.env": "{}", "process.env.NODE_ENV": '"development"',
        __CODING_AGENTS_DESKTOP_WORKSPACE__: "true" },
      loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" },
      logLevel: "silent",
    });
    const javascript = compiled.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
    const css = compiled.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
    const tailwind = await compile('@import "tailwindcss";', { base: root, onDependency() {} });
    const candidates = new Scanner({ sources: [
      { base: resolve(root, "shell/src/components/terminal"), pattern: "**/*.tsx", negated: false },
      { base: resolve(root, "desktop/src/renderer/src/features/terminal"), pattern: "**/*.tsx", negated: false },
      { base: resolve(root, "packages/ui/src/terminal"), pattern: "**/*.tsx", negated: false },
    ] }).scan();
    const utilities = tailwind.build(candidates);
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>body{margin:24px;background:#101310;color:#e5e7eb;font:14px system-ui}h1{font-size:16px;margin-bottom:16px}#terminal-window{border:1px solid #434e3f;border-radius:8px;overflow:hidden}</style><div id="root"></div><script src="/fixture.js"></script>`;
    server = createServer((request, response) => {
      const path = new URL(request.url!, "http://localhost").pathname;
      if (path === "/fixture.js") { response.setHeader("content-type", "text/javascript"); response.end(javascript); }
      else if (path === "/fixture.css") { response.setHeader("content-type", "text/css"); response.end(utilities + css); }
      else if (path === "/api/auth/ws-token") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ token: "synthetic", expiresAt: Date.now() + 300_000 })); }
      else if (path.startsWith("/api/")) { response.setHeader("content-type", "application/json"); response.end('{"preferences":{}}'); }
      else { response.setHeader("content-type", "text/html"); response.end(html); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (nativeElectron) {
      userData = await mkdtemp(resolve(tmpdir(), "matrix-terminal-grid-"));
      electron = await _electron.launch({
        executablePath: createRequire(resolve(root, "desktop/package.json"))("electron"),
        args: [resolve(__dirname, "fixtures/terminal-soft-resize-main.cjs")],
        env: { ...process.env, MATRIX_TERMINAL_FIXTURE_USER_DATA: userData,
          MATRIX_TERMINAL_FIXTURE_URL: `${origin}/?surface=electron` },
      });
      await (await electron.firstWindow()).locator(".xterm-screen").waitFor();
    } else browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
    await mkdir(evidence, { recursive: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await electron?.close();
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (userData) await rm(userData, { recursive: true, force: true });
  });

  async function geometry(page: Page) {
    return page.locator("[data-terminal-viewport]").evaluate((host) => {
      const viewport = host as HTMLElement;
      const stage = viewport.querySelector<HTMLElement>("[data-terminal-grid-stage]")!;
      const screen = viewport.querySelector<HTMLElement>(".xterm-screen")!;
      const xterm = viewport.querySelector<HTMLElement>(".xterm")!;
      const outer = viewport.getBoundingClientRect();
      const content = screen.getBoundingClientRect();
      return { bottom: content.bottom, visibleBottom: outer.bottom,
        panTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight,
        stageHeight: stage.offsetHeight, screenHeight: screen.offsetHeight, clientHeight: viewport.clientHeight,
        scale: xterm.style.transform, stageBottom: stage.getBoundingClientRect().bottom };
    });
  }

  it.each([
    { surface: "web", zoom: 1 }, { surface: "web", zoom: 0.75 }, { surface: "electron", zoom: 1 },
  ].filter((entry) => !nativeElectron || entry.surface === "electron"))("wires native history polling and drag in $surface at $zoom", async ({ surface, zoom }) => {
    const page = electron ? await electron.firstWindow() : await browser.newPage({ viewport: { width: 1450, height: 1050 } });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    try {
      if (electron) await page.locator("#terminal-window").waitFor();
      await page.goto(`${origin}/?surface=${surface}&zoom=${zoom}&nativeScroll=1`);
      const rail = page.locator('[data-terminal-scrollbar="content"]');
      await expect.poll(() => rail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      const bottom = await rail.evaluate((element) => element.scrollTop);
      await page.evaluate(() => (window as any).fixtureNativeWheel());
      await expect.poll(() => rail.evaluate((element) => element.scrollTop)).toBeLessThan(bottom / 2);
      await rail.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
      await expect.poll(() => page.evaluate(() => (window as any).fixtureScrollFrames.some((f: any) => f.type === "scroll-to" && f.line === 0))).toBe(true);
      await page.evaluate(() => (window as any).fixtureObserve());
      const seeks = await page.evaluate(() => (window as any).fixtureScrollFrames.filter((f: any) => f.type === "scroll-to").length);
      await rail.evaluate((element) => { element.scrollTop = 200; element.dispatchEvent(new Event("scroll")); });
      await page.waitForTimeout(600);
      expect(await page.evaluate(() => (window as any).fixtureScrollFrames.filter((f: any) => f.type === "scroll-to").length)).toBe(seeks);
      await page.screenshot({ path: resolve(evidence, `native-history-${surface}-${zoom}.png`), fullPage: true });
      await page.evaluate(() => (window as any).fixtureUnmount());
      const count = await page.evaluate(() => (window as any).fixtureScrollFrames.length);
      await page.waitForTimeout(600);
      expect(await page.evaluate(() => (window as any).fixtureScrollFrames.length)).toBe(count);
      expect(errors).toEqual([]);
    } finally {
      if (!electron) await page.close();
      else await page.goto(`${origin}/?surface=electron`);
    }
  });

  it.each([
    { surface: "web", name: "Web Desktop", zoom: 1 },
    { surface: "web", name: "Web Canvas", zoom: 0.75 },
    { surface: "electron", name: "Electron Desktop", zoom: 1 },
  ].filter((entry) => !nativeElectron || entry.surface === "electron"))("fills the writable viewport with real rows and columns in $name", async ({ surface, zoom }) => {
    const page = electron ? await electron.firstWindow() : await browser.newPage({ viewport: { width: 1700, height: 1200 } });
    try {
      await page.goto(`${origin}/?surface=${surface}&zoom=${zoom}&sizing=viewport`);
      await page.locator(".xterm-screen").waitFor();
      for (const [width, height] of [[1100, 850], [750, 420], [1500, 1000]]) {
        await page.locator("#terminal-window").evaluate((element, size) => {
          Object.assign((element as HTMLElement).style, { width: `${size[0]}px`, height: `${size[1]}px` });
        }, [width, height]);
        await expect.poll(() => page.locator("[data-terminal-viewport]").evaluate((host) => {
          const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
          const style = getComputedStyle(host);
          const grid = (window as unknown as { fixtureGrid: { cols: number; rows: number } }).fixtureGrid;
          const availableWidth = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          const availableHeight = host.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
          return { width: availableWidth - screen.offsetWidth, height: availableHeight - screen.offsetHeight,
            cols: grid.cols, rows: grid.rows, font: host.querySelector(".xterm")?.getAttribute("style"),
            proposals: (window as unknown as { fixtureProposals: unknown[] }).fixtureProposals.slice(-2),
            fills: availableWidth - screen.offsetWidth < screen.offsetWidth / grid.cols + 16
            && availableHeight - screen.offsetHeight < screen.offsetHeight / grid.rows + 1
            && screen.offsetWidth <= availableWidth && screen.offsetHeight <= availableHeight };
        }), { timeout: 5000 }).toMatchObject({ fills: true });
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.screenshot({ fullPage: true, path: resolve(evidence, `${nativeElectron ? "native-" : ""}${surface}-${zoom}-fill-${width}.png`) });
      }
      const grid = await page.evaluate(() => (window as unknown as { fixtureGrid: { cols: number; rows: number } }).fixtureGrid);
      expect(grid.cols).toBeGreaterThan(120);
      expect(grid.rows).toBeGreaterThan(36);
      // The writer still forwards native application mouse reports after resizing.
      await page.evaluate(() => (window as unknown as { fixtureOutput(data: string): void })
        .fixtureOutput("\x1b[?1000h\x1b[?1006h"));
      const point = await page.locator(".xterm-screen").evaluate((screen) => {
        const box = screen.getBoundingClientRect();
        return { x: box.left + 40, y: box.top + 40 };
      });
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(0, -100);
      await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureInputs: string[] })
        .fixtureInputs.some((input) => /\x1b\[<64;/.test(input)))).toBe(true);
    } finally { if (!electron) await page.close(); }
  });

  it.each([
    { surface: "web", name: "Web Desktop", zoom: 1 }, { surface: "web", name: "Web Canvas", zoom: 0.75 },
    { surface: "electron", name: "Electron Desktop", zoom: 1 },
    { surface: "web-mobile", name: "Web Mobile", zoom: 1 },
  ].filter((entry) => !nativeElectron || entry.surface === "electron"))("keeps the final row visible in $name at zoom $zoom", async ({ surface, zoom }) => {
    const page = electron ? await electron.firstWindow() : await browser.newPage({ viewport: { width: surface === "web-mobile" ? 430 : 1450, height: 1050 },
      isMobile: surface === "web-mobile", hasTouch: surface === "web-mobile" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${origin}/?surface=${surface}&zoom=${zoom}`);
      await page.locator("[data-terminal-grid-stage]").waitFor();
      for (const height of [600, 300, 850]) {
        await page.locator("#terminal-window").evaluate((element, height) => { (element as HTMLElement).style.height = `${height}px`; }, height);
        await expect.poll(async () => { const g = await geometry(page); return g.bottom - g.visibleBottom; }, { timeout: 5_000 }).toBeLessThanOrEqual(1);
        const measured = await geometry(page);
        expect(measured.scrollHeight).toBeLessThanOrEqual(Math.max(measured.stageHeight, measured.clientHeight) + 1);
        if (height === 300) {
          expect(measured.panTop).toBeGreaterThan(0);
          const box = await page.locator("[data-terminal-viewport]").boundingBox();
          if (!box) throw new Error("Terminal viewport is not measurable");
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          // Mouse reporting is enabled in the fixture, as it is for Zellij.
          // Pixel wheel gestures must still expose both ends of a clipped grid.
          await page.mouse.wheel(0, -2_000);
          await expect.poll(async () => (await geometry(page)).panTop).toBe(0);
          await page.mouse.wheel(0, 2_000);
          await expect.poll(async () => { const g = await geometry(page); return g.scrollHeight - g.clientHeight - g.panTop; })
            .toBeLessThanOrEqual(1);
        }
        if (height === 850) expect(measured.scale).toBe("scale(1)");
        if (height === 600) {
          const point = await page.locator(".xterm-screen").evaluate((screen) => {
            const rect = screen.getBoundingClientRect();
            return { x: rect.left + rect.width / 120 * 5.5, y: rect.top + rect.height / 36 * 34.5 };
          });
          await page.mouse.move(point.x, point.y);
          await page.mouse.wheel(0, -100);
          await expect.poll(() => page.evaluate(() =>
            (window as unknown as { fixtureInputs: string[] }).fixtureInputs.some((data) => data.includes("\x1b[<64;6;35M")))).toBe(false);
        }
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.screenshot({ fullPage: true, path: resolve(evidence, `${nativeElectron ? "native-" : ""}${surface}-${zoom}-${height}.png`) });
      }
      // Output can arrive after the resize has settled, moving a previously
      // visible cursor below the short viewport without another ResizeObserver.
      await page.evaluate(() => (window as unknown as { fixtureOutput: (data: string) => void }).fixtureOutput("\x1b[2J\x1b[Hwaiting"));
      await page.waitForTimeout(100);
      await page.locator("#terminal-window").evaluate((element) => { (element as HTMLElement).style.height = "300px"; });
      await expect.poll(async () => (await geometry(page)).panTop).toBe(0);
      await page.waitForTimeout(250);
      await page.evaluate(() => (window as unknown as { fixtureOutput: (data: string) => void }).fixtureOutput("\r\n".repeat(35) + "LATE-OUTPUT-VISIBLE$ "));
      await expect.poll(async () => { const g = await geometry(page); return g.bottom - g.visibleBottom; }).toBeLessThanOrEqual(1);
      await page.evaluate(() => (window as unknown as { fixtureOutput: (data: string) => void }).fixtureOutput("\x1b[Htop prompt"));
      await expect.poll(async () => (await geometry(page)).panTop).toBe(0);
      const panBox = await page.locator("[data-terminal-viewport]").boundingBox();
      if (!panBox) throw new Error("Terminal viewport is not measurable");
      await page.mouse.move(panBox.x + panBox.width / 2, panBox.y + panBox.height / 2);
      await page.mouse.wheel(0, 2_000);
      await expect.poll(async () => { const g = await geometry(page); return g.scrollHeight - g.clientHeight - g.panTop; }).toBeLessThanOrEqual(1);
      await page.evaluate(() => (window as unknown as { fixtureOutput: (data: string) => void }).fixtureOutput("\x1b[Hredrawn prompt"));
      await page.waitForTimeout(100);
      expect((await geometry(page)).panTop).toBeGreaterThan(0);
      // Native browser selection defaults must stay suppressed when xterm
      // cancels a forwarded event, including a double click with no movement.
      const shortGridHeight = (await geometry(page)).screenHeight;
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
          writeText: async (text: string) => { document.body.dataset.copied = text; },
        } });
        const windowElement = document.getElementById("terminal-window")!;
        windowElement.style.width = "1600px";
        windowElement.style.height = "1200px";
        (window as unknown as { fixtureOutput: (data: string) => void })
          .fixtureOutput("\x1bcDOUBLECLICK prefix targetword suffix");
      });
      await expect.poll(async () => (await geometry(page)).screenHeight).toBeGreaterThan(shortGridHeight);
      await expect.poll(async () => (await geometry(page)).scale).toBe("scale(1)");
      // Font metrics differ between Chromium and native Electron hosts. Derive
      // a small shrink from the restored grid, above the readable font floor.
      await page.locator("#terminal-window").evaluate((element) => {
        const windowElement = element as HTMLElement;
        const host = element.querySelector<HTMLElement>("[data-terminal-viewport]")!;
        const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
        const style = getComputedStyle(host);
        const horizontalChrome = windowElement.clientWidth - host.clientWidth
          + Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
        const verticalChrome = windowElement.clientHeight - host.clientHeight
          + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
        windowElement.style.width = `${screen.offsetWidth + horizontalChrome + 32}px`;
        windowElement.style.height = `${screen.offsetHeight * 0.97 + verticalChrome}px`;
      });
      await expect.poll(async () => (await geometry(page)).panTop).toBe(0);
      await expect.poll(async () => (await geometry(page)).scale).not.toBe("scale(1)");
      const word = await page.locator(".xterm-screen").evaluate((screen) => {
        const rect = screen.getBoundingClientRect();
        return { x: rect.left + rect.width / 120 * 22.5, y: rect.top + rect.height / 36 * 0.5 };
      });
      await page.mouse.dblclick(word.x, word.y);
      await page.keyboard.press("Control+Shift+C");
      await expect.poll(() => page.locator("body").getAttribute("data-copied")).toBe("targetword");
      await page.locator("#terminal-window").evaluate((element, width) => {
        const windowElement = element as HTMLElement;
        windowElement.style.width = `${width}px`;
        windowElement.style.height = "850px";
      }, surface === "web-mobile" ? 360 : 1_100);
      await expect.poll(async () => (await geometry(page)).scale).toBe("scale(1)");
      // Wheel input in the unused right-hand viewport must reach xterm even
      // when content clipping leaves no canvas under the pointer.
      await page.evaluate(() => {
        (window as unknown as { fixtureInputs: string[] }).fixtureInputs.length = 0;
        (window as unknown as { fixtureOutput: (data: string) => void }).fixtureOutput("\x1b[?1000h\x1b[?1006h");
      });
      const blankArea = await page.locator("[data-terminal-viewport]").boundingBox();
      if (!blankArea) throw new Error("Terminal viewport is not measurable");
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      await page.mouse.click(blankArea.x + blankArea.width - 40, blankArea.y + 80);
      await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea"))).toBe(true);
      await page.mouse.move(blankArea.x + blankArea.width - 40, blankArea.y + 80);
      await page.mouse.wheel(0, -200);
      await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureInputs: string[] }).fixtureInputs.some((input) => /\x1b\[<64;/.test(input)))).toBe(false);
      // A short normal shell must not pan across unused canonical-grid space.
      await page.locator("#terminal-window").evaluate((element) => { (element as HTMLElement).style.height = "300px"; });
      await page.evaluate(() => (window as unknown as { fixtureOutput: (data: string) => void }).fixtureOutput("\x1bcshort\r\nresult\r\n$ "));
      await expect.poll(async () => page.locator("[data-terminal-viewport]").evaluate((host) =>
        host.scrollHeight - host.clientHeight + host.scrollWidth - host.clientWidth)).toBe(0);
      // The clipped grid is larger than its short content. Browser focus and
      // scrollIntoView must never pan this internal layer behind the host rail.
      const internalPan = await page.locator("[data-terminal-grid-stage]").evaluate((stage) => {
        stage.scrollLeft = 100;
        stage.scrollTop = 100;
        return { left: stage.scrollLeft, top: stage.scrollTop };
      });
      expect(internalPan).toEqual({ left: 0, top: 0 });
      const rail = page.locator('[data-terminal-scrollbar="content"]');
      await expect.poll(() => rail.isVisible()).toBe(false);
      // History and clipped live rows use this same edge-aligned rail.
      await page.evaluate(() => (window as unknown as { fixtureOutput: (data: string) => void }).fixtureOutput("\x1bc" + Array.from({ length: 80 }, (_, i) => `HISTORY_${i}\r\n`).join("")));
      await expect.poll(() => rail.isVisible()).toBe(true);
      expect(await rail.count()).toBe(1);
      // Wait for the initial history write to follow the bottom before dragging.
      // Setting scrollTop to zero while it is already zero is not a gesture.
      await expect.poll(() => rail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect(await page.locator(".xterm .scrollbar.vertical").isVisible()).toBe(false);
      await rail.evaluate((element) => { element.scrollTop = 0; });
      await expect.poll(async () => (await geometry(page)).panTop).toBe(0);
      await rail.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect.poll(async () => { const g = await geometry(page); return g.scrollHeight - g.clientHeight - g.panTop; }).toBeLessThanOrEqual(1);
      await page.evaluate(() => (window as unknown as { fixtureObserve: () => void }).fixtureObserve());
      await expect.poll(() => page.getByText("Live on another device.").isVisible()).toBe(true);
      await expect.poll(() => page.getByRole("button", { name: "Continue here" }).isVisible()).toBe(true);
      const actionBox = await page.getByRole("button", { name: "Continue here" }).boundingBox();
      if (!actionBox) throw new Error("Continue here action is not measurable");
      expect(actionBox.x).toBeGreaterThanOrEqual(0);
      const viewportWidth = page.viewportSize()?.width ?? await page.evaluate(() => window.innerWidth);
      expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(viewportWidth);
      await page.screenshot({
        path: resolve(evidence, `${nativeElectron ? "native-" : ""}${surface}-${zoom}-observer.png`),
      });
      expect(errors).toEqual([]);
    } finally { if (!electron) await page.close(); }
  }, 30_000);
});
