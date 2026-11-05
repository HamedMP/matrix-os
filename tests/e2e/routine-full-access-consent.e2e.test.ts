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
import { compileRoutineHostCss, routineHosts, type RoutineHost } from "./fixtures/routine-action-host-css";

const root = resolve(__dirname, "../.."), output = process.env.ROUTINE_FULL_ACCESS_UI_OUTPUT ?? join(root, "output/playwright/routine-full-access");
const localRequire = createRequire(join(root, "package.json"));
const { chromium } = createRequire(join(root, "packages/mcp-browser/package.json"))("playwright") as typeof import("playwright");
let browser: Browser, script: string, styles: Map<RoutineHost, Awaited<ReturnType<typeof compileRoutineHostCss>>>;
beforeAll(async () => {
  await mkdir(output, { recursive: true });
  const result = await build({ absWorkingDir: root, entryPoints: [join(root, "tests/e2e/fixtures/routine-full-access-consent.tsx")],
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    alias: { "@matrix-os/contracts": join(root, "packages/contracts/src/index.ts") }, define: { "process.env.NODE_ENV": '"test"' },
    plugins: [{ name: "one-react-runtime", setup(builder) { builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: localRequire.resolve(args.path) })); } }] });
  script = result.outputFiles[0]!.text;
  styles = new Map(await Promise.all(routineHosts.map(async host => [host, await compileRoutineHostCss(host)] as const)));
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

it.each(routineHosts.flatMap(host => ["light", "dark"].flatMap(mode => [320, 1024].map(width => ({ host, mode: mode as "light" | "dark", width })))))
  ("renders $host explicit consent and native fallback at $width px in $mode using shipped CSS", async ({ host, mode, width }) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.route("**/*", route => route.abort());
    const style = styles.get(host)!, webTheme = mode === "dark" ? MATRIX_OS_DARK_THEME : MATRIX_OS_LIGHT_THEME;
    const variables = host === "web" ? { ...Object.fromEntries(Object.entries(webTheme.colors).map(([key, value]) => [`--${key}`, value])),
      ...Object.fromEntries(Object.entries(webTheme.fonts).map(([key, value]) => [`--font-${key}`, value])), "--radius": webTheme.radius }
      : { ...chromeToSemanticVars(getThemeChrome(DEFAULT_THEME_ID, mode), DEFAULT_THEME_ID),
        "--font-ui": FONT_OPTIONS.find(font => font.id === DEFAULT_APPEARANCE.fontId)!.family,
        "--font-mono": MONO_FONT_OPTIONS.find(font => font.id === DEFAULT_APPEARANCE.monoFontId)!.family };
    const vars = Object.entries(variables).map(([key, value]) => `${key}:${value}`).join(";");
    await page.route("http://localhost/__fixture-font/*", route => {
      const name = new URL(route.request().url()).pathname.split("/").at(-1)!, bytes = style.fonts.get(name);
      return bytes ? route.fulfill({ contentType: name.endsWith(".ttf") ? "font/ttf" : "font/woff2", body: bytes }) : route.abort();
    });
    const html = `<!doctype html><html class="${mode === "dark" ? "dark" : ""}" data-theme="${mode}" data-theme-style="flat"><style>${style.css}:root{${vars}}html,body,#root{height:auto;min-height:100%;overflow:visible}</style><div id="root"></div></html>`;
    await page.route("http://localhost/", route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto("http://localhost/"); await page.addScriptTag({ content: script });
    const owner = page.locator('[data-fixture="owner"]'), unavailable = page.locator('[data-fixture="unavailable"]'), native = page.locator('[data-fixture="native"]');
    await owner.getByRole("button", { name: "Review routine CLI access", exact: true }).click();
    await unavailable.getByRole("button", { name: "Retry routine CLI access", exact: true }).click();
    const allow = owner.getByRole("button", { name: "Allow routine CLI in this private Chat", exact: true });
    await allow.waitFor(); await unavailable.getByRole("button", { name: "Allow routine CLI in this private Chat", exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const metrics: unknown[] = [];
    for (const region of [owner, unavailable, native]) {
      expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const primary = region.getByRole("button", { name: region === native ? "Continue in owner browser" : "Allow routine CLI in this private Chat", exact: true });
      const measured = await primary.evaluate(element => { const css = getComputedStyle(element), b = element.getBoundingClientRect(); return { height: b.height, background: css.backgroundColor, color: css.color, radius: css.borderRadius }; });
      expect(measured.height).toBeGreaterThanOrEqual(44); expect(measured.background).not.toBe("rgba(0, 0, 0, 0)"); expect(measured.background).not.toBe(measured.color);
      for (const button of await region.getByRole("button").all()) { const b = (await button.boundingBox())!; expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(width); }
      await primary.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
      expect(await primary.evaluate(element => element === document.activeElement && element.matches(":focus-visible") && getComputedStyle(element).boxShadow !== "none")).toBe(true); metrics.push(measured);
    }
    expect(await native.getByRole("button", { name: "Allow routine CLI in this private Chat" }).count()).toBe(0);
    expect(await native.getByText(/device's turns still require per-operation confirmation/).count()).toBe(1);
    expect(errors).toEqual([]);
    await page.screenshot({ path: join(output, `${host}-${mode}-${width}.png`), fullPage: true });
    await allow.click(); await owner.getByText("Saving routine CLI access…", { exact: true }).waitFor();
    expect(await owner.getByRole("button").evaluateAll(elements => elements.every(element => (element as HTMLButtonElement).disabled))).toBe(true);
    await writeFile(join(output, `${host}-${mode}-${width}.json`), JSON.stringify({ host, mode, width, toolchain: style.toolchain, metrics }, null, 2));
  } finally { await page.close(); }
});
