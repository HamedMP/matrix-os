import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser } from "playwright";
const root = resolve(__dirname, "../..");
const desktopRequire = createRequire(join(root, "desktop/package.json"));
const { chromium } = createRequire(join(root, "packages/mcp-browser/package.json"))("playwright") as typeof import("playwright");
let browser: Browser, script: string, css: string;
beforeAll(async () => {
  const result = await build({ absWorkingDir: root, entryPoints: ["tests/e2e/fixtures/chat-new-chat-scroll.tsx"], bundle: true, write: false,
    outfile: "entry.js", format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
    plugins: [{ name: "react-dedupe", setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: desktopRequire.resolve(args.path) }));
      builder.onResolve({ filter: /^react-dom(?:\/.*)?$/ }, args => ({ path: desktopRequire.resolve(args.path) }));
    } }] });
  script = result.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  const tw = await compile('@import "tailwindcss";', { base: root, onDependency() {} });
  css = tw.build(new Scanner({ sources: [{ base: join(root, "packages/ui/src/chat/new-chat"), pattern: "**/*.tsx", negated: false }] }).scan());
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
}, 30000);
afterAll(async () => { await browser?.close(); });

it("scrolls the new-Chat screen on a short phone so a tall composer's Send is reachable", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 480 } });
  await page.route("**/*", route => route.abort());
  await page.setContent(`<html><style>${css}body{margin:0}</style><div id="root"></div></html>`);
  await page.addScriptTag({ content: script });
  const send = page.getByRole("button", { name: "Send" });
  await send.waitFor();
  // Below the fold until the owner scrolls; a clipped root would leave it there.
  expect((await send.boundingBox())!.y).toBeGreaterThan(480);
  await page.mouse.move(195, 240);
  await page.mouse.wheel(0, 2000);
  await page.waitForFunction(() => {
    const box = [...document.querySelectorAll("button")].find(node => node.textContent === "Send")!.getBoundingClientRect();
    return box.bottom <= innerHeight && box.top >= 0;
  });
  // Click where the owner would, without Playwright's own scroll-into-view.
  const box = (await send.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => page.locator("#sent").textContent()).toBe("1");
  await page.close();
}, 30000);
