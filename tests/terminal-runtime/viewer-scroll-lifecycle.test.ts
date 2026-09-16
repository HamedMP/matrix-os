import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
