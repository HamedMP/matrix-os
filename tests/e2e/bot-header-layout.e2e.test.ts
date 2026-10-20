import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
const root = resolve(__dirname, "../..");
const output = process.env.HEADER_LAYOUT_OUTPUT ?? join(root, "output/playwright/bot-header-layout");
const desktopRequire = createRequire(join(root, "desktop/package.json"));
const { chromium } = createRequire(join(root, "packages/mcp-browser/package.json"))("playwright") as typeof import("playwright");
const fixturePath = join(root, "tests/e2e/fixtures/bot-header-layout.tsx");
let browser: Browser, script: string, css: string;
beforeAll(async () => {
  await mkdir(output, { recursive: true });
  const result = await build({ absWorkingDir: root, entryPoints: [fixturePath], bundle: true, write: false, outfile: join(output, "fixture.js"),
    format: "iife", platform: "browser", jsx: "automatic", loader: { ".svg": "dataurl", ".png": "dataurl", ".ttf": "dataurl" }, alias: { "@renderer": join(root, "desktop/src/renderer/src") },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}", "import.meta.env": "{}" }, plugins: [{ name: "offline-data-seams", setup(builder) {
      builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: desktopRequire.resolve(args.path) }));
      builder.onLoad({ filter: /\/(?:WorkInspector|WorkFilesInspector)\.tsx$/ }, args => ({ contents: `export function ${args.path.endsWith("WorkFilesInspector.tsx") ? "WorkFilesInspector" : "WorkInspector"}() { return null; }`, loader: "tsx" }));
      builder.onLoad({ filter: /\/(?:ProjectLanding|ProjectChatsView|ProjectsIndex)\.tsx$/ }, args => ({ contents: args.path.endsWith("ProjectLanding.tsx") ? "export function ProjectLanding() { return null; }" : "export default function UnusedProjectView() { return null; }", loader: "tsx" }));
      builder.onLoad({ filter: /\/(?:TabContent|WorkSurfaceRuntime|ChatTab)\.tsx$/ }, args => {
        const exports = args.path.endsWith("TabContent.tsx") ? "TabPane, TabErrorBoundary" : args.path.endsWith("WorkSurfaceRuntime.tsx") ? "useWorkSurfaceRuntime, WorkSurfaceRuntimeProvider" : "ChatContent as default";
        return { contents: `export { ${exports} } from ${JSON.stringify(fixturePath)};`, loader: "tsx" };
      });
    } }] });
  script = result.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  const tailwind = await compile('@import "tailwindcss"; @import "./desktop/src/renderer/src/design/chat.css";', { base: root, onDependency() {} });
  css = tailwind.build(new Scanner({ sources: [
    { base: join(root, "desktop/src/renderer/src"), pattern: "**/*.{ts,tsx}", negated: false },
    { base: join(root, "packages/ui/src"), pattern: "**/*.{ts,tsx}", negated: false },
    { base: join(root, "tests/e2e/fixtures"), pattern: "bot-header-layout.tsx", negated: false },
  ] }).scan()) + result.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });
async function fixture(width: number, surface = "hosted", leading = false, controls = true): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: leading ? 1280 : 1440, height: 800 } });
  page.setDefaultTimeout(5000);
  await page.route("**/*", route => route.abort());
  const html = `<!doctype html><html data-surface="${surface}" data-width="${width}" data-leading="${leading}" data-controls="${controls}"><style>${css}:root{--bg-surface:#fff;--bg-hover:#eef0ed;--text-primary:#183c2c;--text-secondary:#657061;--text-tertiary:#76806f;--border-subtle:#dce0d9;--border-default:#dce0d9;--accent:#294d38;--radius-lg:16px}body{font:14px Arial;margin:16px}</style><div id="root"></div></html>`;
  // In-memory localhost document supplies secure-context Web Crypto. Every
  // other request remains aborted; there is no localhost server or API.
  await page.route("http://localhost/", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://localhost/");
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addScriptTag({ content: script });
  try { await page.getByRole("textbox", { name: surface === "ordinary" ? "Ordinary draft" : "Bot draft" }).waitFor({ timeout: 5000 }); }
  catch (error) { await page.screenshot({ path: join(output, `mount-${surface}.png`) }); await writeFile(join(output, `mount-${surface}.html`), await page.content()); await page.close(); throw new Error(`Offline production fixture failed: ${JSON.stringify(errors)}`, { cause: error }); }
  const frame = page.locator(surface === "standalone" ? "#header-fixture" : '[data-desktop-surface="header-fixture"]');
  await frame.evaluate((element, width) => { (element as HTMLElement).style.width = `${width}px`; }, width);
  if (surface !== "ordinary") await page.getByRole("button", { name: "Details", exact: true }).waitFor();
  return page;
}
function checkNoIntersections(items: Array<{ x: number; y: number; right: number; bottom: number }>) {
  for (let index = 0; index < items.length; index += 1) {
    for (const other of items.slice(index + 1)) {
      const item = items[index]!;
      const horizontal = Math.min(item.right, other.right) - Math.max(item.x, other.x);
      const vertical = Math.min(item.bottom, other.bottom) - Math.max(item.y, other.y);
      expect(horizontal <= 0.5 || vertical <= 0.5).toBe(true);
    }
  }
}
async function checkHeader(page: Page, name: string) {
  const chrome = page.locator('[data-testid="os-window-chrome-grid"]');
  await chrome.locator('.matrix-bot-identity-bar').waitFor();
  const geometry = await chrome.evaluate(row => {
    const bounds = row.getBoundingClientRect(), identity = row.querySelector('.matrix-bot-identity-bar')!;
    const items = [...row.querySelectorAll('button, .matrix-agent-rabbit, .matrix-recipe-rabbit, .matrix-bot-identity-bar p'),
      ...row.parentElement!.querySelectorAll('[data-os-window-traffic-lights] button')].map(element => {
      const b = element.getBoundingClientRect(); return { label: element.getAttribute('aria-label') ?? element.textContent, x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: b.width };
    });
    return { bounds: bounds.toJSON(), items, identity: identity.getBoundingClientRect().toJSON(), identities: row.querySelectorAll('.matrix-bot-identity-bar').length, overflow: identity.scrollWidth > identity.clientWidth + 1 };
  });
  await page.screenshot({ path: join(output, `${name}.png`) });
  await writeFile(join(output, `${name}.json`), JSON.stringify(geometry, null, 2));
  expect(geometry.identities).toBe(1); expect(geometry.overflow).toBe(false);
  checkNoIntersections(geometry.items);
  expect(await chrome.locator('.matrix-bot-identity-bar p').allTextContents()).toEqual([
    "Matrix Bot with a long saved display name",
    "Your personal Matrix assistant, using the identity and style you save in this computer with a long description.",
  ]);
  expect(await page.locator('[data-desktop-surface="header-fixture"] .matrix-bot-identity-bar').count()).toBe(1);
  expect(await page.getByRole("button", { name: /^Rename Matrix Bot/ }).count()).toBe(0);
  for (const item of geometry.items) { expect(item.x).toBeGreaterThanOrEqual(geometry.bounds.x); expect(item.right).toBeLessThanOrEqual(geometry.bounds.right + 1); expect(item.bottom).toBeLessThanOrEqual(geometry.bounds.bottom + 1); }
  const leading = geometry.items.find(item => item.label === "Toggle Chat sidebar")!, details = geometry.items.find(item => item.label === "Details")!;
  expect(details.x).toBeGreaterThanOrEqual(leading.right);
  const maximize = page.getByRole("button", { name: "Maximize", exact: true });
  if (await maximize.count()) expect(leading.x).toBeGreaterThanOrEqual((await maximize.boundingBox())!.x + (await maximize.boundingBox())!.width);
  expect(await chrome.getByRole("button", { name: /^Rename Matrix Bot/ }).count()).toBe(0);
}
it.each([320, 480, 900])("contains one hosted Bot identity and separate actions in a %ipx floating window inside a wide viewport", async width => {
  const page = await fixture(width);
  try {
    await checkHeader(page, `hosted-${width}-sidebar`);
    await page.getByRole("button", { name: "Toggle Chat sidebar", exact: true }).click({ timeout: 3000 });
    await checkHeader(page, `hosted-${width}`);
    await page.getByRole("button", { name: "Details", exact: true }).click();
    expect(await page.getByRole("button", { name: "Details", exact: true }).getAttribute("aria-expanded")).toBe("true");
    await page.getByRole("complementary", { name: "Bot details" }).waitFor();
    await checkHeader(page, `hosted-${width}-details`);
    await page.getByRole("button", { name: "Close bot details", exact: true }).click();
    expect(await page.getByRole("complementary", { name: "Bot details" }).count()).toBe(0);
    await page.getByRole("button", { name: "Resize fixture" }).click();
    await checkHeader(page, `hosted-${width}-resized`);
    expect(await page.getByRole("textbox", { name: "Bot draft" }).inputValue()).toBe("Retained bot draft");
    await page.getByRole("button", { name: "Close", exact: true }).click(); expect(await page.locator("#fixture-action").textContent()).toBe("close");
  } finally { await page.close(); }
});
it.each([true, false])("keeps a nonempty leading action operable with window controls=%s", async controls => {
  const page = await fixture(320, "hosted", true, controls);
  try {
    await checkHeader(page, `leading-${controls}`);
    const back = page.getByRole("button", { name: "Back to Chat", exact: true });
    expect(await back.count()).toBe(1);
    await back.click(); expect(await page.locator("#fixture-action").textContent()).toBe("back");
    await page.getByRole("button", { name: "Toggle Chat sidebar", exact: true }).click();
    await checkHeader(page, `leading-${controls}-hidden`);
    await back.focus(); await page.keyboard.press("Enter");
    expect(await page.locator("#fixture-action").textContent()).toBe("back");
  } finally { await page.close(); }
});
it.each([320, 480, 900])("keeps standalone Bot identity, back and Details contained at %ipx", async width => {
  const page = await fixture(width, "standalone");
  try {
    const header = page.locator('.matrix-bot-identity-bar');
    expect(await header.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const geometry = await header.evaluate(row => ({
      bounds: row.getBoundingClientRect().toJSON(),
      items: [...row.querySelectorAll('button, .matrix-agent-rabbit, .matrix-recipe-rabbit, p')].map(element => element.getBoundingClientRect().toJSON()),
    }));
    checkNoIntersections(geometry.items);
    for (const item of geometry.items) {
      expect(item.x).toBeGreaterThanOrEqual(geometry.bounds.x);
      expect(item.right).toBeLessThanOrEqual(geometry.bounds.right + 1);
      expect(item.bottom).toBeLessThanOrEqual(geometry.bounds.bottom + 1);
    }
    expect(await header.locator('p').allTextContents()).toEqual([
      "Matrix Bot with a long saved display name",
      "Your personal Matrix assistant, using the identity and style you save in this computer with a long description.",
    ]);
    await writeFile(join(output, `standalone-${width}.json`), JSON.stringify(geometry, null, 2));
    await page.screenshot({ path: join(output, `standalone-${width}.png`) });
    await page.getByRole("button", { name: "Back to Chat" }).click(); expect(await page.locator("#fixture-action").textContent()).toBe("back");
    await page.getByRole("button", { name: "Details", exact: true }).click(); await page.getByRole("button", { name: "Close bot details" }).click();
  } finally { await page.close(); }
});
it("keeps ordinary Chat title/sidebar separate from Bot identity", async () => {
  const page = await fixture(480, "ordinary");
  try {
    expect(await page.locator('.matrix-bot-identity-bar').count()).toBe(0);
    expect(await page.getByRole("button", { name: "Rename Ordinary Chat" }).count()).toBe(1);
    await page.getByRole("button", { name: "Toggle Chat sidebar" }).click();
    expect(await page.getByRole("textbox", { name: "Ordinary draft" }).inputValue()).toBe("Retained ordinary draft");
    await page.screenshot({ path: join(output, "ordinary.png") });
  } finally { await page.close(); }
});
it("keeps the real inline fallback below host chrome until the scoped portal handoff", async () => {
  const page = await fixture(480, "handoff");
  try {
    // The data seam delays only the scoped binding report. Frame/WorkTab safe
    // area and the fallback title remain the unmodified production components.
    const fallback = page.getByRole("button", { name: /^Rename Matrix Bot/ });
    const identity = page.locator('.matrix-bot-identity-bar');
    expect(await fallback.count()).toBe(1); expect(await identity.count()).toBe(1);
    const titleBounds = (await fallback.boundingBox())!, identityBounds = (await identity.boundingBox())!;
    expect(identityBounds.y).toBeGreaterThanOrEqual(titleBounds.y + titleBounds.height);
    await page.screenshot({ path: join(output, "handoff-inline.png") });
    await page.getByRole("button", { name: "Resolve scoped binding" }).click();
    await checkHeader(page, "handoff-bound");
    expect(await fallback.count()).toBe(0);
  } finally { await page.close(); }
});
