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

it("selects and drags real Matrix Files rows into Web Chat and sends their bytes", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.route("https://source-chat-layout.test/**", route => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><style>${css}:root{--text-primary:#222;--text-secondary:#666;--text-tertiary:#777;--bg-surface:#fff;--bg-overlay:#fff;--background:#fff;--bg-sunken:#eee;--border-subtle:#ddd}body{margin:0;font:14px Arial}#root{height:100vh;width:100%}</style><div id="root"></div></html>`,
    }));
    await page.goto("https://source-chat-layout.test/?matrixFiles=true");
    await page.addScriptTag({ content: script });
    await page.getByRole("button", { name: "Matrix Files", exact: true }).click();
    await page.getByRole("button", { name: "Open reports" }).click();
    const target = page.getByRole("button", { name: "Attach selected.txt" });
    await target.waitFor();
    await page.screenshot({ path: join(output, "matrix-attachment-picker.png") });
    await target.click();
    const composer = page.locator('[data-slot="chat-composer"]');
    await composer.getByText("selected.txt", { exact: true }).waitFor();
    await page.locator('[data-web-file-path="dragged.txt"]').dragTo(composer.getByRole("textbox", { name: "Message chat" }));
    await composer.getByText("dragged.txt", { exact: true }).waitFor();
    await page.screenshot({ path: join(output, "matrix-attachments-in-composer.png") });
    await composer.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(async () => JSON.parse(await page.locator("#root").getAttribute("data-last-submit") ?? "{}")).toEqual({
      text: "Attached 2 file(s)",
      files: [["selected.txt", "Original reports/selected.txt"], ["dragged.txt", "Original dragged.txt"]].map(([name, bytes]) => ({
        name, type: "text/plain", data: `data:text/plain;base64,${Buffer.from(bytes).toString("base64")}`,
      })),
    });
  } finally { await page.close(); }
});

// Keep the actual responsive composer and its Send control usable without an
// engine selector in both a new and an existing private Chat.
it.each([480, 720, 1024].flatMap(width => [false, true].map(empty => ({width, empty}))))(
  "submits a scheduling request from a $width px Chat without a scheduler selector (empty=$empty)", async ({width, empty}) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  try {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => route.abort());
    await page.route("https://source-chat-layout.test/**", route => route.fulfill({ contentType: "text/html", body:
      `<!doctype html><html><style>${css}:root{--text-primary:#222;--text-secondary:#666;--text-tertiary:#777;--bg-surface:#fff;--bg-overlay:#fff;--background:#fff;--bg-sunken:#eee;--border-subtle:#ddd}body{margin:0;font:14px Arial}#root{height:100vh;width:100%}</style><div id="root"></div></html>` }));
    await page.goto(`https://source-chat-layout.test/?empty=${empty}`);
    await page.addScriptTag({ content: script });
    const input = page.getByRole("textbox", { name: "Message chat" });
    const request = "Schedule a summary each morning at 9.";
    try { await input.fill(request, {timeout:5000}); }
    catch (error) { throw new Error(`Offline Chat fixture unavailable: ${JSON.stringify(errors)}; ${await page.locator("body").innerText()}`, { cause: error }); }
    expect(await page.getByRole("button", { name: "Persistent task", exact: true }).count()).toBe(0);
    expect(await page.getByRole("combobox", { name: "Routine destination" }).count()).toBe(0);
    const geometry = await page.locator(".prompt-card").evaluate(card => {
      const bounds = card.getBoundingClientRect();
      return { x: bounds.x, right: bounds.right, overflow: card.scrollWidth > card.clientWidth + 1 };
    });
    await page.screenshot({ path: join(output, `conversational-${width}-${empty ? "empty" : "existing"}.png`) });
    expect(geometry.x).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(width + 1);
    expect(geometry.overflow).toBe(false);
    const send = page.getByRole("button", { name: "Send", exact: true });
    expect(await send.isVisible()).toBe(true);
    const sendBounds = await send.boundingBox();
    expect(sendBounds).not.toBeNull();
    expect(sendBounds!.height).toBe(28);
    expect(sendBounds!.x).toBeGreaterThanOrEqual(geometry.x);
    expect(sendBounds!.x + sendBounds!.width).toBeLessThanOrEqual(geometry.right + 1);
    await send.click();
    await expect.poll(async () => await page.locator("#root").getAttribute("data-last-submit")).toBe(JSON.stringify({text:request}));
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});


it.each([
  { width: 1440, dark: false },
  { width: 768, dark: false },
  { width: 390, dark: false },
  { width: 1440, dark: true },
  { width: 768, dark: true },
])("keeps the attachment picker readable at $width px (dark=$dark)", async ({ width, dark }) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    const palette = dark
      ? "--text-primary:#f2f2f2;--text-secondary:#b6b6b6;--text-tertiary:#aaa;--bg-overlay:#202020;--bg-surface:#202020;--bg-sunken:#292929;--bg-hover:#353535;--border-subtle:#3a3a3a;--background:#202020;--foreground:#f2f2f2"
      : "--text-primary:#242424;--text-secondary:#686868;--text-tertiary:#737373;--bg-overlay:#fff;--bg-surface:#fff;--bg-sunken:#f6f6f6;--bg-hover:#f0f0f0;--border-subtle:#e8e8e8;--background:#fff;--foreground:#242424";
    await page.route("https://source-chat-layout.test/**", route => route.fulfill({ contentType: "text/html", body:
      `<!doctype html><html><style>${css}:root{${palette}}body{margin:0;font:14px Arial}#root{height:100vh;width:100%}</style><div id="root"></div></html>` }));
    await page.goto("https://source-chat-layout.test/?matrixFiles=true");
    await page.addScriptTag({ content: script });
    await page.getByRole("button", { name: "Matrix Files", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Attach files", exact: true });
    const folder = picker.getByRole("button", { name: "Open reports", exact: true });
    await folder.waitFor();
    const bounds = await picker.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    const search = picker.getByRole("searchbox", { name: "Search Matrix files" });
    const searchBounds = await search.boundingBox();
    expect(searchBounds!.height).toBe(34);
    const footer = picker.getByRole("button", { name: "Upload from device" });
    expect(await footer.isVisible()).toBe(true);
    await page.screenshot({ path: join(output, `picker-${width}-${dark ? "dark" : "light"}.png`) });
    await search.fill("rep");
    await expect.poll(() => picker.getByRole("button", { name: "Attach dragged.txt" }).count()).toBe(0);
    await folder.click();
    const file = picker.getByRole("button", { name: "Attach selected.txt" });
    await file.waitFor();
    expect(await search.inputValue()).toBe("");
    await page.screenshot({ path: join(output, `picker-folder-${width}-${dark ? "dark" : "light"}.png`) });
    await picker.press("Escape");
    await picker.waitFor({ state: "hidden" });
  } finally { await page.close(); }
});

it.each(["empty", "error"])("shows a compact picker %s state", async (state) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.route("https://source-chat-layout.test/**", route => route.fulfill({ contentType: "text/html", body:
      `<!doctype html><html><style>${css}:root{--text-primary:#242424;--text-secondary:#686868;--text-tertiary:#737373;--bg-overlay:#fff;--bg-sunken:#f6f6f6;--bg-hover:#f0f0f0;--border-subtle:#e8e8e8}body{margin:0;font:14px Arial}#root{height:100vh;width:100%}</style><div id="root"></div></html>` }));
    await page.goto(`https://source-chat-layout.test/?matrixFiles=true&pickerState=${state}`);
    await page.addScriptTag({ content: script });
    await page.getByRole("button", { name: "Matrix Files", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Attach files", exact: true });
    if (state === "empty") await picker.getByText("This folder is empty.", { exact: true }).waitFor();
    else await picker.getByRole("alert").waitFor();
    await page.screenshot({ path: join(output, `picker-${state}.png`) });
    await picker.getByRole("button", { name: "Cancel", exact: true }).click();
    await picker.waitFor({ state: "hidden" });
  } finally { await page.close(); }
});
