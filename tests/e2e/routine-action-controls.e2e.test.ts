import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser } from "playwright";
import { MATRIX_OS_LIGHT_THEME, MATRIX_OS_DARK_THEME } from "../../shell/src/lib/theme-presets";
import { chromeToSemanticVars } from "../../packages/brand/src/themes/desktop-theme";
import { getThemeChrome, DEFAULT_THEME_ID, FONT_OPTIONS, MONO_FONT_OPTIONS } from "../../packages/brand/src/themes/index";
import { DEFAULT_APPEARANCE } from "../../packages/brand/src/themes/preferences";
import { compileRoutineHostCss, hasRoutinePreFormatting, routineHosts, type RoutineHost } from "./fixtures/routine-action-host-css";

const root = resolve(__dirname, "../..");
const output = process.env.ROUTINE_ACTION_UI_OUTPUT ?? join(root, "output/playwright/routine-action-controls");
const localRequire = createRequire(join(root, "package.json"));
const { chromium } = createRequire(join(root, "packages/mcp-browser/package.json"))("playwright") as typeof import("playwright");
let browser: Browser, script: string;
let styles: Map<RoutineHost, Awaited<ReturnType<typeof compileRoutineHostCss>>>;
beforeAll(async () => {
  await mkdir(output, { recursive: true });
  const result = await build({ absWorkingDir: root, entryPoints: [join(root, "tests/e2e/fixtures/routine-action-controls.tsx")],
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    alias: { "@": join(root, "shell/src"), "@matrix-os/contracts": join(root, "packages/contracts/src/index.ts") },
    define: { "process.env.NODE_ENV": '"test"' }, plugins: [{ name: "offline-account-data-only", setup(builder) {
      builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: localRequire.resolve(args.path) }));
      builder.onResolve({ filter: /^@clerk\/nextjs$/ }, () => ({ path: "fixture-auth", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export function useAuth(){return {getToken:async()=>null,userId:"fixture-owner",sessionId:"fixture-session"}}', loader: "js" }));
      builder.onLoad({ filter: /shell\/src\/lib\/gateway\.ts$/ }, () => ({ contents: 'export function getGatewayUrl(){return location.origin}', loader: "js" }));
      builder.onResolve({ filter: /^@matrix-os\/ui$/ }, () => ({ path: join(root, "packages/ui/src/index.ts"), namespace: "fixture-ui-exports" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture-ui-exports" }, () => ({ resolveDir: root, loader: "js", contents: [
        `export { BrowserPermissionCard } from "./packages/ui/src/browser-permission/BrowserPermissionCard";`,
        `export { SupervisedToolApprovalCard } from "./packages/ui/src/chat/SupervisedToolApprovalCard";`,
        `export { RoutineActionConfirmation } from "./packages/ui/src/routine-action/RoutineActionConfirmation";`,
        `export { createRoutineActionBrowserClient } from "./packages/ui/src/routine-action/client";`,
      ].join("\n") }));
    } }] });
  script = result.outputFiles[0]!.text;
  styles = new Map(await Promise.all(routineHosts.map(async host => [host, await compileRoutineHostCss(host)] as const)));
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

it.each(routineHosts)("%s host source discovery generates the shared confirmation formatting", async host => {
  const current = styles.get(host)!;
  expect(current.css).toContain(`tailwindcss v${current.toolchain.nodeVersion} |`);
  expect(hasRoutinePreFormatting(current.componentCss), `${host} entrypoint must generate the shared pre-wrap formatting`).toBe(true);
  expect(current.componentDiscovered).toBe(true);
  const missingDeclaration = await compileRoutineHostCss(host, true);
  expect(missingDeclaration.componentDiscovered).toBe(false);
  expect(hasRoutinePreFormatting(missingDeclaration.componentCss)).toBe(false);
});

it.each(routineHosts.flatMap(host => ["light", "dark"].flatMap(mode => [320, 1024].map(width => ({ host, mode: mode as "light" | "dark", width })))))
  ("keeps $host controls styled and contained at $width px in $mode", async ({ host: renderer, mode, width }) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.route("**/*", route => route.abort());
    const hostStyle = styles.get(renderer)!;
    const webTheme = mode === "dark" ? MATRIX_OS_DARK_THEME : MATRIX_OS_LIGHT_THEME;
    const variables = renderer === "web" ? {
      ...Object.fromEntries(Object.entries(webTheme.colors).map(([key, value]) => [`--${key}`, value])),
      ...Object.fromEntries(Object.entries(webTheme.fonts).map(([key, value]) => [`--font-${key}`, value])), "--radius": webTheme.radius,
    } : { ...chromeToSemanticVars(getThemeChrome(DEFAULT_THEME_ID, mode), DEFAULT_THEME_ID),
      "--font-ui": FONT_OPTIONS.find(font => font.id === DEFAULT_APPEARANCE.fontId)!.family,
      "--font-mono": MONO_FONT_OPTIONS.find(font => font.id === DEFAULT_APPEARANCE.monoFontId)!.family };
    const vars = Object.entries(variables).map(([key, value]) => `${key}:${value}`).join(";");
    // Fixture-only document scrolling exposes every card; control/theme styles
    // themselves are the complete shipped host CSS, not a reconstructed subset.
    const html = `<!doctype html><html class="${mode === "dark" ? "dark" : ""}" data-theme="${mode}" data-theme-style="flat"><style>${hostStyle.css}:root{${vars}}html,body,#root{height:auto;min-height:100%;overflow:visible}</style><div id="root"></div></html>`;
    await page.route("http://localhost/__fixture-font/*", route => {
      const id = new URL(route.request().url()).pathname.split("/").at(-1)!, bytes = hostStyle.fonts.get(id);
      return bytes ? route.fulfill({ contentType: id.endsWith(".ttf") ? "font/ttf" : "font/woff2", body: bytes }) : route.abort();
    });
    await page.route("http://localhost/", route => route.fulfill({ contentType: "text/html", body: html }));
    const view = { challengeId: `rcact_${"a".repeat(32)}`, actionDigest: "d".repeat(64), sourceKind: "terminal_launch", operation: "pause",
      intent: { operation: "pause", requestId: "de000000-0000-4000-8000-000000000001", routineId: `rt_${"b".repeat(24)}`, baseRevision: 3 },
      target: { botId: "bot_fixture", chatId: "chat_fixture" }, sourceLabel: "Terminal fixture", expiresAt: "2099-01-01T00:00:00.000Z", status: "pending", title: "Allow routine pause?",
      description: "Allow this operation only. Routine activation, background model consent and integration permissions remain separate." };
    await page.route("http://localhost/api/routine-cli/actions/*", route => route.request().method() === "GET"
      ? route.fulfill({ contentType: "application/json", body: JSON.stringify(view) }) : route.abort());
    await page.goto("http://localhost/");
    await page.addScriptTag({ content: script });
    await page.locator('[data-fixture="owner"]').getByRole("button", { name: "Allow once", exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const loadedFonts = await page.evaluate(() => [...document.fonts].filter(font => font.status === "loaded").map(font => font.family));
    expect(loadedFonts.some(name => name.includes(renderer === "web" ? "Matrix Geist" : "Geist")), "actual shipped host font must load").toBe(true);
    const geometry: unknown[] = [];
    for (const surface of ["owner", "canonical", "native"] as const) {
      const host = page.locator(`[data-fixture="${surface}"]`);
      const primary = host.getByRole("button", { name: surface === "native" ? "Confirm in browser" : "Allow once", exact: true });
      await primary.waitFor();
      const metrics = await primary.evaluate(element => { const style = getComputedStyle(element), b = element.getBoundingClientRect(); return { height: b.height, background: style.backgroundColor, color: style.color, border: style.borderWidth, radius: style.borderRadius, padding: style.paddingLeft, verticalPadding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom), fontSize: parseFloat(style.fontSize), font: style.fontFamily }; });
      expect(metrics.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(metrics.background).not.toBe(metrics.color);
      // Incumbent host typography differs; both must retain full text plus py-2.
      expect(metrics.verticalPadding).toBeGreaterThanOrEqual(16);
      expect(metrics.height).toBeGreaterThanOrEqual(metrics.fontSize + metrics.verticalPadding);
      expect(parseFloat(metrics.radius)).toBeGreaterThanOrEqual(8);
      expect(parseFloat(metrics.padding)).toBeGreaterThanOrEqual(12);
      expect(await host.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      for (const control of await host.getByRole("button").all()) {
        const b = (await control.boundingBox())!; expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(width);
      }
      await primary.focus();
      expect(await primary.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe("none");
      geometry.push({ surface, ...metrics });
    }
    const owner = page.locator('[data-fixture="owner"]');
    await owner.getByRole("button", { name: "Allow once", exact: true }).focus();
    await page.keyboard.press("Tab"); expect(await owner.getByRole("button", { name: "Decline", exact: true }).evaluate(element => element === document.activeElement)).toBe(true);
    await page.keyboard.press("Shift+Tab"); expect(await owner.getByRole("button", { name: "Allow once", exact: true }).evaluate(element => element === document.activeElement)).toBe(true);
    expect(await page.locator('[data-fixture="settled"]').getByRole("button").count()).toBe(0);
    expect(await page.locator('[data-fixture="settled"]').getByText("Cancelled", { exact: true }).count()).toBe(1);
    expect(errors).toEqual([]);
    await page.screenshot({ path: join(output, `${renderer}-${mode}-${width}.png`), fullPage: true });
    await writeFile(join(output, `${renderer}-${mode}-${width}.json`), JSON.stringify({ renderer, mode, toolchain: hostStyle.toolchain, loadedFonts, scannedFiles: hostStyle.scannedFiles, geometry }, null, 2));
  } finally { await page.close(); }
});
