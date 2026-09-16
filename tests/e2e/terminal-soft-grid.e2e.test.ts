import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { chromium, _electron, type Browser, type ElectronApplication, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
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
    const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>body{margin:24px;background:#101310;color:#e5e7eb;font:14px system-ui}h1{font-size:16px;margin-bottom:16px}#terminal-window{border:1px solid #434e3f;border-radius:8px;overflow:hidden}</style><div id="root"></div><script src="/fixture.js"></script>`;
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
        executablePath: createRequire(resolve(root, "package.json"))("electron"),
        args: [resolve(__dirname, "fixtures/terminal-soft-resize-main.cjs")],
        env: { ...process.env, MATRIX_TERMINAL_FIXTURE_USER_DATA: userData,
          MATRIX_TERMINAL_FIXTURE_URL: `${origin}/?surface=electron` },
      });
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
        stageHeight: stage.offsetHeight, clientHeight: viewport.clientHeight,
        scale: xterm.style.transform, stageBottom: stage.getBoundingClientRect().bottom };
    });
  }

  it.each([
    { surface: "web", zoom: 1 }, { surface: "web", zoom: 0.75 }, { surface: "electron", zoom: 1 },
  ].filter((entry) => !nativeElectron || entry.surface === "electron"))("keeps the final row visible in $surface at zoom $zoom", async ({ surface, zoom }) => {
    const page = electron ? await electron.firstWindow() : await browser.newPage({ viewport: { width: 1450, height: 1050 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      if (!electron) await page.goto(`${origin}/?surface=${surface}&zoom=${zoom}`);
      await page.locator("[data-terminal-grid-stage]").waitFor();
      for (const height of [600, 300, 850]) {
        await page.locator("#terminal-window").evaluate((element, height) => { (element as HTMLElement).style.height = `${height}px`; }, height);
        await expect.poll(async () => { const g = await geometry(page); return g.bottom - g.visibleBottom; }, { timeout: 5_000 }).toBeLessThanOrEqual(1);
        const measured = await geometry(page);
        expect(measured.scrollHeight).toBeLessThanOrEqual(Math.max(measured.stageHeight, measured.clientHeight) + 1);
        if (height === 300) expect(measured.panTop).toBeGreaterThan(0);
        if (height === 850) expect(measured.scale).toBe("scale(1)");
        if (height === 600) {
          const point = await page.locator(".xterm-screen").evaluate((screen) => {
            const rect = screen.getBoundingClientRect();
            return { x: rect.left + rect.width / 120 * 5.5, y: rect.top + rect.height / 36 * 34.5 };
          });
          await page.mouse.move(point.x, point.y);
          await page.mouse.wheel(0, -100);
          await expect.poll(() => page.evaluate(() =>
            (window as unknown as { fixtureInputs: string[] }).fixtureInputs.some((data) => data.includes("\x1b[<64;6;35M")))).toBe(true);
        }
        await page.screenshot({ path: resolve(evidence, `${nativeElectron ? "native-" : ""}${surface}-${zoom}-${height}.png`) });
      }
      expect(errors).toEqual([]);
    } finally { if (!electron) await page.close(); }
  }, 30_000);
});
