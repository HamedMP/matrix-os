import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalTerminalHost } from "@desktop/main/local-terminals/host";
import { LOCAL_TERMINAL_VERSION } from "@desktop/shared/local-terminals";
import { fakeCore } from "./fixtures/fake-herdr-core";

const primary = { address: "t1", title: "Build", state: "live", created_ms: 170_000, pid: 123 };
const other = { address: "t2", title: "Other", state: "live", created_ms: 171_000, pid: 124 };
const output = { how: "screen", text: "real output", complete: true };

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));

function start(options: { listing?: unknown[]; screen?: unknown } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mx-read-"));
  const runtimeDir = join(directory, "r");
  mkdirSync(runtimeDir, { mode: 0o700 });
  const core = fakeCore();
  const openSocket = vi.fn(() => core.socket);
  const host = createLocalTerminalHost({
    binaryPath: process.execPath, expectedVersion: LOCAL_TERMINAL_VERSION, runtimeDir, dataDir: join(directory, "d"),
    home: directory, shell: "/bin/sh", env: {}, uid: userInfo().uid,
    startCore: vi.fn(async () => { throw new Error("test core already running"); }), openSocket,
  }, { output: vi.fn(), closed: vi.fn() });
  cleanups.push(() => { host.dispose(); rmSync(directory, { recursive: true, force: true }); });

  let current: unknown = primary;
  let onRead: (() => void) | undefined;
  core.onCall(call => {
    if (call.method === "terminal.list") core.reply(call.id, { result: { terminals: options.listing ?? [primary, other] } });
    if (call.method === "terminal.get") core.reply(call.id, { result: current });
    if (call.method === "terminal.read") {
      core.reply(call.id, { result: options.screen ?? output });
      onRead?.();
    }
  });
  return { host, core, openSocket, change: (value: unknown) => { current = value; },
    duringRead: (callback: () => void) => { onRead = callback; } };
}

describe("existing Mac terminal read", () => {
  it("selects only valid live local IDs and shows safe titles in a bounded picker", async () => {
    const { host } = start({ listing: [
      { ...primary, title: "\u202Ewrong", labels: { "matrix.title": "Review\u0007" } },
      { ...other, address: "cloud/t2" },
      { ...other, address: "t3", state: "finished" },
      { ...other, address: "t4", pid: null },
      ...Array.from({ length: 32 }, (_, i) => ({ ...other, address: `t${i + 5}`, pid: i + 1 })),
    ] });
    const reader = await host.openExistingTerminalReader();
    expect(reader.terminals).toHaveLength(20);
    expect(reader.terminals[0]).toEqual({ id: "t1", title: "Review" });
    expect(reader.terminals[1]?.id).toBe("t5");
    expect(reader.terminals.at(-1)?.id).toBe("t23");
  });

  it("reads a terminal's visible screen once with no scrollback or input", async () => {
    const { host, core } = start({ screen: {
      ...output,
      text: " Before\r\n\x1b[31mBuild\x1b[0m\u0012 PASS\u202e\u009f\n\tDone ",
    } });
    const signal = new AbortController().signal;
    const reader = await host.openExistingTerminalReader();
    await expect(reader.read("t1", signal)).resolves.toBe("Before\nBuild PASS\n\tDone");
    expect(core.sent.calls.map(({ method, params }) => [method, params])).toEqual([
      ["terminal.list", {}],
      ["terminal.get", { terminal: "t1" }],
      ["terminal.read", { terminal: "t1", lines: 0 }],
      ["terminal.get", { terminal: "t1" }],
    ]);
    expect(core.sent.frames).toEqual([]);
  });

  it("preserves complete Unicode code points at the screen size limit", async () => {
    const text = "older".repeat(3) + "😀".repeat(2_000);
    const { host } = start({ screen: { ...output, text } });
    const reader = await host.openExistingTerminalReader();
    await expect(reader.read("t1", new AbortController().signal)).resolves.toBe("😀".repeat(2_000));
  });

  it.each([
    { ...output, how: "stitched" },
    { ...output, complete: false },
    { ...output, text: " \u202e\x1b[0m " },
  ])("rejects a screen reply that is incomplete or unavailable", async screen => {
    const { host } = start({ screen });
    const reader = await host.openExistingTerminalReader();
    await expect(reader.read("t1", new AbortController().signal)).rejects.toThrow();
  });

  it.each([
    { ...primary, state: "finished" },
    { ...primary, created_ms: 180_000 },
    { ...primary, pid: 456 },
    { ...primary, address: "t2" },
  ])("rejects an ended, replaced, or wrong terminal before reading", async replacement => {
    const { host, core, change } = start();
    const reader = await host.openExistingTerminalReader();
    change(replacement);
    await expect(reader.read("t1", new AbortController().signal)).rejects.toThrow();
    await expect(reader.read("t9", new AbortController().signal)).rejects.toThrow();
    expect(core.sent.calls.find(call => call.method === "terminal.read")).toBeUndefined();
  });

  it("discards output if the terminal is replaced during the read", async () => {
    const { host, change, duringRead } = start();
    const reader = await host.openExistingTerminalReader();
    duringRead(() => change({ ...primary, pid: 456 }));
    await expect(reader.read("t1", new AbortController().signal)).rejects.toThrow();
  });

  it("invalidates the reader when the core disconnects, without reconnecting it", async () => {
    const { host, core, openSocket } = start();
    const reader = await host.openExistingTerminalReader();
    core.socket.emit("close");
    await expect(reader.assertCurrent("t1", new AbortController().signal)).rejects.toThrow();
    await expect(reader.read("t1", new AbortController().signal)).rejects.toThrow();
    expect(openSocket).toHaveBeenCalledTimes(1);
    expect(core.sent.calls.map(call => call.method)).toEqual(["terminal.list"]);
  });

  it("does not read or release output after cancellation", async () => {
    const { host, core, duringRead } = start();
    const reader = await host.openExistingTerminalReader();
    const controller = new AbortController();
    controller.abort();
    await expect(reader.read("t1", controller.signal)).rejects.toThrow();
    expect(core.sent.calls.map(call => call.method)).toEqual(["terminal.list"]);
    const later = new AbortController();
    duringRead(() => later.abort());
    await expect(reader.read("t1", later.signal)).rejects.toThrow();
  });
});
