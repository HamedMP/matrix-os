import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { TerminalRuntime, type ZellijRuntimeAdapter } from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";

async function createFixture() {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-viewer-lifecycle-"));
  const close = vi.fn(async () => {});
  let emit = (_data: Uint8Array) => {};
  const openAttachment = vi.fn<ZellijRuntimeAdapter["openAttachment"]>(async (_session, input) => {
    emit = input.onData;
    emit(new TextEncoder().encode("\x1b[?1000;1006h"));
    return { write: async () => {}, resize: async () => {}, close };
  });
  const runtime = new TerminalRuntime({
    store: new TerminalWorkspaceStore({ homePath }),
    zellij: {
      ensureSession: async () => {},
      createTab: async () => ({ tabId: 1, paneId: "terminal_1" }),
      subscribeWorkspace: async () => ({ close: async () => {} }),
      openAttachment,
    },
  });
  try {
    const workspace = await runtime.ensureWorkspace();
    const tab = await runtime.createTab(workspace.id, { name: "shell", cwd: "" });
    return {
      runtime,
      ref: { workspaceId: workspace.id, tabId: tab.id },
      close,
      openAttachment,
      emit: (text: string) => emit(new TextEncoder().encode(text)),
      async cleanup() {
        await runtime.shutdown();
        await rm(homePath, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await runtime.shutdown();
    await rm(homePath, { recursive: true, force: true });
    throw error;
  }
}

describe("viewer mouse initialization lifecycle", () => {
  it("observes modes emitted while opening and only initializes the joining viewer", async () => {
    const fixture = await createFixture();
    try {
      const first = vi.fn();
      await fixture.runtime.attach(fixture.ref, { viewerId: "first", send: first });
      const firstFrames = first.mock.calls.length;
      const second = vi.fn();
      await fixture.runtime.attach(fixture.ref, { viewerId: "second", send: second });
      expect(new TextDecoder().decode(second.mock.calls[0]![0])).toContain("\x1b[?1000h\x1b[?1006h");
      expect(first).toHaveBeenCalledTimes(firstFrames);
      expect(fixture.openAttachment).toHaveBeenCalledOnce();
    } finally { await fixture.cleanup(); }
  });

  it.each(["sync", "async"])("evicts a %s initialization failure without disturbing another viewer", async (kind) => {
    const fixture = await createFixture();
    try {
      const first = vi.fn();
      await fixture.runtime.attach(fixture.ref, { viewerId: "first", send: first });
      const failure = new Error("synthetic send failure");
      const failedSend = vi.fn(() => {
        if (kind === "sync") throw failure;
        return Promise.reject(failure);
      });
      await expect(fixture.runtime.attach(fixture.ref, { viewerId: "second", send: failedSend })).rejects.toBe(failure);
      fixture.emit("still live");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(failedSend).toHaveBeenCalledOnce();
      expect(new TextDecoder().decode(first.mock.calls.at(-1)![0])).toBe("still live");
      expect(fixture.close).not.toHaveBeenCalled();
      const reconnected = vi.fn();
      await fixture.runtime.attach(fixture.ref, { viewerId: "second", send: reconnected });
      expect(reconnected).toHaveBeenCalledOnce();
      expect(fixture.openAttachment).toHaveBeenCalledOnce();
    } finally { await fixture.cleanup(); }
  });

  it("delivers a pending bootstrap before newer live mouse-mode changes", async () => {
    const fixture = await createFixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const delivered: string[] = [];
    const terminal = new Terminal({ allowProposedApi: true });
    try {
      await fixture.runtime.attach(fixture.ref, { viewerId: "first", send: () => {} });
      let started!: () => void;
      const sending = new Promise<void>((resolve) => { started = resolve; });
      let initial = true;
      const joining = fixture.runtime.attach(fixture.ref, {
        viewerId: "second",
        send: async (data) => {
          if (initial) { initial = false; started(); await pending; }
          delivered.push(new TextDecoder().decode(data));
          await new Promise<void>((resolve) => terminal.write(data, resolve));
        },
      });
      await sending;
      fixture.emit("\x1b[?1000l");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const beforeRelease = [...delivered];
      release();
      await joining;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(beforeRelease).toEqual([]);
      expect(delivered).toHaveLength(2);
      expect(delivered[0]).toContain("\x1b[?1000h");
      expect(delivered[1]).toBe("\x1b[?1000l");
      await new Promise<void>((resolve) => terminal.write("", resolve));
      expect(terminal.modes.mouseTrackingMode).toBe("none");
    } finally { release(); terminal.dispose(); await fixture.cleanup(); }
  });

  it("does not evict a replacement viewer when the old sender is disposed", async () => {
    const fixture = await createFixture();
    let pending = false;
    try {
      const old = await fixture.runtime.attach(fixture.ref, {
        viewerId: "same",
        send: () => pending ? new Promise<void>(() => {}) : undefined,
      });
      pending = true;
      fixture.emit("old output");
      const replacementSend = vi.fn();
      const replacement = await fixture.runtime.attach(fixture.ref, { viewerId: "same", send: replacementSend });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await old.detach();
      fixture.emit("new output");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(new TextDecoder().decode(replacementSend.mock.calls.at(-1)![0])).toBe("new output");
      await expect(replacement.write(new Uint8Array([1]))).resolves.toBeUndefined();
      expect(fixture.close).not.toHaveBeenCalled();
    } finally { await fixture.cleanup(); }
  });

  it("closes an attachment when its only viewer rejects initialization", async () => {
    const fixture = await createFixture();
    try {
      await expect(fixture.runtime.attach(fixture.ref, {
        viewerId: "failed",
        send: () => Promise.reject(new Error("synthetic send failure")),
      })).rejects.toThrow("synthetic send failure");
      expect(fixture.close).toHaveBeenCalledOnce();
      await fixture.runtime.attach(fixture.ref, { viewerId: "retry", send: () => {} });
      expect(fixture.openAttachment).toHaveBeenCalledTimes(2);
    } finally { await fixture.cleanup(); }
  });
});
