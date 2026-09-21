import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import type { Terminal } from "@xterm/xterm";
import { TerminalMouseModeState } from "../../packages/terminal-runtime/src/mouse-mode-state.js";
import { createViewerScrollRuntime } from "./fixtures/viewer-scroll-runtime.js";

interface BrowserFixture {
  Terminal: typeof Terminal;
  terminal: Terminal;
  reports: string[];
  forwardTerminalInput(data: string, binary: boolean): Promise<void>;
}

const require = createRequire(import.meta.url);
const xtermScript = require.resolve("@xterm/xterm");
const xtermCss = join(dirname(dirname(xtermScript)), "css/xterm.css");
const evidenceDirectory = resolve("output/playwright/terminal-viewer-scroll");

describe("additional viewer mouse scrolling in real xterm", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
        : { channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || "chrome" }),
    });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  it.each([
    { name: "SGR wheel", modes: "\x1b[?1000;1006h", report: /^\x1b\[<64;\d+;\d+M$/ },
    { name: "default binary wheel", modes: "\x1b[?1002h", report: /^\x1b\[M`..$/ },
    { name: "pixel SGR trackpad", modes: "\x1b[?1003;1016h", report: /^\x1b\[<64;\d+;\d+M$/ },
  ])("forwards $name after late join without erasing the snapshot", async ({ name, modes, report }) => {
    const runtimeFixture = await createViewerScrollRuntime(modes);
    const tracker = new TerminalMouseModeState();
    // The PTY has already sent these chunks to its first viewer. Only the
    // bounded current mouse state is available to bootstrap a later viewer.
    for (const byte of new TextEncoder().encode("\x1b[?1049h" + modes)) tracker.observe(Uint8Array.of(byte));
    const frames: string[] = [];
    const viewer = await runtimeFixture.runtime.attach(runtimeFixture.ref, {
      viewerId: "additional",
      send: (data) => { frames.push(new TextDecoder().decode(data)); },
    });
    const bootstrap = frames.join("");
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    try {
      await page.exposeFunction("forwardTerminalInput", (data: string, binary: boolean) => (
        viewer.write(binary ? Uint8Array.from(data, (char) => char.charCodeAt(0)) : data)
      ));
      await page.setContent(`<!doctype html><html><body>
        <h1>Shared terminal transport · additional viewer</h1>
        <p>A restored screen remains visible while wheel input reaches the terminal.</p>
        <div id="terminal"></div><p id="result">Waiting for wheel input</p>
        <style>body{margin:32px;background:#17191c;color:#e6e8ec;font:16px system-ui}
        h1{font-size:22px}p{color:#abb2be}#terminal{padding:16px;background:#101114;border-radius:8px}
        #result{font-family:monospace;color:#9ed4aa}</style>
        </body></html>`);
      await page.addStyleTag({ content: await readFile(xtermCss, "utf8") });
      await page.addScriptTag({ content: await readFile(xtermScript, "utf8") });
      await page.evaluate(async (initialization) => {
        const fixture = window as unknown as BrowserFixture;
        const terminal = new fixture.Terminal({ cols: 90, rows: 16, fontSize: 14, allowProposedApi: true });
        fixture.terminal = terminal;
        fixture.reports = [];
        terminal.open(document.getElementById("terminal")!);
        terminal.onData((data) => {
          fixture.reports.push(data);
          void fixture.forwardTerminalInput(data, false);
        });
        terminal.onBinary((data) => {
          fixture.reports.push(data);
          void fixture.forwardTerminalInput(data, true);
        });
        await new Promise<void>((resolve) => terminal.write("\x1bcRestored prompt\r\nRecent terminal output", resolve));
        await new Promise<void>((resolve) => terminal.write(initialization, resolve));
      }, bootstrap);
      const screen = page.locator(".xterm-screen");
      await screen.hover({ position: { x: 100, y: 80 } });
      // ANY reporting also emits movement; isolate the wheel gesture below.
      await page.evaluate(() => { (window as unknown as BrowserFixture).reports = []; });
      runtimeFixture.writes.length = 0;
      if (name.includes("trackpad")) {
        // xterm dampens small pixel deltas; accumulate beyond one cell.
        for (let tick = 0; tick < 24; tick += 1) await page.mouse.wheel(0, -4);
      } else await page.mouse.wheel(0, -100);
      await expect.poll(() => page.evaluate(() => (window as unknown as BrowserFixture).reports.length)).toBeGreaterThan(0);
      const state = await page.evaluate(() => {
        const fixture = window as unknown as BrowserFixture;
        return {
          reports: fixture.reports,
          topLine: fixture.terminal.buffer.active.getLine(0)?.translateToString(true),
          mode: fixture.terminal.modes.mouseTrackingMode,
        };
      });
      expect(state.reports.some((entry) => report.test(entry))).toBe(true);
      await expect.poll(() => runtimeFixture.writes.some((data) => report.test(new TextDecoder().decode(data)))).toBe(true);
      expect(state.topLine).toBe("Restored prompt");

      if (name === "SGR wheel") {
        await page.locator("#result").evaluate((node, mode) => {
          node.textContent = `PASS · wheel report sent · restored prompt preserved · mode ${mode}`;
        }, state.mode);
        await mkdir(evidenceDirectory, { recursive: true });
        await page.screenshot({ path: join(evidenceDirectory, "additional-viewer-wheel.png") });
      }
      // Explicit disable must remain disabled for the next reconnect as well.
      tracker.observe(new TextEncoder().encode("\x1b[?1000;1006;1016l"));
      await page.evaluate(async (initialization) => {
        const fixture = window as unknown as BrowserFixture;
        await new Promise<void>((resolve) => fixture.terminal.write(initialization, resolve));
        fixture.reports = [];
      }, new TextDecoder().decode(tracker.bootstrap()!));
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => (window as unknown as BrowserFixture).reports)).toEqual([]);
    } finally {
      await page.close();
      await runtimeFixture.cleanup();
    }
  });
});
