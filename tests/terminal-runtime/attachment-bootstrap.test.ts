import { describe, expect, it, vi } from "vitest";
import { openBufferedAttachment } from "../../packages/terminal-runtime/src/attachment-bootstrap.js";
import { TerminalRuntime, type ZellijRuntimeAdapter } from "../../packages/terminal-runtime/src/runtime.js";
import type { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";

const ref = { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"b".repeat(32)}` };

describe("terminal attachment bootstrap", () => {
  it("delivers the initial redraw before subsequent incremental output", async () => {
    let emit!: (data: Uint8Array) => void;
    const close = vi.fn(async () => {});
    const store = { getRuntimeWorkspace: async () => ({
      id: ref.workspaceId, zellijSessionName: "test", canonicalSize: { cols: 80, rows: 24 },
      tabs: { [ref.tabId]: { zellijPaneId: "terminal_1" } },
    }) } as unknown as TerminalWorkspaceStore;
    const zellij = { openAttachment: async (_name: string, input: { onData: typeof emit }) => {
      emit = input.onData;
      emit(new TextEncoder().encode("initial redraw"));
      return { write: async () => {}, resize: async () => {}, close };
    } } as unknown as ZellijRuntimeAdapter;
    const runtime = new TerminalRuntime({ store, zellij });
    const output: string[] = [];
    try {
      const viewer = await runtime.attach(ref, { viewerId: "test", send: (data) => { output.push(new TextDecoder().decode(data)); } });
      emit(new TextEncoder().encode("incremental update"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(output).toEqual(["initial redraw", "incremental update"]);
      await viewer.detach();
      expect(close).toHaveBeenCalledOnce();
    } finally { await runtime.shutdown(); }
  });
});


describe("bounded attachment bootstrap", () => {
  it.each(["bytes", "chunks"])("closes the attachment when bootstrap exceeds its %s cap", async (limit) => {
    const close = vi.fn(async () => {});
    const deliver = vi.fn();
    await expect(openBufferedAttachment(async (emit) => {
      if (limit === "bytes") emit(new Uint8Array(1024 * 1024 + 1));
      else for (let i = 0; i < 4097; i++) emit(new Uint8Array([65]));
      return { write: async () => {}, resize: async () => {}, close };
    }, deliver)).rejects.toMatchObject({ code: "capacity" });
    expect(close).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("discards pending and late output when opening fails", async () => {
    const deliver = vi.fn();
    let emit!: (data: Uint8Array) => void;
    await expect(openBufferedAttachment(async (onData) => {
      emit = onData;
      emit(new Uint8Array([65]));
      throw new Error("open failed");
    }, deliver)).rejects.toThrow("open failed");
    emit(new Uint8Array([66]));
    expect(deliver).not.toHaveBeenCalled();
  });
});
