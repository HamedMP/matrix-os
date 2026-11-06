import { describe, expect, it, vi } from "vitest";
import { ZellijCliRuntimeAdapter, type RuntimeSubscriptionProcess } from "../../packages/terminal-runtime/src/zellij-adapter.js";

const sessionName = "matrix-w-0123456789abcdef0123456789abcdef";

function fixture(closeChild: () => Promise<void> = async () => {}) {
  let emitLine!: (line: string) => void;
  let emitExit!: (code: number | null) => void;
  const run = vi.fn(async () => "prompt");
  const child: RuntimeSubscriptionProcess = { close: vi.fn(closeChild) };
  const spawnSubscription = vi.fn((_args: string[], onLine: (line: string) => void, onExit: (code: number | null) => void) => {
    emitLine = onLine;
    emitExit = onExit;
    return child;
  });
  const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run, spawnSubscription });
  return { adapter, run, child, spawnSubscription,
    line: (value: string) => emitLine(value), exit: (code: number | null) => emitExit(code) };
}

describe("Zellij observer lifecycle", () => {
  it.each([2, 0, null])("marks the observer closed when its child exits with %s", async (code) => {
    const f = fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const observer = await f.adapter.subscribeWorkspace(sessionName, {
        paneIds: ["terminal_6"], onEvent: () => {},
      });
      expect(observer.closed).toBe(false);
      f.exit(code);
      expect(observer.closed).toBe(true);
      await observer.close();
      expect(f.spawnSubscription).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });

  it("closes once, marks closed immediately and drains queued observations before resolving", async () => {
    const childClosed = Promise.withResolvers<void>();
    const dump = Promise.withResolvers<string>();
    const f = fixture(() => childClosed.promise);
    f.run.mockImplementation(() => dump.promise);
    const onEvent = vi.fn();
    const observer = await f.adapter.subscribeWorkspace(sessionName, { paneIds: ["terminal_6"], onEvent });
    f.line(JSON.stringify({ event: "pane_update", pane_id: "terminal_6", viewport: ["prompt"], scrollback: [] }));
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
    let resolved = false;
    const first = observer.close().then(() => { resolved = true; });
    const second = observer.close();
    expect(observer.closed).toBe(true);
    expect(f.child.close).toHaveBeenCalledOnce();
    f.exit(null);
    childClosed.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);
    dump.resolve("prompt");
    await Promise.all([first, second]);
    expect(onEvent).toHaveBeenCalledWith({
      type: "pane-update", paneId: "terminal_6", ansi: "prompt", viewport: ["prompt"], scrollback: [],
    });
    await observer.close();
    expect(f.child.close).toHaveBeenCalledOnce();
    expect(f.spawnSubscription).toHaveBeenCalledOnce();
    f.line(JSON.stringify({ event: "pane_update", pane_id: "terminal_6", viewport: ["late"], scrollback: [] }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.run).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledOnce();
  });
});
