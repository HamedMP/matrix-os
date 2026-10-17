import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
const root = resolve(__dirname, "../..");
const desktopRequire = createRequire(join(root, "desktop/package.json"));
const { chromium } = createRequire(join(root, "packages/mcp-browser/package.json"))("playwright") as typeof import("playwright");
const output = join(root, "output/playwright/eng265-chat-bot-layout");
let browser: Browser, script: string, css: string;
beforeAll(async () => {
  await mkdir(output, { recursive: true });
  const result = await build({ absWorkingDir: root, entryPoints: ["tests/e2e/fixtures/chat-bot-layout.tsx"], bundle: true, write: false, outfile: join(output, "fixture.js"),
    format: "iife", platform: "browser", jsx: "automatic", alias: { "@renderer": join(root, "desktop/src/renderer/src"), "@": join(root, "shell/src") },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" }, plugins: [{ name: "fixture-react-dedupe", setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: desktopRequire.resolve(args.path) }));
      builder.onResolve({ filter: /^react-dom(?:\/.*)?$/ }, args => ({ path: desktopRequire.resolve(args.path) }));
    } }] });
  script = result.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  const tailwind = await compile('@import "tailwindcss";', { base: root, onDependency() {} });
  css = tailwind.build(new Scanner({ sources: [
    { base: join(root, "desktop/src/renderer/src"), pattern: "**/*.{ts,tsx}", negated: false },
    { base: join(root, "packages/ui/src"), pattern: "**/*.{ts,tsx}", negated: false },
    { base: join(root, "shell/src"), pattern: "**/*.{ts,tsx}", negated: false },
    { base: join(root, "tests/e2e/fixtures"), pattern: "chat-bot-layout.tsx", negated: false },
  ] }).scan()) + result.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });
async function fixture(width: number, surface = "electron"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.route("**/*", route => route.abort());
  const html = `<!doctype html><html data-surface="${surface}"><style>${css}:root{--bg-surface:#fff;--bg-sunken:#eef0ed;--bg-hover:#eef0ed;--text-primary:#183c2c;--text-secondary:#657061;--text-tertiary:#76806f;--border-subtle:#dce0d9;--border-default:#dce0d9;--border-xsoft:#e7eae3;--accent:#294d38;--radius-xl:16px}body{font:14px Arial;margin:16px}#fixture-column{max-width:100%}</style><div id="root"></div></html>`;
  if (surface === "web") {
    // Web API clients require an origin. Fulfill only this synthetic document
    // in memory; every API, image, font or other request stays aborted.
    await page.route("http://matrix-layout.test/", route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto("http://matrix-layout.test/");
  } else await page.setContent(html);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addScriptTag({ content: script });
  try { await page.getByRole("button", { name: "Choose bot agent and model" }).waitFor({ timeout: 5000 }); }
  catch (error) { await page.close(); throw new Error(`Offline fixture did not mount: ${JSON.stringify(errors)}`, { cause: error }); }
  await page.locator("#fixture-column").evaluate((element, width) => { (element as HTMLElement).style.width = `${width}px`; }, width);
  await page.waitForFunction(() => document.querySelector('[data-slot="bot-composer-model-trigger"]')?.textContent?.includes("Synthetic attachment"));
  return page;
}
it.each([320, 480, 900])("keeps every composer control aligned and contained at column width %i", async width => {
  const page = await fixture(width);
  try {
    const geometry = await page.locator('[data-slot="prompt-input-toolbar"]').evaluate(row => {
      const bounds = row.getBoundingClientRect();
      return { width: bounds.width, overflow: row.scrollWidth > row.clientWidth + 1,
        buttons: [...row.querySelectorAll("button")].map(button => { const b = button.getBoundingClientRect(); return { label: button.getAttribute("aria-label"), x: b.x, right: b.right, y: b.y, height: b.height }; }), x: bounds.x, right: bounds.right };
    });
    await page.screenshot({ path: join(output, `composer-${width}.png`) });
    await writeFile(join(output, `composer-${width}.json`), JSON.stringify(geometry, null, 2));
    expect(geometry.overflow).toBe(false);
    expect(Math.max(...geometry.buttons.map(button => button.y)) - Math.min(...geometry.buttons.map(button => button.y))).toBeLessThanOrEqual(1);
    for (const button of geometry.buttons) { expect(button.x).toBeGreaterThanOrEqual(geometry.x); expect(button.right).toBeLessThanOrEqual(geometry.right + 1); }
    const model = page.getByRole("button", { name: "Choose bot agent and model" });
    expect(await model.getAttribute("title")).toContain("ChatGPT subscription");
    expect(await model.getAttribute("title")).toContain("Synthetic attachment verification");
    expect(await page.getByRole("textbox").inputValue()).toBe("Unsaved fixture draft");
    await page.locator("#fixture-column").evaluate((element, nextWidth) => { (element as HTMLElement).style.width = `${nextWidth}px`; }, width === 320 ? 900 : 320);
    expect(await page.getByRole("textbox").inputValue()).toBe("Unsaved fixture draft");
    const resized = await model.boundingBox(); expect(resized!.width).toBeGreaterThan(0);
    for (const [label, action] of [["Attach files", "attach"], ["Choose folder", "folder"], ["Microphone", "microphone"], ["Stop", "stop"]]) { await page.getByRole("button", { name: label, exact: true }).click(); expect(await page.locator("#fixture-action").textContent()).toBe(action); }
  } finally { await page.close(); }
});
it.each([320, 480, 900])("keeps the shared Web Desktop/Web Canvas composer responsive at width %i", async width => {
  const page = await fixture(width, "web");
  try {
    await page.getByRole("button", { name: "Start voice input", exact: true }).waitFor();
    const model = page.getByRole("button", { name: "Choose bot agent and model" });
    const compact = await model.evaluate(button => ({ width: button.getBoundingClientRect().width,
      labelVisible: getComputedStyle(button.querySelector('[data-slot="bot-composer-model-label"]')!).display !== "none" }));
    expect(compact.labelVisible).toBe(width > 672);
    if (width <= 672) expect(compact.width).toBeLessThanOrEqual(32);
    const buttons = await page.locator("#composer button").evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().toJSON()));
    const bounds = (await page.locator("#composer").boundingBox())!;
    for (const button of buttons) { expect(button.x).toBeGreaterThanOrEqual(bounds.x); expect(button.right).toBeLessThanOrEqual(bounds.x + bounds.width + 1); }
    expect(await page.getByRole("textbox", { name: "Message chat" }).inputValue()).toBe("Unsaved fixture draft");
    await page.screenshot({ path: join(output, `web-composer-${width}.png`) });
    await page.getByRole("button", { name: "Toggle Web bot", exact: true }).click();
    expect(await model.count()).toBe(0);
    expect(await page.getByRole("textbox", { name: "Message chat" }).inputValue()).toBe("Unsaved fixture draft");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    expect(await page.locator("#fixture-action").textContent()).toBe("stop");
  } finally { await page.close(); }
});
it("uses plain process rows with preserved spinner, full model name and expand/collapse", async () => {
  const page = await fixture(320);
  try {
    const phase = page.getByRole("button", { name: /^Working: Current model:/ });
    const style = await phase.evaluate(element => { const style = getComputedStyle(element); return { background: style.backgroundColor, border: style.borderTopWidth, height: element.getBoundingClientRect().height, spinner: !!element.querySelector('.animate-spin'), title: element.querySelector('[title]')?.getAttribute('title') }; });
    await page.screenshot({ path: join(output, "working.png") });
    expect(style.background).toBe("rgba(0, 0, 0, 0)"); expect(style.border).toBe("0px"); expect(style.spinner).toBe(true); expect(style.title).toContain("long subscription model");
    await page.getByRole("button", { name: "1 previous activity" }).click();
    const read = page.getByRole("button", { name: "Reading a file", exact: true });
    expect((await read.boundingBox())!.height).toBe(style.height);
    await read.click(); expect(await page.getByText("Synthetic file result").isVisible()).toBe(true);
    await read.click(); expect(await page.getByText("Synthetic file result").count()).toBe(0);
    await page.screenshot({ path: join(output, "working-expanded.png") });
  } finally { await page.close(); }
});
it("keeps completed reply spacing compact while preserving paragraphs and code blocks", async () => {
  const page = await fixture(480);
  try {
    await page.getByRole("button", { name: "Complete fixture" }).click();
    await page.getByText("First final paragraph.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Wrap code block", exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector("pre")?.textContent?.includes("fixture code line two"));
    const geometry = await page.locator('[data-agent-message-body="turn_fixture"]').evaluate(body => {
      const receipt = body.querySelector('[data-variant="border"]')!.getBoundingClientRect();
      const paragraphs = [...body.querySelectorAll('p')].map(p => p.getBoundingClientRect());
      return { finalGap: paragraphs[0]!.top - receipt.bottom, paragraphGap: paragraphs[1]!.top - paragraphs[0]!.bottom, code: body.querySelector('[data-slot="code-block"]')?.textContent ?? [...body.querySelectorAll('code')].map(code => code.textContent).join('\n') };
    });
    await page.screenshot({ path: join(output, "completed.png") });
    await writeFile(join(output, "completed.json"), JSON.stringify(geometry, null, 2));
    expect(geometry.finalGap).toBeGreaterThanOrEqual(12); expect(geometry.finalGap).toBeLessThanOrEqual(24);
    expect(geometry.paragraphGap).toBeGreaterThanOrEqual(8); expect(geometry.code).toContain("fixture code line two");
    const worked = page.getByRole("button", { name: /Worked for/ }); await worked.click();
    await page.getByRole("button", { name: "1 previous activity" }).click();
    expect(await page.getByRole("button", { name: "Reading a file", exact: true }).isVisible()).toBe(true);
    await worked.click(); expect(await page.getByRole("button", { name: "Reading a file", exact: true }).count()).toBe(0);
    expect(await page.getByText("Second final paragraph.", { exact: true }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "Send", exact: true }).click(); expect(await page.locator("#fixture-action").textContent()).toBe("send");
    await page.getByRole("button", { name: "Wrap code block", exact: true }).click();
    expect(await page.getByRole("button", { name: "Disable code wrapping", exact: true }).getAttribute("aria-pressed")).toBe("true");
  } finally { await page.close(); }
});
