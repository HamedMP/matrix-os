import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TerminalTabClientFrameSchema } from "../../packages/contracts/src/index.js";
import { TerminalFrameQueue } from "../../packages/terminal-runtime/src/input-frame-queue.js";
import { createTerminalLiveOwnership } from "../../packages/gateway/src/terminal-live-ownership.js";

const root = resolve(__dirname, "../..");
const { chromium } = createRequire(resolve(root, "shell/package.json"))("@playwright/test");
const { build } = createRequire(resolve(root, "node_modules/vite/package.json"))("esbuild");
const ref = { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"b".repeat(32)}` };
type Input = { type: "input"; terminalRef: typeof ref; data: string };
type Fixture = { frames: Input[]; revoke(tabId: string): void };

describe("ENG-293 real-browser Web Terminal Enter", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    const compiled = await build({ absWorkingDir: root,
      entryPoints: ["tests/e2e/fixtures/terminal-enter.tsx"], bundle: true,
      write: false, outdir: "out", format: "iife", platform: "browser", jsx: "automatic",
      alias: { "@": resolve(root, "shell/src"),
        "@matrix-os/observability/client": resolve(root, "packages/observability/src/client.ts") },
      define: { "process.env": "{}", "process.env.NODE_ENV": '"development"' },
      loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" }, logLevel: "silent" });
    const javascript = compiled.outputFiles.find((file: { path: string }) => file.path.endsWith(".js"))!.text;
    const css = compiled.outputFiles.find((file: { path: string }) => file.path.endsWith(".css"))?.text ?? "";
    server = createServer((request, response) => {
      const path = new URL(request.url!, "http://localhost").pathname;
      if (path === "/fixture.js") { response.setHeader("content-type", "text/javascript"); response.end(javascript); }
      else if (path === "/fixture.css") { response.setHeader("content-type", "text/css"); response.end(css); }
      else if (path === "/api/auth/ws-token") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ token: "synthetic", expiresAt: Date.now() + 300_000 })); }
      else if (path.startsWith("/api/")) { response.setHeader("content-type", "application/json"); response.end('{"preferences":{"keyboard":{"profile":"mac","overrides":{}}}}'); }
      else { response.setHeader("content-type", "text/html"); response.end('<!doctype html><link rel="stylesheet" href="/fixture.css"><style>section>div{height:100%;display:flex;flex-direction:column}[data-terminal-viewport]{flex:1;min-height:0}</style><div id="root"></div><script src="/fixture.js"></script>'); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 60_000);
  beforeEach(async () => {
    browser = await chromium.launch({ headless: true,
      args: process.env.PLAYWRIGHT_CHROMIUM_ARGS?.split(" ").filter(Boolean),
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  }, 60_000);
  afterEach(async () => { await browser?.close(); });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  async function open(observer = false): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    page.on("pageerror", error => console.error("[enter-browser]", error.message));
    page.on("console", message => { if (message.type() === "error") console.error("[enter-console]", message.text()); });
    page.setDefaultTimeout(5_000);
    await page.goto(`${origin}/${observer ? "?observer" : ""}`);
    await page.locator("#pane-0 .xterm-screen").waitFor();
    await page.waitForFunction(() => (window as unknown as { enterFixture: { ready: number } }).enterFixture.ready === 2, undefined, { timeout: 5_000 });
    await settle(page);
    await page.locator("#pane-0 [data-terminal-viewport]").click({ position: { x: 100, y: 70 } });
    expect(await page.locator("#pane-0 textarea").evaluate(node => node === document.activeElement)).toBe(true);
    return page;
  }
  async function inputs(page: Page) {
    return page.evaluate(() => (window as unknown as { enterFixture: Fixture }).enterFixture.frames);
  }
  async function settle(page: Page) {
    // A browser-task barrier permits input events and React lease updates to finish.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  async function modernEnter(page: Page) {
    await page.locator("#pane-0 textarea").evaluate(node => {
      for (const type of ["keydown", "keyup"]) node.dispatchEvent(new KeyboardEvent(type,
        { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    });
    await settle(page);
  }

  it("submits key-only automation Enter with keyCode zero as one ordered CR", async () => {
    const page = await open();
    try {
      await page.keyboard.type("hello");
      await modernEnter(page);
      expect((await inputs(page)).map(frame => frame.data).join("")).toBe("hello\r");
      expect((await inputs(page)).filter(frame => frame.data === "\r")).toHaveLength(1);
      for (const frame of await inputs(page)) expect(TerminalTabClientFrameSchema.safeParse(frame).success).toBe(true);
    } finally { await page.close(); }
  });

  it("submits browser-generated insertLineBreak exactly once", async () => {
    const page = await open();
    try {
      await page.keyboard.type("hello");
      const events = await page.locator("#pane-0 textarea").evaluate(node => {
        const seen: { type: string; trusted: boolean; data: string | null }[] = [];
        const capture = (event: Event) => { const input = event as InputEvent;
          seen.push({ type: input.inputType, trusted: input.isTrusted, data: input.data }); };
        node.addEventListener("input", capture, true);
        // Chromium's editing command generates the event; no isTrusted spoofing.
        document.execCommand("insertLineBreak");
        node.removeEventListener("input", capture, true);
        return seen;
      });
      expect(events).toContainEqual({ type: "insertLineBreak", trusted: true, data: null });
      await settle(page);
      expect((await inputs(page)).map(frame => frame.data).join("")).toBe("hello\r");
    } finally { await page.close(); }
  });

  it("preserves physical Enter and suppresses duplicate line-break delivery", async () => {
    const page = await open();
    try {
      await page.keyboard.type("hello");
      await page.keyboard.press("Enter");
      await page.locator("#pane-0 textarea").evaluate(node => node.dispatchEvent(new InputEvent("input",
        { inputType: "insertLineBreak", data: null, bubbles: true })));
      await settle(page);
      expect((await inputs(page)).map(frame => frame.data).join("")).toBe("hello\r");
      expect((await inputs(page)).filter(frame => frame.data === "\r")).toHaveLength(1);
    } finally { await page.close(); }
  });

  it("emits one CR when a legacy keydown and trusted line-break describe one gesture", async () => {
    const page = await open();
    try {
      await page.locator("#pane-0 textarea").evaluate(node => {
        node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        document.execCommand("insertLineBreak");
        node.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      });
      await settle(page);
      expect((await inputs(page)).map(frame => frame.data)).toEqual(["\r"]);
    } finally { await page.close(); }
  });

  it("does not submit composing Enter or an active terminal shortcut prefix", async () => {
    const page = await open();
    try {
      await page.locator("#pane-0 textarea").evaluate(node => {
        node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true }));
        node.dispatchEvent(new CompositionEvent("compositionend", { data: "", bubbles: true }));
      });
      await page.keyboard.press("Control+g");
      await modernEnter(page);
      expect(await inputs(page)).toEqual([]);
      await page.keyboard.press("Enter");
      expect((await inputs(page)).map(frame => frame.data)).toEqual(["\r"]);
    } finally { await page.close(); }
  });

  it("targets only the focused pane and ignores Enter outside the terminal", async () => {
    const page = await open();
    try {
      await page.keyboard.type("one");
      await page.keyboard.press("Enter");
      await page.locator("#pane-1 [data-terminal-viewport]").click({ position: { x: 100, y: 70 } });
      await page.keyboard.type("two");
      await page.keyboard.press("Enter");
      await page.locator("#outside").focus();
      await page.keyboard.press("Enter");
      const frames = await inputs(page);
      expect(frames.filter(frame => frame.terminalRef.tabId === ref.tabId).map(frame => frame.data).join("")).toBe("one\r");
      expect(frames.filter(frame => frame.terminalRef.tabId !== ref.tabId).map(frame => frame.data).join("")).toBe("two\r");
    } finally { await page.close(); }
  });

  it.each(["observer", "revoked"])("denies keyboard and modern Enter for a %s pane", async mode => {
    const page = await open(mode === "observer");
    try {
      if (mode === "revoked") await page.evaluate(tabId => (window as unknown as { enterFixture: Fixture }).enterFixture.revoke(tabId), ref.tabId);
      await settle(page);
      await page.keyboard.type("denied");
      await page.keyboard.press("Enter");
      await modernEnter(page);
      expect(await inputs(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it("denies untrusted or malformed line-break payloads and arbitrary control sequences", async () => {
    const page = await open();
    try {
      await page.locator("#pane-0 textarea").evaluate(node => {
        for (const data of [null, "\x1b[31m", "\r\r", "Enter"]) node.dispatchEvent(new InputEvent("input",
          { inputType: "insertLineBreak", data, bubbles: true }));
        node.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle(page);
      expect(await inputs(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it("rechecks writer ownership after ordered input waits in the real queue", async () => {
    const page = await open();
    const ownership = createTerminalLiveOwnership();
    const writes: string[] = [];
    let authorizations = 0;
    const key = `owner:${ref.workspaceId}:${ref.tabId}`;
    const queue = new TerminalFrameQueue({ onOverflow: () => { throw new Error("unexpected overflow"); },
      onError: error => { throw error; } });
    try {
      ownership.attach({ key, viewerId: "browser", exclusive: true, onRevoked: () => undefined });
      await page.keyboard.type("hello");
      await page.keyboard.press("Enter");
      const frames = await inputs(page);
      expect(frames.map(frame => frame.data).join("")).toBe("hello\r");
      for (const frame of frames) queue.enqueue(TerminalTabClientFrameSchema.parse(frame));
      ownership.attach({ key, viewerId: "other", exclusive: true, onRevoked: () => undefined });
      queue.resume(async frame => {
        authorizations += 1;
        if (frame.type === "input" && ownership.allowsMutation(key, "browser")) writes.push(frame.data);
      });
      await settle(page);
      expect(authorizations).toBe(1); // paused adjacent inputs coalesce without reordering
      expect(writes).toEqual([]);
      expect(ownership.role(key, "browser")).toBe("observer");
    } finally { queue.close(); ownership.close(); await page.close(); }
  });
});
