import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { Terminal } from "@xterm/xterm";
import type { TerminalRef, TerminalTabServerFrameSchema } from "@matrix-os/contracts";
import type { z } from "zod/v4";
import { TerminalRuntime, type ZellijRuntimeAdapter } from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalRuntimeSocketServer } from "../../packages/terminal-runtime/src/socket-server.js";
import { TerminalRuntimeSocketClient, type TerminalRuntimeSocketStream } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";

type Frame = z.infer<typeof TerminalTabServerFrameSchema>;

interface BrowserFixture {
  Terminal: typeof Terminal;
  terminal: Terminal;
}

const require = createRequire(import.meta.url);
const xtermScript = require.resolve("@xterm/xterm");
const xtermCss = join(dirname(dirname(xtermScript)), "css/xterm.css");
const evidenceDirectory = resolve("output/playwright/terminal-reattach-output");
const VIEWER_TTL_MS = 250;

// Real workspace store, runtime, Unix socket server and socket client drive a
// real xterm renderer. Only Zellij is deterministic, so this proves the viewer
// recovery boundary (ENG-294), not a customer release pair or a live process.
async function createReattachFixture() {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-reattach-browser-"));
  let emit: ((data: Uint8Array) => void) | undefined;
  const createTab = vi.fn(async () => ({ tabId: 1, paneId: "terminal_1" }));
  const closeTab = vi.fn(async () => {});
  const adapter: ZellijRuntimeAdapter = {
    ensureSession: async () => {}, createTab, closeTab,
    subscribeWorkspace: async () => ({ close: async () => {} }),
    openAttachment: async (_session, input) => {
      emit = input.onData;
      return { write: async () => {}, resize: async () => {}, close: async () => {} };
    },
    resizeSession: async () => {},
  };
  const store = new TerminalWorkspaceStore({ homePath });
  const runtime = new TerminalRuntime({ store, zellij: adapter, viewerTtlMs: VIEWER_TTL_MS, sweepIntervalMs: 60_000 });
  const socketPath = join(homePath, "runtime.sock");
  const server = new TerminalRuntimeSocketServer({ socketPath, runtime });
  const streams: TerminalRuntimeSocketStream[] = [];
  const directViewers: Awaited<ReturnType<TerminalRuntime["attach"]>>[] = [];
  const cleanup = async () => {
    const results = await Promise.allSettled(streams.map(async (stream) => stream.close()));
    results.push(...await Promise.allSettled([server.close()]));
    results.push(...await Promise.allSettled(directViewers.map((viewer) => viewer.detach())));
    results.push(...await Promise.allSettled([runtime.shutdown()]));
    results.push(...await Promise.allSettled([rm(homePath, { recursive: true, force: true })]));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "Fixture cleanup failed");
  };
  try {
    const workspace = await runtime.ensureWorkspace();
    const tab = await runtime.createTab(workspace.id, { name: "reattach", cwd: "" });
    const ref: TerminalRef = { workspaceId: workspace.id, tabId: tab.id };
    await server.start();
    return {
      store, ref, createTab, closeTab, cleanup,
      emit(data: string) {
        if (!emit) throw new Error("Fixture has no live attachment");
        emit(Buffer.from(data));
      },
      // The public attach path runs the stale-viewer sweep before admission.
      async keepAlive() {
        directViewers.push(await runtime.attach(ref, { viewerId: "keeper", send() {} }));
      },
      attach(viewerId: string, fromSeq: number) {
        const frames: Frame[] = [];
        const onClose = vi.fn();
        const onError = vi.fn();
        const stream = new TerminalRuntimeSocketClient({ socketPath }).attach({
          ref, viewerId, fromSeq, mode: "soft", size: { cols: 90, rows: 16 },
          onFrame(frame) { frames.push(frame); }, onClose, onError,
        });
        streams.push(stream);
        return { stream, frames, onClose, onError };
      },
    };
  } catch (error: unknown) {
    try { await cleanup(); }
    catch (cleanupError: unknown) { throw new AggregateError([error, cleanupError], "Fixture setup and cleanup failed"); }
    throw error;
  }
}

// Apply server frames the way the shell does: attached applies the canonical
// grid, a snapshot replaces the whole presentation, output frames append.
async function render(page: Page, frames: Frame[], from: number): Promise<number> {
  for (const frame of frames.slice(from)) {
    if (frame.type === "attached") {
      await page.evaluate((size) => {
        (window as unknown as BrowserFixture).terminal.resize(size.cols, size.rows);
      }, frame.canonicalSize);
    } else if (frame.type === "snapshot") {
      await page.evaluate(async (ansi) => {
        const fixture = window as unknown as BrowserFixture;
        fixture.terminal.reset();
        await new Promise<void>((done) => fixture.terminal.write(ansi, done));
      }, frame.ansi);
    } else if (frame.type === "output") {
      await page.evaluate(async (data) => {
        const fixture = window as unknown as BrowserFixture;
        await new Promise<void>((done) => fixture.terminal.write(data, done));
      }, frame.data);
    }
  }
  return frames.length;
}

// Only the visible grid counts as evidence, never scrollback.
const screenLines = (page: Page) => page.evaluate(() => {
  const terminal = (window as unknown as BrowserFixture).terminal;
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = buffer.viewportY; row < buffer.viewportY + terminal.rows; row += 1) {
    const text = (buffer.getLine(row)?.translateToString(true) ?? "").trimEnd();
    if (text) lines.push(text);
  }
  return lines;
});

const lastOutputSeq = (frames: Frame[]) => frames.reduce(
  (seq, frame) => (frame.type === "output" ? Math.max(seq, frame.seq) : seq), -1,
);

describe("terminal output after viewer expiry and reattachment in real xterm", () => {
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

  it("disconnects the expired viewer and keeps rendering live output after the same tab reattaches", async () => {
    const f = await createReattachFixture();
    try {
      const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
      try {
        await page.setContent(`<!doctype html><html><body>
          <h1>Terminal viewer recovery · same tab, same process</h1>
          <div id="terminal"></div><p id="result">Waiting for terminal output</p>
          <style>body{margin:32px;background:#17191c;color:#e6e8ec;font:16px system-ui}
          h1{font-size:22px}p{color:#abb2be}#terminal{padding:16px;background:#101114;border-radius:8px}
          #result{font-family:monospace;color:#9ed4aa}</style>
          </body></html>`);
        await page.addStyleTag({ content: await readFile(xtermCss, "utf8") });
        await page.addScriptTag({ content: await readFile(xtermScript, "utf8") });
        await page.evaluate(() => {
          const fixture = window as unknown as BrowserFixture;
          fixture.terminal = new fixture.Terminal({ cols: 90, rows: 16, fontSize: 14 });
          fixture.terminal.open(document.getElementById("terminal")!);
        });

        // Phase 1: the first viewer attaches and renders live output.
        const first = f.attach("first", 0);
        await vi.waitFor(() => expect(first.frames.some((frame) => frame.type === "replay-end")).toBe(true));
        f.emit("matrix:~$ echo before-expiry\r\nbefore-expiry\r\nmatrix:~$ ");
        await vi.waitFor(() => expect(first.frames.some((frame) => frame.type === "output" && frame.data.includes("before-expiry"))).toBe(true));
        await render(page, first.frames, 0);
        expect(await screenLines(page)).toEqual(["matrix:~$ echo before-expiry", "before-expiry", "matrix:~$"]);
        // The host checkpoints the screen the viewer has already seen: the cursor
        // rests on the prompt row, as a Zellij screen dump records it.
        await f.store.checkpointTab(f.ref, {
          ansi: "matrix:~$ echo before-expiry\r\nbefore-expiry\r\nmatrix:~$ ",
          viewport: ["matrix:~$ echo before-expiry", "before-expiry", "matrix:~$ "], scrollback: [],
        });

        // Phase 2: the viewer goes untouched past its TTL. Eviction must reach
        // the transport instead of leaving a silently unsubscribed socket.
        await new Promise((done) => setTimeout(done, VIEWER_TTL_MS + 150));
        await f.keepAlive();
        await vi.waitFor(() => expect(first.onClose).toHaveBeenCalled());
        f.emit("while-detached\r\n");
        await new Promise((done) => setTimeout(done, 50));
        expect(first.frames.some((frame) => frame.type === "output" && frame.data.includes("while-detached"))).toBe(false);

        // Phase 3: the same tab reattaches from its last cursor and output continues.
        const resumed = f.attach("resumed", lastOutputSeq(first.frames) + 1);
        await vi.waitFor(() => expect(resumed.frames.some((frame) => frame.type === "replay-end")).toBe(true));
        expect(resumed.frames).toContainEqual(expect.objectContaining({ type: "attached", terminalRef: f.ref }));
        expect(resumed.frames.some((frame) => frame.type === "snapshot")).toBe(true);
        f.emit("echo after-reattach\r\nafter-reattach\r\nmatrix:~$ ");
        await vi.waitFor(() => expect(resumed.frames.some((frame) => frame.type === "output" && frame.data.includes("after-reattach"))).toBe(true));
        await render(page, resumed.frames, 0);
        expect(await screenLines(page)).toEqual([
          "matrix:~$ echo before-expiry", "before-expiry",
          "matrix:~$ echo after-reattach", "after-reattach", "matrix:~$",
        ]);
        expect(resumed.onError).not.toHaveBeenCalled();
        expect(resumed.onClose).not.toHaveBeenCalled();
        expect(f.createTab).toHaveBeenCalledTimes(1);
        expect(f.closeTab).not.toHaveBeenCalled();

        await page.locator("#result").evaluate((node) => {
          node.textContent = "PASS · expired viewer disconnected · same tab reattached · live output continues";
        });
        await mkdir(evidenceDirectory, { recursive: true });
        await page.screenshot({ path: join(evidenceDirectory, "reattached-output-continues.png") });
      } finally {
        await page.close();
      }
    } finally {
      await f.cleanup();
    }
  });
});
