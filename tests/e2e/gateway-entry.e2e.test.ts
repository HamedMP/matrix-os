import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
const root = resolve(__dirname, "../..");
const desktopRequire = createRequire(join(root, "desktop/package.json"));
const { chromium } = createRequire(join(root, "packages/mcp-browser/package.json"))("playwright") as typeof import("playwright");
const output = join(root, "output/playwright/gateway-entry-1024");
let browser: Browser, script: string, css: string;
beforeAll(async () => {
  await mkdir(output, { recursive: true });
  const result = await build({ absWorkingDir: root, entryPoints: ["tests/e2e/fixtures/gateway-entry.tsx"], bundle: true, write: false,
    outfile: join(output, "entry.js"), format: "iife", platform: "browser", jsx: "automatic", loader: { ".png": "dataurl" },
    alias: { "@renderer": join(root, "desktop/src/renderer/src"), "@": join(root, "shell/src") }, define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
    plugins: [{ name: "react-dedupe", setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: desktopRequire.resolve(args.path) }));
      builder.onResolve({ filter: /^react-dom(?:\/.*)?$/ }, args => ({ path: desktopRequire.resolve(args.path) }));
    } }] });
  script = result.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  const tw = await compile('@import "tailwindcss";', { base: root, onDependency() {} });
  css = tw.build(new Scanner({ sources: [
    { base: join(root, "desktop/src/renderer/src"), pattern: "**/*.{ts,tsx}", negated: false },
    { base: join(root, "packages/ui/src"), pattern: "**/*.{ts,tsx}", negated: false },
  ] }).scan()) + result.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
}, 30000);
afterAll(async () => { await browser?.close(); });
async function fixture(height = 800, surface = "electron"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1100, height }, recordVideo: { dir: output } });
  await page.route("**/*", route => route.abort());
  await page.setContent(`<html data-surface="${surface}"><style>${css}:root{--bg-overlay:#fff;--border-default:#ddd;--text-primary:#183c2c;--text-secondary:#657061;--text-tertiary:#76806f;--bg-hover:#eef0ed}body{margin:30px;background:#f8f9f5;font:14px Arial}</style><div id="root"></div></html>`);
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: /^Choose model and (provider|connection)$/ }).click();
  return page;
}
async function state(page: Page, value: string) {
  await page.evaluate(next => (window as unknown as { setGatewayFixtureState: (value: string) => void }).setGatewayFixtureState(next), value);
  await page.waitForFunction(next => document.querySelector("#gateway-state")?.textContent === next, value);
  await paint(page);
}
async function paint(page: Page) {
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}
it.each(["electron", "web"])("keeps the %s Matrix SVG press target through catalog refresh until release", async surface => {
  const page = await fixture(800, surface);
  try {
    await page.getByRole("button", { name: /^Hermes agent,/ }).click();
    await paint(page);
    const matrix = page.getByRole("button", { name: /^Matrix AI agent,/ });
    const before = (await matrix.boundingBox())!;
    const mark = (await matrix.locator("svg").elementHandle())!;
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await state(page, "refresh");
    const after = (await matrix.boundingBox())!;
    await page.mouse.up(); await paint(page);
    const pressed = await matrix.getAttribute("aria-pressed");
    await writeFile(join(output, `${surface}-pointer-catalog-refresh.json`), JSON.stringify({ before, after, pressed, markRetained: await mark.evaluate(node => node.isConnected) }, null, 2));
    await page.screenshot({ path: join(output, `${surface}-pointer-catalog-refresh.png`) });
    expect(pressed).toBe("true");
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
    expect(await page.locator("#gateway-selection").textContent()).toBe("codex_fixture:gpt-5.6-sol");
  } finally { const video = page.video(); await page.close(); if (video) await rename(await video.path(), join(output, `${surface}-entry-${expect.getState().currentTestName?.includes("SVG") ? "pointer" : expect.getState().currentTestName?.includes("slow") ? "recovery" : "credit"}.webm`)); }
});

it.each(["electron", "web"])("opens %s Matrix during slow loading and recovers missing or failed model inventory without changing selection", async surface => {
  const page = await fixture(800, surface);
  try {
    const matrix = page.getByRole("button", { name: /^Matrix AI agent,/ });
    for (const next of ["loading", "missing", "failed", "ready"]) {
      await state(page, next);
      for (let click = 0; click < 3; click++) { await matrix.click(); expect(await matrix.getAttribute("aria-pressed")).toBe("true"); }
      const rows = page.getByRole("listbox", { name: "Models and connections" }).getByRole("option");
      expect(await rows.count()).toBe(next === "missing" ? 0 : 9);
      if (next === "loading" || next === "failed") expect(await rows.evaluateAll(nodes => nodes.every(node => (node as HTMLButtonElement).disabled))).toBe(true);
      if (next === "ready") expect(await rows.evaluateAll(nodes => nodes.every(node => !(node as HTMLButtonElement).disabled))).toBe(true);
      expect(await page.locator("#gateway-selection").textContent()).toBe("codex_fixture:gpt-5.6-sol");
      expect(await page.locator("#gateway-actions").textContent()).toBe("0");
    }
    await page.screenshot({ path: join(output, `${surface}-recovered-entry.png`) });
  } finally { const video = page.video(); await page.close(); if (video) await rename(await video.path(), join(output, `${surface}-entry-${expect.getState().currentTestName?.includes("SVG") ? "pointer" : expect.getState().currentTestName?.includes("slow") ? "recovery" : "credit"}.webm`)); }
});

it.each(["electron", "web"])("preserves the %s chosen model on reopen while credit restrictions still block selection", async surface => {
  const page = await fixture(800, surface);
  try {
    await page.getByRole("button", { name: /^Matrix AI agent,/ }).click();
    await page.getByRole("option", { name: "Matrix model 4 via Matrix AI", exact: true }).click();
    expect(await page.locator("#gateway-selection").textContent()).toBe("matrix_pi_default:matrix-3");
    const trigger = page.getByRole("button", { name: /^Choose model and (provider|connection)$/ });
    await trigger.click();
    const saved = page.getByRole("option", { name: "Matrix model 4 via Matrix AI", exact: true });
    expect(await saved.getAttribute("aria-selected")).toBe("true");
    await state(page, "blocked");
    const matrix = page.getByRole("button", { name: /^Matrix AI agent,/ });
    await matrix.click();
    expect(await matrix.getAttribute("aria-pressed")).toBe("true");
    expect(await saved.isDisabled()).toBe(true);
    const bounds = (await saved.boundingBox())!;
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await paint(page);
    expect(await page.locator("#gateway-actions").textContent()).toBe("1");
    expect(await page.locator("#gateway-selection").textContent()).toBe("matrix_pi_default:matrix-3");
    await page.screenshot({ path: join(output, `${surface}-blocked-selection.png`) });
    await state(page, "ready");
    expect(await saved.isEnabled()).toBe(true);
    expect(await saved.getAttribute("aria-selected")).toBe("true");
  } finally { const video = page.video(); await page.close(); if (video) await rename(await video.path(), join(output, `${surface}-entry-${expect.getState().currentTestName?.includes("SVG") ? "pointer" : expect.getState().currentTestName?.includes("slow") ? "recovery" : "credit"}.webm`)); }
});
