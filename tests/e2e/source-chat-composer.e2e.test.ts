import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser } from "playwright";

const root = resolve(__dirname, "../..");
const requireDesktop = createRequire(join(root, "desktop/package.json"));
const { chromium } = createRequire(join(root, "packages/mcp-browser/package.json"))("playwright") as typeof import("playwright");
const output = process.env.ROUTINE_LAYOUT_OUTPUT ?? join(root, "output/playwright/source-chat-composer");
let browser: Browser, script: string, css: string;

beforeAll(async () => {
  await mkdir(output, { recursive: true });
  const result = await build({ absWorkingDir: root, entryPoints: ["tests/e2e/fixtures/source-chat-composer.tsx"],
    bundle: true, write: false, outfile: join(output, "fixture.js"), format: "iife", platform: "browser", jsx: "automatic",
    alias: { "@": join(root, "shell/src"), "@clerk/nextjs": join(root, "tests/e2e/fixtures/source-chat-clerk.ts") },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" }, plugins: [{ name: "fixture-react-dedupe", setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: requireDesktop.resolve(args.path) }));
      builder.onResolve({ filter: /^react-dom(?:\/.*)?$/ }, args => ({ path: requireDesktop.resolve(args.path) }));
    } }] });
  script = result.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  const tailwind = await compile('@import "tailwindcss";', { base: root, onDependency() {} });
  css = tailwind.build(new Scanner({ sources: [
    { base: join(root, "packages/ui/src"), pattern: "**/*.{ts,tsx}", negated: false },
    { base: join(root, "shell/src"), pattern: "**/*.{ts,tsx}", negated: false },
  ] }).scan()) + result.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

// Regression: placing an expanded Persistent task grid in the non-shrinking
// model/access toolbar pushes its explanation, destination and Send off-screen.
it.each([480, 720, 1024].flatMap(width => ["available", "unset"].flatMap(destination => [false, true].map(empty => ({width, destination, empty})))))(
  "keeps Persistent task, $destination destination and Send inside a $width px Chat window (empty=$empty)", async ({width, destination, empty}) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  try {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => route.abort());
    await page.route("https://source-chat-layout.test/**", route => route.fulfill({ contentType: "text/html", body:
      `<!doctype html><html><style>${css}:root{--text-primary:#222;--text-secondary:#666;--text-tertiary:#777;--bg-surface:#fff;--bg-sunken:#eee;--border-subtle:#ddd}body{margin:0;font:14px Arial}#root{height:100vh;width:100%}</style><div id="root"></div></html>` }));
    await page.goto(`https://source-chat-layout.test/?destination=${destination}&empty=${empty}`);
    await page.addScriptTag({ content: script });
    const toggle = page.getByRole("button", { name: "Persistent task", exact: true });
    try { await toggle.waitFor({ timeout: 5000 }); }
    catch (error) { throw new Error(`Offline Chat fixture unavailable: ${JSON.stringify(errors)}; ${await page.locator("body").innerText()}`, { cause: error }); }
    const input = page.getByRole("textbox", { name: "Message chat" });
    await input.fill("Unsaved persistent reminder draft");
    await toggle.click();
    if (destination === "available") await page.getByText("Existing Bot destination selected.", { exact: true }).waitFor();
    else await page.getByRole("option", { name: "Existing private Bot with a very long name for this narrow Chat window", exact: true }).waitFor({state: "attached"});
    const geometry = await page.locator(".prompt-card").evaluate(card => {
      const bounds = card.getBoundingClientRect();
      return { x: bounds.x, right: bounds.right, overflow: card.scrollWidth > card.clientWidth + 1,
        children: [...card.querySelectorAll("button,p,select")].map(element => {
          const b = element.getBoundingClientRect();
          return { text: element.textContent, x: b.x, right: b.right, width: b.width };
        }).filter(element => element.width > 0) };
    });
    await page.screenshot({ path: join(output, `persistent-${destination}-${width}-${empty ? "empty" : "existing"}.png`) });
    expect(geometry.x).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(width + 1);
    expect(geometry.overflow).toBe(false);
    const send = page.getByRole("button", { name: "Send", exact: true });
    expect(await send.isVisible()).toBe(true);
    const sendBounds = await send.boundingBox();
    expect(sendBounds).not.toBeNull();
    expect(sendBounds!.width).toBeGreaterThan(0);
    expect(sendBounds!.height).toBe(28);
    for (const child of geometry.children) {
      expect(child.x, child.text ?? "control").toBeGreaterThanOrEqual(geometry.x);
      expect(child.right, child.text ?? "control").toBeLessThanOrEqual(geometry.right + 1);
    }
    expect(await input.inputValue()).toBe("Unsaved persistent reminder draft");
    expect(await toggle.getAttribute("aria-pressed")).toBe("true");
    await toggle.click();
    expect(await input.inputValue()).toBe("Unsaved persistent reminder draft");
    expect(await toggle.getAttribute("aria-pressed")).toBe("false");
  } finally { await page.close(); }
});
